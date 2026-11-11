"""Immutable release material and candidate-specific owner publication receipts."""

import base64
import hashlib
import io
import json
import re
import tarfile
import tomllib
from datetime import datetime, timedelta
from typing import Literal
from urllib.parse import quote

import httpx
import yaml
from fastapi import FastAPI
from fastapi.responses import Response
from psycopg.types.json import Jsonb
from pydantic import Field, field_validator, model_validator

from sabre.agent_contracts import ArtifactReference
from sabre.contracts import StrictContract
from sabre.error_boundaries import guarded_call
from sabre.executor import snapshot_digest
from sabre.models import DomainError, Status, new_id, now
from sabre.project_context import source_path
from sabre.publisher import github_repository, validate_commit_message
from sabre.repository import digest
from sabre.security import is_blocking_finding

RELEASE_SCHEMA = """
CREATE TABLE release_candidates(
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),
 request_key text NOT NULL,request_digest text NOT NULL,data jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 0,publication_grant jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(project_id,request_key));
CREATE TABLE release_authorizations(
 candidate_id text NOT NULL REFERENCES release_candidates(id),revision integer NOT NULL,
 data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(candidate_id,revision));
"""
SEMVER = r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$"
ReleaseStatus = Literal["prepared", "authorized", "publishing", "published", "uncertain"]


class ReleasePreparation(StrictContract):
    version: Literal[1]
    work_id: str = Field(min_length=1, max_length=128)
    package_version: str = Field(pattern=SEMVER, max_length=100)
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9:._-]+$")
    required_checks: list[str] = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def distinct_checks(self):
        if len(set(self.required_checks)) != len(self.required_checks) or any(not item.strip() or len(item) > 200 for item in self.required_checks):
            raise ValueError("Name each required CI check once")
        return self

    @field_validator("package_version")
    @classmethod
    def semantic_version(cls, value):
        prerelease = value.partition("-")[2]
        if prerelease and any(not part or (part.isdigit() and len(part) > 1 and part.startswith("0")) for part in prerelease.split(".")):
            raise ValueError("Use a Semantic Version without empty or zero-prefixed prerelease identifiers")
        return value


class ReleaseAuthorization(StrictContract):
    version: Literal[1]
    expected_revision: int = Field(ge=0)
    candidate_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    authorize_publication: Literal[True]
    expires_seconds: int = Field(default=3600, ge=60, le=86400)

    @field_validator("authorize_publication", mode="before")
    @classmethod
    def explicit_authorization(cls, value):
        if type(value) is not bool or value is not True:
            raise ValueError("Explicitly authorize this candidate's publication")
        return value


class ReleasePublication(StrictContract):
    version: Literal[1]
    expected_revision: int = Field(ge=1)
    candidate_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9:._-]+$")


class ReleaseCandidate(StrictContract):
    version: Literal[1] = 1
    id: str
    revision: int = Field(ge=0)
    digest: str
    project_id: str
    work_id: str
    commit: str
    snapshot_digest: str
    package_version: str
    tag: str
    changelog: str
    artifacts: list[ArtifactReference]
    required_checks: list[str]
    status: ReleaseStatus
    blockers: list[str]
    release_url: str | None
    authorization_expires_at: datetime | None


class ReleasePage(StrictContract):
    version: Literal[1] = 1
    items: list[ReleaseCandidate]
    truncated: bool


def source_material(snapshot, guard):
    guard.check_snapshot(snapshot)
    files = {}
    modes = {}
    total = 0
    for item in snapshot["files"]:
        path = source_path(item["path"])
        parts = path.lower().split("/")
        private = {".git", ".sabre", ".ssh", "auth.json", "credentials.json", ".credentials.json", ".netrc", "application_default_credentials.json"}
        session_path = any(parent in {".codex", ".claude"} and child in {"sessions", "projects", "history.jsonl"} for parent, child in zip(parts, parts[1:], strict=False))
        if session_path or any(part in private or part == ".env" or part.startswith(".env.") for part in parts):
            raise DomainError("RELEASE_PRIVATE_MATERIAL", "Remove session or private configuration material before checking a release snapshot", 422)
        raw = base64.b64decode(item["content"], validate=True) if item.get("encoding") == "base64" else item["content"].encode()
        total += len(raw)
        if path in files or total > 64 * 1024 * 1024:
            raise DomainError("RELEASE_SOURCE_LIMIT", "Release source must have unique paths and fit within 64 MiB", 422)
        files[path] = raw
        modes[path] = 0o755 if item.get("executable") else 0o644
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for path, raw in sorted(files.items()):
            info = tarfile.TarInfo(path)
            info.size, info.mode, info.mtime = len(raw), modes[path], 0
            try:
                tar.addfile(info, io.BytesIO(raw))
            except ValueError:
                raise DomainError("RELEASE_SOURCE_LIMIT", "A source path exceeds the native archive format limit", 422) from None
    return files, archive.getvalue()


def dependency_inventory(files, version):
    components = set()
    locks = []
    for path, raw in sorted(files.items()):
        name = path.rsplit("/", 1)[-1]
        if name in {"uv.lock", "package-lock.json", "pnpm-lock.yaml"} and len(raw) > 2 * 1024 * 1024:
            raise DomainError("RELEASE_INVENTORY_LIMIT", "A dependency lock exceeds its 2 MiB inspection limit", 422)
        if name == "uv.lock":
            data = tomllib.loads(raw.decode())
            for item in data.get("package", []):
                if isinstance(item.get("name"), str) and isinstance(item.get("version"), str):
                    components.add((item["name"], item["version"]))
            locks.append(path)
        elif name == "package-lock.json":
            data = json.loads(raw)
            for location, item in data.get("packages", {}).items():
                if location and isinstance(item.get("version"), str):
                    components.add((item.get("name") or location.rsplit("node_modules/", 1)[-1], item["version"]))
            locks.append(path)
        elif name == "pnpm-lock.yaml":
            class LockLoader(yaml.SafeLoader):
                def compose_node(self, parent, index):
                    if self.check_event(yaml.AliasEvent):
                        raise DomainError("RELEASE_INVENTORY_INVALID", "Dependency inventory does not accept YAML aliases", 422)
                    return super().compose_node(parent, index)
            data = yaml.load(raw, Loader=LockLoader)  # noqa: S506 - bounded SafeLoader rejects aliases
            for name in data.get("packages", {}):
                package, _, package_version = name.rpartition("@")
                if package and package_version:
                    components.add((package, package_version.split("(", 1)[0]))
            locks.append(path)
    # Without a recognized lock, declared dependencies cannot become a resolved inventory.
    if not locks and any(path.endswith(("package.json", "pyproject.toml", "requirements.txt", "requirements.lock")) for path in files):
        raise DomainError("RELEASE_INVENTORY_INCOMPLETE", "A supported immutable uv, npm or pnpm lock is required for dependency inventory", 422)
    if any(len(name) > 256 or len(package_version) > 128 or not re.fullmatch(r"(?:@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+", name) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.!+_-]*", package_version) for name, package_version in components):
        raise DomainError("RELEASE_INVENTORY_INVALID", "Dependency identities must be bounded package names and versions without host or author metadata", 422)
    return {"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
        "metadata": {"component": {"type": "application", "name": "verified-project", "version": version},
                     "properties": [{"name": "sabre:lock-sha256:" + path, "value": hashlib.sha256(files[path]).hexdigest()} for path in locks]},
        "components": [{"type": "library", "name": name, "version": package_version} for name, package_version in sorted(components)]}


class ReleaseService:
    def __init__(self, service, github=None):
        self.service, self.repository, self.guard = service, service.repository, service.guard
        self.artifacts = service.factory.artifacts
        self.github = github or service.factory.publisher

    async def _row(self, identifier):
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT * FROM release_candidates WHERE id=%s", (identifier,))).fetchone()
        if row is None:
            raise DomainError("RELEASE_NOT_FOUND", "The release candidate does not exist", 404)
        if digest(row["data"]["material"]) != row["data"]["digest"]:
            raise DomainError("RELEASE_CANDIDATE_CHANGED", "The immutable candidate failed its integrity check", 409)
        return row

    async def _evidence(self, candidate):
        work = await self.repository.work(candidate["work_id"])
        project = await self.repository.project(candidate["project_id"])
        evidence = work.evidence
        if not re.fullmatch(r"[a-f0-9]{40,64}", candidate["commit"]) or not re.fullmatch(r"[a-f0-9]{64}", candidate["snapshot_digest"]):
            raise DomainError("RELEASE_EVIDENCE_MISSING", "Release provenance requires exact commit and snapshot digests", 409)
        if work.status != Status.COMPLETED or work.project_id != candidate["project_id"] or evidence is None or evidence.commit != candidate["commit"] or evidence.snapshot_digest != candidate["snapshot_digest"] or not evidence.source_digest or evidence.source_digest != candidate["source_digest"] or not evidence.pr_url or not evidence.branch:
            raise DomainError("RELEASE_EVIDENCE_MISSING", "The candidate must match a completed, delivered work snapshot", 409)
        if not evidence.gates or any(g.exit_code != 0 or g.snapshot_digest != evidence.snapshot_digest for g in evidence.gates) or digest(project.gate_commands) != evidence.profile_digest or sorted(json.dumps(g.command) for g in evidence.gates) != sorted(json.dumps(command) for command in project.gate_commands):
            raise DomainError("RELEASE_CHECKS_FAILED", "Current registered verification must match the checked snapshot", 409)
        if any(is_blocking_finding(finding) for finding in [*work.findings, *evidence.findings]):
            raise DomainError("RELEASE_SECURITY_BLOCKED", "Blocking security findings prevent publication", 409)
        await self.github.validate_policy(work, project)
        return work, project

    async def _tag(self, material, allow_missing):
        reference = await self.github.request("GET", f"/repos/{material['repository']}/git/ref/tags/{material['tag']}")
        if reference is None and allow_missing:
            return
        if not reference or reference.get("object", {}).get("type") != "commit" or reference["object"].get("sha") != material["commit"]:
            raise DomainError("RELEASE_TAG_CHANGED", "The release tag does not resolve to this exact commit", 409)

    async def _ci(self, material):
        repo = material["repository"]
        protected = await self.github.request("GET", f"/repos/{repo}/branches/{quote(material['default_branch'], safe='')}/protection/required_status_checks")
        app_bindings = []
        if protected is not None:
            registered = set(protected.get("contexts", [])) | {item["context"] for item in protected.get("checks", [])}
            if not registered <= set(material["required_checks"]):
                raise DomainError("RELEASE_CI_POLICY_CHANGED", "The candidate must include every currently protected required CI context", 409)
            app_bindings = [(item["context"], item["app_id"]) for item in protected.get("checks", []) if item.get("app_id") not in {None, -1}]
        response = await self.github.request("GET", f"/repos/{repo}/commits/{material['commit']}/check-runs", params={"filter": "latest", "per_page": 100})
        checks = response.get("check_runs", []) if isinstance(response, dict) else []
        if not isinstance(response, dict) or response.get("total_count") != len(checks) or any(item.get("head_sha") != material["commit"] or item.get("status") != "completed" or item.get("conclusion") != "success" for item in checks):
            raise DomainError("RELEASE_CI_BLOCKED", "All bounded CI results must be terminal successes for this exact commit", 409)
        statuses = await self.github.request("GET", f"/repos/{repo}/commits/{material['commit']}/status", params={"per_page": 100})
        if not statuses or statuses.get("sha") != material["commit"] or statuses.get("total_count", 0) > len(statuses.get("statuses", [])) or (statuses.get("statuses") and (statuses.get("state") != "success" or any(item.get("state") != "success" for item in statuses["statuses"]))):
            raise DomainError("RELEASE_CI_BLOCKED", "Commit status contexts must also be complete and successful for this commit", 409)
        observed = {item.get("name") for item in checks} | {item.get("context") for item in statuses.get("statuses", [])}
        if not observed or not set(material["required_checks"]) <= observed:
            raise DomainError("RELEASE_CI_MISSING", "A named required CI check or commit status is missing for this commit", 409)
        for context, app_id in app_bindings:
            if type(app_id) is not int or app_id < 1 or not any(item.get("name") == context and item.get("app", {}).get("id") == app_id for item in checks):
                raise DomainError("RELEASE_CI_APP_MISMATCH", "A required CI context did not come from its registered GitHub App", 409)
        commit = await self.github.request("GET", f"/repos/{repo}/git/commits/{material['commit']}")
        if not commit or commit.get("sha") != material["commit"]:
            raise DomainError("RELEASE_COMMIT_CHANGED", "GitHub did not confirm the exact candidate commit", 409)
        validate_commit_message(commit.get("message", ""))

    def _verify_artifacts(self, material):
        for artifact in material["artifacts"]:
            raw = self.artifacts.get(artifact["digest"])
            if len(raw) != artifact["size_bytes"]:
                raise DomainError("RELEASE_ARTIFACT_CHANGED", "A candidate artifact changed after preparation", 409)

    async def get(self, identifier):
        row = await self._row(identifier)
        data, material = row["data"], row["data"]["material"]
        blockers = []
        try:
            await self._evidence(material)
            self._verify_artifacts(material)
            await self._ci(material)
        except DomainError as error:
            blockers.append(error.code + ": " + error.message)
        except httpx.HTTPError:
            blockers.append("RELEASE_CI_UNAVAILABLE: GitHub checks could not be inspected")
        receipt = await self.repository.get_effect("release-v1:" + identifier)
        progress = receipt["result"] if receipt and receipt["result"] else {}
        authorization = row["publication_grant"]
        if authorization and datetime.fromisoformat(authorization["expires_at"]) <= now():
            blockers.append("RELEASE_AUTHORIZATION_EXPIRED: Authorize this candidate again before publication")
        status: ReleaseStatus = "published" if receipt and receipt["state"] == "completed" else "uncertain" if progress.get("uncertain") else "publishing" if receipt else "authorized" if authorization else "prepared"
        result = ReleaseCandidate(id=identifier, revision=row["revision"], digest=data["digest"], **{key: material[key] for key in ("project_id", "work_id", "commit", "snapshot_digest", "package_version", "tag", "changelog", "artifacts", "required_checks")},
            status=status, blockers=blockers, release_url=progress.get("release_url"),
            authorization_expires_at=datetime.fromisoformat(authorization["expires_at"]) if authorization else None)
        self.guard.check(result)
        return result

    async def list(self):
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT id FROM release_candidates ORDER BY created_at DESC LIMIT 101")).fetchall()
        return ReleasePage(items=[await self.get(row["id"]) for row in rows[:100]], truncated=len(rows) > 100)

    async def prepare(self, request):
        self.guard.check(request)
        work = await self.repository.work(request.work_id)
        if work.evidence is None:
            raise DomainError("RELEASE_EVIDENCE_MISSING", "Complete a checked delivery before preparing a release", 409)
        material = {"project_id": work.project_id, "work_id": work.id, "commit": work.evidence.commit, "snapshot_digest": work.evidence.snapshot_digest, "source_digest": work.evidence.source_digest}
        _, project = await self._evidence(material)
        signature = digest(request.model_dump(mode="json"))
        async with self.repository.connection() as conn:
            prior = await (await conn.execute("SELECT id,request_digest FROM release_candidates WHERE project_id=%s AND request_key=%s", (project.id, request.idempotency_key))).fetchone()
        if prior:
            if prior["request_digest"] != signature:
                raise DomainError("RELEASE_KEY_REUSED", "This release key identifies different candidate material", 409)
            return await self.get(prior["id"])
        snapshot = json.loads(self.artifacts.get(work.evidence.source_digest))
        if snapshot.get("digest") != work.evidence.snapshot_digest or snapshot_digest(snapshot.get("files", [])) != work.evidence.snapshot_digest:
            raise DomainError("RELEASE_SNAPSHOT_CHANGED", "The retained source does not match the checked snapshot", 409)
        files, archive = source_material(snapshot, self.guard)
        try:
            inventory = dependency_inventory(files, request.package_version)
        except (ValueError, TypeError, KeyError, AttributeError, yaml.YAMLError):
            raise DomainError("RELEASE_INVENTORY_INVALID", "The dependency locks do not contain a valid bounded inventory", 422) from None
        changelog = f"# {request.package_version}\n\n{work.objective}\n\n" + "\n".join("- " + item for item in work.acceptance) + f"\n\nChecked commit: {work.evidence.commit}\nSnapshot: {work.evidence.snapshot_digest}\n"
        blobs = {f"source-{request.package_version}.tar": (archive, "application/x-tar"),
            "dependencies.cdx.json": (json.dumps(inventory, sort_keys=True).encode(), "application/json"),
            "CHANGELOG.md": (changelog.encode(), "text/markdown"),
            "source.json": (json.dumps({"version": 1, "commit": work.evidence.commit, "snapshot_digest": work.evidence.snapshot_digest, "package_version": request.package_version}, sort_keys=True).encode(), "application/json")}
        sums = "".join(hashlib.sha256(raw).hexdigest() + "  " + name + "\n" for name, (raw, _) in sorted(blobs.items()))
        blobs["SHA256SUMS"] = (sums.encode(), "text/plain")
        references = []
        for name, (raw, media_type) in blobs.items():
            self.guard.check(raw.decode("utf-8", errors="replace"))
            references.append(ArtifactReference(version=1, id=name, name=name, media_type=media_type, size_bytes=len(raw), digest=self.artifacts.put(raw)).model_dump(mode="json"))
        material.update(repository=github_repository(project.repository), package_version=request.package_version,
            default_branch=project.default_branch, tag="v" + request.package_version, changelog=changelog, artifacts=references, required_checks=request.required_checks)
        identifier = new_id()
        data = {"digest": digest(material), "material": material}
        self.guard.check(data)
        async with self.repository.connection() as conn:
            row = await (await conn.execute("""INSERT INTO release_candidates(id,project_id,request_key,request_digest,data) VALUES(%s,%s,%s,%s,%s)
                ON CONFLICT(project_id,request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING id,request_digest""", (identifier, project.id, request.idempotency_key, signature, Jsonb(data)))).fetchone()
            if row["request_digest"] != signature:
                raise DomainError("RELEASE_KEY_REUSED", "This release key identifies different candidate material", 409)
        return await self.get(row["id"])

    async def authorize(self, identifier, request):
        self.guard.check(request)
        row = await self._row(identifier)
        if row["data"]["digest"] != request.candidate_digest:
            raise DomainError("RELEASE_CANDIDATE_CHANGED", "Authorize the exact reviewed candidate digest", 409)
        await self._evidence(row["data"]["material"])
        self._verify_artifacts(row["data"]["material"])
        await self._ci(row["data"]["material"])
        async with self.repository.connection() as conn:
            current = await (await conn.execute("SELECT revision FROM release_candidates WHERE id=%s FOR UPDATE", (identifier,))).fetchone()
            if current["revision"] != request.expected_revision:
                raise DomainError("RELEASE_REVISION_CONFLICT", "Refresh the candidate before authorizing publication", 409)
            authorization = {"candidate_digest": request.candidate_digest, "expires_at": (now() + timedelta(seconds=request.expires_seconds)).isoformat(), "revision": current["revision"] + 1}
            await conn.execute("UPDATE release_candidates SET revision=%s,publication_grant=%s WHERE id=%s", (authorization["revision"], Jsonb(authorization), identifier))
            await conn.execute("INSERT INTO release_authorizations(candidate_id,revision,data) VALUES(%s,%s,%s)", (identifier, authorization["revision"], Jsonb(authorization)))
        return await self.get(identifier)

    async def _progress(self, key, progress):
        async with self.repository.connection() as conn:
            await conn.execute("UPDATE effects SET result=%s WHERE operation_key=%s AND state<>'completed'", (Jsonb(progress), key))

    async def _grant(self, identifier, request):
        row = await self._row(identifier)
        authorization = row["publication_grant"]
        if row["revision"] != request.expected_revision or row["data"]["digest"] != request.candidate_digest or not authorization or authorization["candidate_digest"] != request.candidate_digest or datetime.fromisoformat(authorization["expires_at"]) <= now():
            raise DomainError("RELEASE_AUTHORIZATION_REQUIRED", "A current owner authorization must bind this exact candidate and revision", 403)
        return row

    async def _remote(self, material, progress):
        repo = material["repository"]
        if progress.get("remote_id"):
            return await self.github.request("GET", f"/repos/{repo}/releases/{progress['remote_id']}")
        release = await self.github.request("GET", f"/repos/{repo}/releases/tags/{material['tag']}")
        if release is not None:
            return release
        releases = await self.github.request("GET", f"/repos/{repo}/releases", params={"per_page": 100})
        if not isinstance(releases, list) or len(releases) >= 100:
            raise DomainError("RELEASE_REMOTE_INCOMPLETE", "Cannot verify the bounded draft release inventory", 409)
        matching = [item for item in releases if item.get("tag_name") == material["tag"]]
        if len(matching) > 1:
            raise DomainError("RELEASE_REMOTE_CONFLICT", "Multiple remote releases use this candidate tag", 409)
        return matching[0] if matching else None

    def _matching_release(self, release, material, marker, remote_id=None):
        if not release or release.get("tag_name") != material["tag"] or release.get("name") != material["tag"] or release.get("target_commitish") != material["commit"] or release.get("body") != material["changelog"] + marker or type(release.get("id")) is not int or release["id"] < 1 or type(release.get("draft")) is not bool or (remote_id is not None and release["id"] != remote_id):
            raise DomainError("RELEASE_REMOTE_CONFLICT", "The remote release does not match the authorized candidate", 409)

    async def publish(self, identifier, request):
        self.guard.check(request)
        async with self.repository.project_lock((await self._row(identifier))["project_id"], execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Wait for active project work before publishing its release", 409)
            alias = "release-command-v1:" + request.idempotency_key
            alias_data = {"candidate_id": identifier, "candidate_digest": request.candidate_digest}
            previous = await self.repository.begin_command(alias, alias_data)
            if previous and previous["request_hash"] != digest(alias_data):
                raise DomainError("IDEMPOTENCY_CONFLICT", "This publication key belongs to another candidate", 409)
            completed = await self.repository.get_effect("release-v1:" + identifier)
            if completed and completed["state"] == "completed":
                return await self.get(identifier)
            row = await self._grant(identifier, request)
            material = row["data"]["material"]
            await self._evidence(material)
            self._verify_artifacts(material)
            await self._ci(material)
            key = "release-v1:" + identifier
            signature = {"candidate_digest": request.candidate_digest}
            receipt = await self.repository.begin_effect(key, signature)
            if receipt["state"] == "completed":
                return await self.get(identifier)
            progress = receipt["result"] or {}
            repo = material["repository"]
            marker = "\n\nSABRE candidate: " + request.candidate_digest
            try:
                release = await self._remote(material, progress)
                if release is None:
                    if progress.get("create_attempted"):
                        raise DomainError("RELEASE_OUTCOME_UNCERTAIN", "The earlier create response is unknown; inspect GitHub without repeating it", 409)
                    await self._grant(identifier, request)
                    await self._tag(material, allow_missing=True)
                    progress["create_attempted"] = True
                    progress["uncertain"] = True
                    await self._progress(key, progress)
                    release = await self.github.request("POST", f"/repos/{repo}/releases", json={"tag_name": material["tag"], "target_commitish": material["commit"], "name": material["tag"], "body": material["changelog"] + marker, "draft": True})
                elif not progress.get("create_attempted"):
                    raise DomainError("RELEASE_TAG_EXISTS", "This tag already has a release outside this candidate receipt", 409)
                self._matching_release(release, material, marker)
                remote_id = release["id"]
                progress["remote_id"] = remote_id
                progress["uncertain"] = False
                await self._progress(key, progress)
                assets = await self.github.request("GET", f"/repos/{repo}/releases/{remote_id}/assets", params={"per_page": 100})
                if not isinstance(assets, list) or len(assets) >= 100:
                    raise DomainError("RELEASE_ASSETS_INCOMPLETE", "Cannot verify the bounded release asset inventory", 409)
                if {asset.get("name") for asset in assets} - {artifact["name"] for artifact in material["artifacts"]}:
                    raise DomainError("RELEASE_ASSET_CONFLICT", "The remote release contains assets outside the immutable candidate", 409)
                attempts = progress.setdefault("asset_attempts", [])
                for artifact in material["artifacts"]:
                    matching = [asset for asset in assets if asset.get("name") == artifact["name"]]
                    if len(matching) > 1:
                        raise DomainError("RELEASE_ASSET_CONFLICT", "Release asset names are ambiguous", 409)
                    if matching:
                        asset = matching[0]
                    else:
                        if artifact["name"] in attempts:
                            raise DomainError("RELEASE_OUTCOME_UNCERTAIN", "Reconcile the earlier asset upload without repeating it", 409)
                        await self._ci(material)
                        await self._evidence(material)
                        raw = self.artifacts.get(artifact["digest"])
                        await self._grant(identifier, request)
                        attempts.append(artifact["name"])
                        progress["uncertain"] = True
                        await self._progress(key, progress)
                        asset = await self.github.request("POST", f"https://uploads.github.com/repos/{repo}/releases/{remote_id}/assets", params={"name": artifact["name"]}, headers={"Content-Type": artifact["media_type"]}, content=raw)
                    if not asset or asset.get("size") != artifact["size_bytes"] or asset.get("digest") != "sha256:" + artifact["digest"] or asset.get("state") != "uploaded":
                        raise DomainError("RELEASE_ASSET_CONFLICT", "GitHub did not confirm the artifact's exact size and SHA-256", 409)
                    progress["uncertain"] = False
                    await self._progress(key, progress)
                confirmed = await self.github.request("GET", f"/repos/{repo}/releases/{remote_id}/assets", params={"per_page": 100})
                expected = {artifact["name"]: artifact for artifact in material["artifacts"]}
                if not isinstance(confirmed, list) or len(confirmed) != len(expected) or {asset.get("name") for asset in confirmed} != set(expected) or any(asset.get("digest") != "sha256:" + expected[asset["name"]]["digest"] or asset.get("size") != expected[asset["name"]]["size_bytes"] for asset in confirmed):
                    raise DomainError("RELEASE_ASSET_CONFLICT", "The complete remote asset set changed before publication", 409)
                await self._ci(material)
                await self._evidence(material)
                self._verify_artifacts(material)
                release = await self._remote(material, progress)
                self._matching_release(release, material, marker, remote_id)
                await self._tag(material, allow_missing=release["draft"])
                if release.get("draft") is not False:
                    if progress.get("publish_attempted"):
                        raise DomainError("RELEASE_OUTCOME_UNCERTAIN", "The earlier publication outcome requires read-only reconciliation", 409)
                    await self._grant(identifier, request)
                    progress["publish_attempted"] = True
                    progress["uncertain"] = True
                    await self._progress(key, progress)
                    release = await self.github.request("PATCH", f"/repos/{repo}/releases/{remote_id}", json={"draft": False, "make_latest": "false"})
                if not release or release.get("draft") is not False:
                    raise DomainError("RELEASE_OUTCOME_UNCERTAIN", "The publication outcome requires read-only reconciliation", 409)
                self._matching_release(release, material, marker, remote_id)
                await self._tag(material, allow_missing=False)
                progress.update(release_url=f"https://github.com/{repo}/releases/tag/{material['tag']}", uncertain=False)
                await self.repository.finish_effect(key, progress)
                await self.repository.finish_effect(alias, {"candidate_id": identifier})
            except (httpx.HTTPError, DomainError):
                progress["uncertain"] = True
                await self._progress(key, progress)
                raise
        return await self.get(identifier)


def install_release_routes(app: FastAPI, service):
    def manager():
        return ReleaseService(service())

    async def call(operation, *args):
        try:
            return await guarded_call(operation, service().guard, "RELEASE_OPERATION_FAILED", *args)
        except httpx.HTTPError:
            raise DomainError("RELEASE_REMOTE_UNAVAILABLE", "GitHub did not confirm the response; inspect the retained candidate before retrying", 503) from None

    @app.get("/api/v1/releases", response_model=ReleasePage)
    async def releases():
        return await call(manager().list)

    @app.post("/api/v1/releases", response_model=ReleaseCandidate, status_code=201)
    async def prepare(body: ReleasePreparation):
        return await call(manager().prepare, body)

    @app.get("/api/v1/releases/{candidate_id}", response_model=ReleaseCandidate)
    async def candidate(candidate_id: str):
        return await call(manager().get, candidate_id)

    @app.get("/api/v1/releases/{candidate_id}/artifacts/{artifact_digest}")
    async def artifact(candidate_id: str, artifact_digest: str):
        release = manager()
        row = await release._row(candidate_id)
        reference = next((item for item in row["data"]["material"]["artifacts"] if item["digest"] == artifact_digest), None)
        if reference is None:
            raise DomainError("RELEASE_ARTIFACT_NOT_FOUND", "This artifact does not belong to the selected candidate", 404)
        return Response(release.artifacts.get(artifact_digest), media_type=reference["media_type"],
            headers={"Content-Disposition": f'attachment; filename="{reference["name"]}"', "X-Content-Type-Options": "nosniff"})

    @app.post("/api/v1/releases/{candidate_id}/authorize", response_model=ReleaseCandidate)
    async def authorize(candidate_id: str, body: ReleaseAuthorization):
        return await call(manager().authorize, candidate_id, body)

    @app.post("/api/v1/releases/{candidate_id}/publish", response_model=ReleaseCandidate)
    async def publish(candidate_id: str, body: ReleasePublication):
        return await call(manager().publish, candidate_id, body)
