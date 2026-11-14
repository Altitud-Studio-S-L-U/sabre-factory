"""Authenticated Docker broker and its HTTP client.

Only this process receives the daemon socket. Every order gets its own volume;
job containers never receive that socket, broker state or provider credentials.
"""

import asyncio
import base64
import hashlib
import io
import json
import os
import re
import secrets
import tarfile
import threading
import tomllib
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import uuid4

import docker
import httpx
from fastapi import Depends, FastAPI, Header
from fastapi.responses import JSONResponse
from packaging.requirements import InvalidRequirement, Requirement
from packaging.version import InvalidVersion, Version
from pydantic import Field

from sabre.browser_contracts import BrowserJob
from sabre.browser_qa import BrowserRunner
from sabre.logs import log
from sabre.models import Contract, DomainError, Project, SecurityFinding
from sabre.private_credentials import fetch_credentials
from sabre.security import ScannerIncomplete, SecretGuard, finding_locations, parse_findings, scanner_error
from sabre.settings import load_bootstrap, reject_secret_environment
from sabre.telemetry import configure, span, traceparent

CONTAINER_TEMP = "/tmp"  # noqa: S108 - private bounded tmpfs inside each disposable container
# Fixed resource limits of every workspace and gate container; they are not configurable.
SANDBOX_MEMORY = "2g"
SANDBOX_NANO_CPUS = 1_000_000_000
SANDBOX_PIDS = 256
COMMAND_TIMEOUT_DEFAULT_S = 300
COMMAND_TIMEOUT_MAX_S = 1800


class ExecutionResult(Contract):
    exit_code: int
    output: str


class PrepareRequest(Contract):
    work_id: str
    project: Project


class FileWrite(Contract):
    path: str
    content: str = Field(max_length=2_000_000)
    expected_content_digest: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class Command(Contract):
    argv: list[str] = Field(min_length=1, max_length=100)
    timeout_s: int = Field(default=COMMAND_TIMEOUT_DEFAULT_S, ge=1, le=COMMAND_TIMEOUT_MAX_S)


class ScanRequest(Contract):
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    baseline: list[str] = Field(default_factory=list)


def snapshot_digest(files: list[dict]) -> str:
    digest = hashlib.sha256()
    total = 0
    if len(files) > 10000:
        raise DomainError("WORKSPACE_QUOTA_EXCEEDED", "The workspace exceeds the file count limit")
    for entry in sorted(files, key=lambda item: item["path"]):
        path = valid_path(entry["path"])
        data = base64.b64decode(entry["content"], validate=True) if entry.get("encoding") == "base64" else entry["content"].encode()
        total += len(data)
        if len(data) > 5_000_000 or total > 64_000_000:
            raise DomainError("WORKSPACE_QUOTA_EXCEEDED", "The snapshot exceeds the run storage limit")
        digest.update(path.encode() + b"\x00" + (b"1" if entry.get("executable") else b"0") + hashlib.sha256(data).digest())
    return digest.hexdigest()


def valid_work_id(work_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", work_id):
        raise DomainError("INVALID_WORK_ID", "The work identifier is invalid", 422)
    return work_id


def valid_path(path: str) -> str:
    candidate = PurePosixPath(path)
    if not path or "\\" in path or "\x00" in path or candidate.is_absolute() or ":" in path or any(part in {"..", ".git"} for part in candidate.parts):
        raise DomainError("UNSAFE_PATH", "The requested path is outside the workspace", 422)
    if str(candidate) == ".":
        raise DomainError("UNSAFE_PATH", "A file path is required", 422)
    if str(candidate) == ".sabre-workspace-id":
        raise DomainError("RESERVED_PATH", "The path is reserved for runner metadata", 422)
    return str(candidate)


def github_repository(repository: str) -> tuple[str, str]:
    try:
        parsed = urlsplit(repository)
        port = parsed.port
    except ValueError:
        raise DomainError("REPOSITORY_NOT_ALLOWED", "The repository address is invalid", 422) from None
    if parsed.scheme != "https" or parsed.hostname != "github.com" or port not in {None, 443} or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise DomainError("REPOSITORY_NOT_ALLOWED", "Only HTTPS GitHub repositories without URL credentials are supported", 422)
    parts = parsed.path.strip("/").removesuffix(".git").split("/")
    if len(parts) != 2 or any(not re.fullmatch(r"[A-Za-z0-9_.-]+", part) or part in {".", ".."} for part in parts):
        raise DomainError("REPOSITORY_NOT_ALLOWED", "The repository address is invalid", 422)
    return parts[0], parts[1]


def validate_python_manifest(content: str) -> None:
    try:
        data = tomllib.loads(content)
        project = data.get("project", {})
        uv_configuration = data.get("tool", {}).get("uv", {})
        if not project or project.get("dynamic") or set(uv_configuration) - {"package", "default-groups"} or data.get("build-system", {}).get("backend-path"):
            raise ValueError("dynamic metadata or sources")
        requirements = list(project.get("dependencies", [])) + list(data.get("build-system", {}).get("requires", []))
        for dependencies in project.get("optional-dependencies", {}).values():
            requirements.extend(dependencies)
        for dependencies in data.get("dependency-groups", {}).values():
            requirements.extend(dependencies)
        for raw in requirements:
            if not isinstance(raw, str):
                raise ValueError("dynamic dependency group")
            requirement = Requirement(raw)
            specifications = list(requirement.specifier)
            if requirement.url or len(specifications) != 1 or specifications[0].operator != "==" or "*" in specifications[0].version:
                raise ValueError("unpinned dependency")
            Version(specifications[0].version)
    except (tomllib.TOMLDecodeError, InvalidRequirement, InvalidVersion, ValueError, TypeError, AttributeError):
        raise DomainError("DEPENDENCY_MANIFEST_NOT_ALLOWED", "Resolution requires static metadata and exact versions, without local sources, Git or URLs", 422) from None


def validate_node_manifest(content: str) -> dict:
    try:
        data = json.loads(content)
        if not isinstance(data, dict) or data.get("workspaces") or data.get("overrides") or data.get("resolutions") or data.get("pnpm"):
            raise ValueError("unsupported dependency sources")
        if any(key in data.get("scripts", {}) for key in {"preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"}):
            raise ValueError("install lifecycle")
        for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            dependencies = data.get(field, {})
            if not isinstance(dependencies, dict):
                raise ValueError("dependencies")
            for name, version in dependencies.items():
                if not re.fullmatch(r"(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+", name) or not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
                    raise ValueError("unpinned dependency")
        return data
    except (ValueError, TypeError, AttributeError):
        raise DomainError("DEPENDENCY_MANIFEST_NOT_ALLOWED", "Node resolution requires exact versions and static metadata, without local sources, Git, URLs or installation scripts", 422) from None


# Isolated mode prevents imports from the project under inspection. No generated
# code executes in the broker; these helpers run in a disposable container.
FILE_HELPER = r'''
import base64, hashlib, json, os, pathlib, sys
root = pathlib.Path('/workspace')
operation = sys.argv[1]
data = json.loads(sys.argv[2])
excluded = {'.git', 'node_modules', '.venv', '.sabre-deps', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache'}
def path_for(name):
    p = pathlib.PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or '.git' in p.parts or '\\' in name or ':' in name or not p.parts:
        raise ValueError('unsafe_path')
    target = root.joinpath(*p.parts)
    for current in [target, *target.parents]:
        if current == root.parent: break
        if current.is_symlink(): raise ValueError('symlink')
    if not target.resolve().is_relative_to(root): raise ValueError('unsafe_path')
    if target.exists() and not target.is_file(): raise ValueError('unsupported_file')
    return target
def files():
    result=[]
    for current, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in excluded)
        for directory in dirs:
            if pathlib.Path(current, directory).is_symlink(): raise ValueError('symlink')
        for name in sorted(names):
            p = pathlib.Path(current, name)
            if p == root / '.sabre-workspace-id': continue
            if p.is_symlink() or not p.is_file(): raise ValueError('unsupported_file')
            result.append(p)
    return sorted(result)
try:
    if operation == 'identity':
        p=path_for('.sabre-workspace-id'); result=p.read_text() if p.exists() else None
    elif operation == 'set_identity':
        path_for('.sabre-workspace-id').write_text(data['identity']); result=True
    elif operation == 'list':
        result = [p.relative_to(root).as_posix() for p in files()]
    elif operation == 'read':
        p=path_for(data['path'])
        if p.stat().st_size > 2_000_000: raise ValueError('file_too_large')
        result=p.read_text(encoding='utf-8')
    elif operation == 'digest':
        p=path_for(data['path'])
        if p.exists() and p.stat().st_size > 5_000_000: raise ValueError('file_too_large')
        result=hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
    elif operation == 'write':
        p=path_for(data['path']); p.parent.mkdir(parents=True, exist_ok=True)
        path_for(data['path'])
        p.write_text(data['content'], encoding='utf-8'); result=True
    elif operation == 'snapshot':
        entries=[]; total=0; digest=hashlib.sha256()
        selected=files()
        if len(selected) > 10000: raise ValueError('too_many_files')
        for p in selected:
            size=p.stat().st_size; total+=size
            if size > 5_000_000 or total > 64_000_000: raise ValueError('snapshot_too_large')
            raw=p.read_bytes(); name=p.relative_to(root).as_posix()
            executable=bool(p.stat().st_mode & 0o111)
            digest.update(name.encode()+b'\x00'+(b'1' if executable else b'0')+hashlib.sha256(raw).digest())
            try: content=raw.decode('utf-8'); encoding='utf-8'
            except UnicodeDecodeError: content=base64.b64encode(raw).decode('ascii'); encoding='base64'
            entries.append({'path':name,'content':content,'encoding':encoding,'executable':executable})
        result={'digest':digest.hexdigest(),'files':entries}
    else: raise ValueError('unknown_operation')
    encoded=json.dumps({'result':result}, ensure_ascii=False)
    if len(sys.argv) > 3: pathlib.Path(sys.argv[3]).write_text(encoded, encoding='utf-8')
    else: print(encoded)
except Exception as exc:
    encoded=json.dumps({'error':type(exc).__name__})
    if len(sys.argv) > 3: pathlib.Path(sys.argv[3]).write_text(encoded, encoding='utf-8')
    else: print(encoded)
    sys.exit(2)
'''


class DockerBroker:
    def __init__(self, state_root: str | Path | None = None, docker_client=None):
        self.root = Path(state_root or os.environ.get("SABRE_EXECUTOR_STATE", "/workspaces"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.docker = docker_client or docker.from_env()
        self.bootstrap = broker_bootstrap()
        self.guard = SecretGuard([self.bootstrap.get("executor_token", "")])
        self.locks: dict[str, asyncio.Lock] = {}
        self.slots = asyncio.Semaphore(2)
        self.restored: set[str] = set()
        # The verified snapshot that matches each workspace's bytes. Set only right after
        # the helper captured or installed those bytes; dropped before any mutation, so a
        # failed persist or a broker restart falls back to reading through the helper.
        self.current: dict[str, dict] = {}
        self.security_database_lock = asyncio.Lock()
        self.browser_runner = BrowserRunner(self)

    def lock(self, work_id: str) -> asyncio.Lock:
        return self.locks.setdefault(valid_work_id(work_id), asyncio.Lock())

    def _remember(self, work_id: str, data: dict) -> None:
        self.current[work_id] = {"digest": data["digest"], "files": data["files"],
                                 "index": {entry["path"]: entry for entry in data["files"]}}

    def _forget(self, work_id: str) -> None:
        self.current.pop(work_id, None)

    def _cached_entry(self, work_id: str, path: str) -> dict | None:
        current = self.current.get(work_id)
        return current["index"].get(path) if current else None

    def _cached_text(self, work_id: str, path: str) -> str | None:
        """Text the helper would return for this path, or None to ask the helper.

        Mirrors the helper's read limits: UTF-8 only and at most 2,000,000 bytes.
        """
        entry = self._cached_entry(work_id, path)
        if entry is None or entry["encoding"] != "utf-8" or len(entry["content"].encode()) > 2_000_000:
            return None
        return entry["content"]

    def _metadata_path(self, work_id: str) -> Path:
        return self.root / f"{valid_work_id(work_id)}.json"

    def _snapshot_path(self, work_id: str) -> Path:
        return self.root / f"{valid_work_id(work_id)}.snapshot.json"

    def _atomic_json(self, target: Path, data: dict) -> None:
        temporary = target.with_name(target.name + f".{uuid4()}.tmp")
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(data, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            if os.name == "posix":
                directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _load_snapshot(self, work_id: str) -> dict:
        try:
            data = json.loads(self._snapshot_path(work_id).read_text())
            if snapshot_digest(data["files"]) != data["digest"]:
                raise ValueError("digest")
            return data
        except (OSError, ValueError, KeyError, TypeError):
            raise DomainError("WORKSPACE_SNAPSHOT_CORRUPT", "The durable run snapshot is unavailable or changed") from None

    async def _persist_workspace(self, work_id: str) -> dict:
        try:
            if self._metadata_path(work_id).exists() and await self._helper(work_id, "identity") != work_id:
                raise DomainError("WORKSPACE_METADATA_CHANGED", "The tool modified reserved workspace metadata")
            await self._helper(work_id, "set_identity", {"identity": work_id})
            data = await self._helper(work_id, "snapshot")
            if snapshot_digest(data["files"]) != data["digest"]:
                raise DomainError("WORKSPACE_SNAPSHOT_CORRUPT", "The snapshot does not match the run bytes")
            await asyncio.to_thread(self._atomic_json, self._snapshot_path(work_id), data)
            self._remember(work_id, data)
            return data
        except DomainError:
            raise
        except (OSError, ValueError, KeyError):
            raise DomainError("WORKSPACE_SNAPSHOT_FAILED", "Could not save the tool result; the run is blocked") from None

    async def _ensure_workspace(self, work_id: str) -> dict:
        metadata = self._metadata(work_id)
        volume_name = f"sabre-factory-ws-{work_id}"
        try:
            volume = await asyncio.to_thread(self.docker.volumes.get, volume_name)
        except docker.errors.NotFound:
            volume = None
        if volume:
            labels = volume.attrs.get("Labels") or {}
            options = volume.attrs.get("Options") or {}
            if labels.get("sabre.work_id") != work_id or labels.get("sabre.owner") != "factory" or options.get("type") != "tmpfs":
                raise DomainError("WORKSPACE_OWNERSHIP", "The volume violates the limits for this run")
            if work_id in self.restored and await self._helper(work_id, "identity") == work_id:
                return metadata
        snapshot = self._load_snapshot(work_id)
        self._forget(work_id)
        if volume:
            await asyncio.to_thread(self._remove_workspace_volume, work_id)
        await asyncio.to_thread(self._install_snapshot, work_id, snapshot)
        await self._helper(work_id, "set_identity", {"identity": work_id})
        self.restored.add(work_id)
        self._remember(work_id, snapshot)
        return metadata

    def _metadata(self, work_id: str) -> dict:
        try:
            return json.loads(self._metadata_path(work_id).read_text())
        except FileNotFoundError:
            raise DomainError("WORKSPACE_NOT_FOUND", "The workspace is unavailable", 404) from None

    def _image(self, variable: str) -> str:
        image = os.environ.get(variable, "")
        if not re.fullmatch(r"(?:[^\s]+@)?sha256:[0-9a-f]{64}", image):
            raise DomainError("EXECUTOR_NOT_CONFIGURED", f"A digest-pinned image is missing: {variable}", 503)
        return image

    def _container(self, image: str, work_id: str, command: list[str], *, readonly_workspace=False, extra_volumes=None, entrypoint=None, network=None, environment=None, keeper=False, include_workspace=True, user="10001:10001", temporary_size_mb=256):
        valid_work_id(work_id)
        if temporary_size_mb not in {256, 512}:
            raise DomainError("EXECUTOR_RESOURCE_POLICY", "The requested time limit is not allowed")
        volumes = {f"sabre-factory-ws-{work_id}": {"bind": "/workspace", "mode": "ro" if readonly_workspace else "rw"}} if include_workspace else {}
        volumes.update(extra_volumes or {})
        return self.docker.containers.create(
            image=image, command=command, entrypoint=entrypoint, working_dir="/workspace" if include_workspace else "/",
            user=user, network_disabled=network is None, network=network, read_only=True,
            cap_drop=["ALL"], security_opt=["no-new-privileges:true"],
            mem_limit=SANDBOX_MEMORY, nano_cpus=SANDBOX_NANO_CPUS, pids_limit=SANDBOX_PIDS,
            log_config=docker.types.LogConfig(type="json-file", config={"max-size": "4m", "max-file": "1"}),
            tmpfs={CONTAINER_TEMP: f"rw,noexec,nosuid,size={temporary_size_mb}m,uid=10001,gid=10001"},
            volumes=volumes, labels={"sabre.owner": "factory", "sabre.work_id": work_id, "sabre.kind": "workspace-keeper" if keeper else "command"},
            environment={"HOME": CONTAINER_TEMP, "PYTHONDONTWRITEBYTECODE": "1", "PIP_NO_CACHE_DIR": "1", "LANG": "C.UTF-8", "PATH": "/workspace/.venv/bin:/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": "/workspace/.sabre-deps", **(environment or {})},
            **({"name": f"sabre-factory-keeper-{work_id}", "restart_policy": {"Name": "unless-stopped"}} if keeper else {}),
        )

    def _remove_workspace_volume(self, work_id: str) -> None:
        valid_work_id(work_id)
        commands = self.docker.containers.list(all=True, filters={"label": ["sabre.owner=factory", f"sabre.work_id={work_id}", "sabre.kind=command"]})
        for command in commands:
            labels = command.attrs.get("Config", {}).get("Labels") or {}
            if labels.get("sabre.owner") != "factory" or labels.get("sabre.work_id") != work_id or labels.get("sabre.kind") != "command":
                raise DomainError("WORKSPACE_OWNERSHIP", "The container does not belong to this run")
            try:
                command.remove(force=True)
            except docker.errors.NotFound:
                pass
        try:
            keeper = self.docker.containers.get(f"sabre-factory-keeper-{valid_work_id(work_id)}")
        except docker.errors.NotFound:
            keeper = None
        if keeper:
            labels = keeper.attrs.get("Config", {}).get("Labels") or {}
            if labels.get("sabre.owner") != "factory" or labels.get("sabre.work_id") != work_id or labels.get("sabre.kind") != "workspace-keeper":
                raise DomainError("WORKSPACE_OWNERSHIP", "The memory container does not belong to this run")
            keeper.remove(force=True)
        try:
            volume = self.docker.volumes.get(f"sabre-factory-ws-{work_id}")
        except docker.errors.NotFound:
            return
        labels = volume.attrs.get("Labels") or {}
        if labels.get("sabre.owner") != "factory" or labels.get("sabre.work_id") != work_id:
            raise DomainError("WORKSPACE_OWNERSHIP", "The volume does not belong to this run")
        volume.remove()

    def _run(self, image: str, work_id: str, argv: list[str], timeout_s: int = 300, *, readonly_workspace=False, extra_volumes=None, entrypoint=None, network=None, environment=None, include_workspace=True, user="10001:10001", temporary_size_mb=256, redact_output=True, capture_file=None) -> ExecutionResult:
        if not argv or any(not isinstance(arg, str) or not arg or "\x00" in arg for arg in argv):
            raise DomainError("INVALID_COMMAND", "A valid argv command is required", 422)
        if capture_file is not None and capture_file != "/tmp/sabre-helper-result.json":  # noqa: S108 - private container output
            raise DomainError("EXECUTOR_OUTPUT_POLICY", "Capturing that path is forbidden")
        command = ["/usr/bin/sleep", "infinity"] if capture_file else argv
        container = self._container(image, work_id, command, readonly_workspace=readonly_workspace, extra_volumes=extra_volumes, entrypoint=entrypoint, network=network, environment=environment, include_workspace=include_workspace, user=user, temporary_size_mb=temporary_size_mb)
        try:
            container.start()
            if capture_file:
                # Keep /tmp mounted until archive retrieval. Docker discards tmpfs
                # when the main process stops, so the helper runs as a bounded exec.
                expired = threading.Event()

                def terminate_helper():
                    expired.set()
                    try:
                        container.kill()
                    except docker.errors.APIError:
                        pass

                timer = threading.Timer(timeout_s, terminate_helper)
                timer.daemon = True
                timer.start()
                try:
                    execution = container.exec_run(argv, user=user, workdir="/workspace")
                    if expired.is_set():
                        raise DomainError("EXECUTION_TIMEOUT", "The helper did not finish within the time limit", 504)
                    # Docker's archive API cannot read tmpfs on every runtime.
                    # Exec output bypasses container logs and their rotation.
                    captured = container.exec_run(["/usr/bin/cat", capture_file], user=user, workdir="/")
                    if captured.exit_code or len(captured.output) > 100_000_000:
                        raise DomainError("WORKSPACE_IO_FAILED", "Could not recover the internal helper response")
                    output = captured.output.decode("utf-8")
                except Exception as exc:
                    if expired.is_set():
                        raise DomainError("EXECUTION_TIMEOUT", "The helper did not finish within the time limit", 504) from exc
                    raise
                finally:
                    timer.cancel()
                if expired.is_set():
                    raise DomainError("EXECUTION_TIMEOUT", "The helper did not finish within the time limit", 504)
                status = {"StatusCode": execution.exit_code}
            else:
                try:
                    status = container.wait(timeout=timeout_s)
                except Exception as exc:
                    container.kill()
                    raise DomainError("EXECUTION_TIMEOUT", "Execution did not finish within the limit", 504) from exc
            if capture_file is None:
                output = container.logs(stdout=True, stderr=True, tail=5000).decode("utf-8", errors="replace")
            output = output[:2_000_000] if redact_output else output
            return ExecutionResult(exit_code=int(status["StatusCode"]), output=self.guard.redact(output) if redact_output else output)
        finally:
            container.remove(force=True)

    async def _helper(self, work_id: str, operation: str, data: dict | None = None) -> Any:
        result = await asyncio.to_thread(self._run, self._image("SABRE_HELPER_IMAGE"), work_id,
                                         ["/usr/local/bin/python", "-I", "-S", "-c", FILE_HELPER, operation, json.dumps(data or {}), "/tmp/sabre-helper-result.json"],  # noqa: S108 - private container output
                                         120, readonly_workspace=operation not in {"write", "set_identity"}, redact_output=False,
                                         capture_file="/tmp/sabre-helper-result.json")  # noqa: S108 - private container output
        try:
            parsed = json.loads(result.output)
        except ValueError:
            raise DomainError("WORKSPACE_IO_FAILED", f"The workspace helper did not return a valid result (exit {result.exit_code})") from None
        if result.exit_code or "error" in parsed:
            kind = parsed.get("error", "WorkspaceError")
            if kind not in {"ValueError", "FileNotFoundError", "PermissionError", "UnicodeDecodeError", "IsADirectoryError", "OSError"}:
                kind = "WorkspaceError"
            raise DomainError("WORKSPACE_IO_FAILED", f"The workspace operation failed: {kind} (exit {result.exit_code})", 422)
        return parsed["result"]

    async def _github_archive(self, project: Project) -> tuple[bytes, str]:
        owner, repo = github_repository(project.repository)
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        token = (await fetch_credentials(os.environ.get("SABRE_API_URL", "http://api:8000"), self.bootstrap.get("executor_token", ""), "github-read"))["token"]
        if token:
            self.guard.known_secrets = tuple(dict.fromkeys((*self.guard.known_secrets, token)))
            headers["Authorization"] = f"Bearer {token}"
        async with httpx.AsyncClient(timeout=60) as client:
            branch = quote(project.default_branch, safe="")
            response = await client.get(f"https://api.github.com/repos/{owner}/{repo}/commits/{branch}", headers=headers)
            if response.status_code != 200:
                raise DomainError("REPOSITORY_UNAVAILABLE", "Could not access the repository or branch; check read permission", 422)
            commit = response.json().get("sha", "")
            if not re.fullmatch(r"[0-9a-f]{40}", commit):
                raise DomainError("REPOSITORY_UNAVAILABLE", "GitHub did not return a valid commit", 502)
            response = await client.send(client.build_request("GET", f"https://api.github.com/repos/{owner}/{repo}/tarball/{commit}", headers=headers), stream=True)
            for _ in range(3):
                if response.status_code not in {301, 302, 303, 307, 308}:
                    break
                location = response.headers.get("location", "")
                try:
                    parsed = urlsplit(location)
                    port = parsed.port
                except ValueError:
                    await response.aclose()
                    raise DomainError("REPOSITORY_UNAVAILABLE", "GitHub returned an invalid redirect", 502) from None
                if parsed.scheme != "https" or parsed.hostname not in {"api.github.com", "codeload.github.com"} or parsed.username or port not in {None, 443}:
                    await response.aclose()
                    raise DomainError("REPOSITORY_UNAVAILABLE", "GitHub redirected to an unsupported destination", 502)
                next_headers = headers if parsed.hostname == "api.github.com" else {"Accept": "application/octet-stream"}
                await response.aclose()
                response = await client.send(client.build_request("GET", location, headers=next_headers), stream=True)
            try:
                if response.status_code != 200:
                    raise DomainError("REPOSITORY_UNAVAILABLE", "Could not obtain a repository snapshot", 422)
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > 64_000_000:
                        raise DomainError("REPOSITORY_TOO_LARGE", "The repository exceeds the preparation limit", 422)
                return bytes(content), commit
            finally:
                await response.aclose()

    def _install_archive(self, work_id: str, raw: bytes) -> None:
        sanitized = io.BytesIO()
        total = 0
        try:
            with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as source, tarfile.open(fileobj=sanitized, mode="w") as target:
                root = tarfile.TarInfo(".")
                root.type, root.uid, root.gid, root.mode = tarfile.DIRTYPE, 10001, 10001, 0o755
                target.addfile(root)
                directories = set()
                for member in source:
                    parts = PurePosixPath(member.name).parts
                    if len(parts) <= 1 or member.isdir():
                        continue
                    name = valid_path(PurePosixPath(*parts[1:]).as_posix())
                    if not member.isfile() or member.size > 5_000_000:
                        raise DomainError("UNSUPPORTED_REPOSITORY_FILE", "The repository contains unsupported links or files", 422)
                    total += member.size
                    if total > 64_000_000:
                        raise DomainError("REPOSITORY_TOO_LARGE", "The repository exceeds the preparation limit", 422)
                    stream = source.extractfile(member)
                    if stream is None:
                        raise DomainError("REPOSITORY_UNAVAILABLE", "The repository archive is incomplete", 422)
                    info = tarfile.TarInfo(name)
                    info.size, info.uid, info.gid = member.size, 10001, 10001
                    info.mode = 0o755 if member.mode & 0o111 else 0o644
                    for parent in reversed(PurePosixPath(name).parents):
                        if str(parent) != "." and str(parent) not in directories:
                            directory = tarfile.TarInfo(str(parent))
                            directory.type, directory.uid, directory.gid, directory.mode = tarfile.DIRTYPE, 10001, 10001, 0o755
                            target.addfile(directory)
                            directories.add(str(parent))
                    target.addfile(info, stream)
        except tarfile.TarError:
            raise DomainError("REPOSITORY_UNAVAILABLE", "The repository snapshot is invalid", 422) from None
        volume_name = f"sabre-factory-ws-{work_id}"
        self.docker.volumes.create(name=volume_name, driver_opts={"type": "tmpfs", "device": "tmpfs", "o": "size=512m,uid=10001,gid=10001,mode=0755"}, labels={"sabre.owner": "factory", "sabre.work_id": work_id})
        container = self._container(self._image("SABRE_HELPER_IMAGE"), work_id, ["sleep", "infinity"], keeper=True)
        try:
            container.start()
            if not container.put_archive("/workspace", sanitized.getvalue()):
                raise DomainError("WORKSPACE_PREPARE_FAILED", "Could not prepare the run volume", 502)
        except Exception:
            container.remove(force=True)
            raise

    async def prepare(self, project: Project, work_id: str) -> None:
        async with self.lock(work_id), self.slots:
            path = self._metadata_path(work_id)
            if path.exists():
                previous = await self._ensure_workspace(work_id)
                if previous["project"] != project.model_dump(mode="json"):
                    raise DomainError("WORKSPACE_CONFLICT", "That workspace belongs to another configuration")
                return
            raw, commit = await self._github_archive(project)
            self._forget(work_id)
            await asyncio.to_thread(self._install_archive, work_id, raw)
            try:
                admission = parse_findings("gitleaks", await self._scanner(work_id, "gitleaks"))
                if admission:
                    raise DomainError("SECRET_DETECTED", "Admission detected potential secrets in the repository; content will not be sent to agents. "
                                      f"Found at: {finding_locations(admission)}. Rotate any real credential, change test data shaped like a "
                                      "credential, and submit the work again.", 422)
                data = {"project": project.model_dump(mode="json"), "base_commit": commit}
                await self._persist_workspace(work_id)
                await asyncio.to_thread(self._atomic_json, path, data)
                self.restored.add(work_id)
            except Exception:
                await asyncio.to_thread(self._remove_workspace_volume, work_id)
                raise

    async def list_files(self, work_id: str) -> list[str]:
        async with self.lock(work_id):
            current = self.current.get(work_id)
            if current is not None and self._metadata(work_id):
                return [entry["path"] for entry in current["files"]]
            await self._ensure_workspace(work_id)
            return await self._helper(work_id, "list")

    async def read_file(self, work_id: str, path: str) -> str:
        async with self.lock(work_id):
            name = valid_path(path)
            cached = self._cached_text(work_id, name)
            if cached is not None and self._metadata(work_id):
                self.guard.check(cached)
                return cached
            await self._ensure_workspace(work_id)
            result = await self._helper(work_id, "read", {"path": name})
            self.guard.check(result)
            return result

    async def write_file(self, work_id: str, path: str, content: str, *, expected_content_digest: str | None = None) -> None:
        async with self.lock(work_id):
            await self._ensure_workspace(work_id)
            self.guard.check(content)
            if expected_content_digest is not None:
                if not re.fullmatch(r"[a-f0-9]{64}", expected_content_digest):
                    raise DomainError("INVALID_DIGEST", "The file digest is invalid", 422)
                entry = self._cached_entry(work_id, valid_path(path))
                current = (hashlib.sha256(base64.b64decode(entry["content"]) if entry["encoding"] == "base64" else entry["content"].encode()).hexdigest()
                           if entry is not None else await self._helper(work_id, "digest", {"path": valid_path(path)}))
                if current != expected_content_digest:
                    raise DomainError("SOURCE_CONTEXT_STALE", "The file changed before saving; read it again", 409)
            self._forget(work_id)
            try:
                await self._helper(work_id, "write", {"path": valid_path(path), "content": content})
            finally:
                await self._persist_workspace(work_id)

    async def execute(self, work_id: str, argv: list[str], timeout_s=300) -> ExecutionResult:
        async with self.lock(work_id), self.slots:
            meta = await self._ensure_workspace(work_id)
            self.guard.check(argv)
            variable = "SABRE_PYTHON_IMAGE" if meta["project"]["profile"] == "python" else "SABRE_NODE_IMAGE"
            self._forget(work_id)
            try:
                return await asyncio.to_thread(self._run, self._image(variable), work_id, argv, timeout_s)
            finally:
                await self._persist_workspace(work_id)

    async def _prepare_dependencies(self, work_id: str, meta: dict) -> None:
        files = await self._helper(work_id, "list")
        profile = meta["project"]["profile"]
        command = None
        if profile == "python":
            if "uv.lock" in files and "pyproject.toml" in files:
                command = ["/usr/local/bin/uv", "sync", "--frozen", "--no-install-project", "--no-build"]
            elif "requirements.txt" in files:
                command = ["/usr/local/bin/python", "-I", "-m", "pip", "install", "--require-hashes", "--only-binary=:all:", "--target", "/workspace/.sabre-deps", "-r", "requirements.txt"]
            elif "pyproject.toml" in files or "setup.py" in files or "setup.cfg" in files:
                raise DomainError("DEPENDENCIES_NOT_LOCKED", "The Python project requires uv.lock or requirements.txt with hashes", 422)
        elif "package.json" in files:
            manifest = json.loads(await self._helper(work_id, "read", {"path": "package.json"}))
            has_dependencies = bool(manifest.get("dependencies") or manifest.get("devDependencies") or manifest.get("optionalDependencies"))
            if "package-lock.json" in files:
                command = ["/usr/local/bin/npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]
            elif "pnpm-lock.yaml" in files:
                command = ["/usr/local/bin/pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false"]
            elif has_dependencies:
                raise DomainError("DEPENDENCIES_NOT_LOCKED", "The Node project requires package-lock.json or pnpm-lock.yaml", 422)
        if command is None:
            return
        await self._run_dependency_command(work_id, meta, command)

    async def _run_dependency_command(self, work_id: str, meta: dict, command: list[str]) -> None:
        network = os.environ.get("SABRE_DEPENDENCY_NETWORK", "")
        proxy = os.environ.get("SABRE_DEPENDENCY_PROXY", "")
        parsed = urlsplit(proxy)
        if not network or parsed.scheme != "http" or parsed.hostname != "dependencies-proxy" or parsed.username or parsed.password:
            raise DomainError("DEPENDENCY_NETWORK_NOT_CONFIGURED", "The internal network and dependency preparation proxy are missing", 503)
        network_info = await asyncio.to_thread(self.docker.networks.get, network)
        if not network_info.attrs.get("Internal"):
            raise DomainError("DEPENDENCY_NETWORK_UNSAFE", "Preparation requires an internal Docker network")
        variable = "SABRE_PYTHON_IMAGE" if meta["project"]["profile"] == "python" else "SABRE_NODE_IMAGE"
        result = await asyncio.to_thread(self._run, self._image(variable), work_id, command, 1200, network=network,
                                         environment={"HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "http_proxy": proxy, "https_proxy": proxy,
                                                      "npm_config_proxy": proxy, "npm_config_https_proxy": proxy,
                                                      "PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": "", "PYTHONSAFEPATH": "1",
                                                      "UV_PYTHON": "/usr/local/bin/python", "UV_PYTHON_DOWNLOADS": "never", "UV_NO_CACHE": "1",
                                                      "PIP_CONFIG_FILE": "/dev/null"})
        if result.exit_code:
            raise DomainError("DEPENDENCY_PREPARATION_FAILED", "Locked installation without scripts failed; review the lockfile and dependencies", 422)

    async def resolve_dependencies(self, work_id: str) -> dict:
        async with self.lock(work_id), self.slots:
            meta = await self._ensure_workspace(work_id)
            before = await self._helper(work_id, "snapshot")
            names = {entry["path"] for entry in before["files"]}
            if meta["project"]["profile"] == "python":
                if "pyproject.toml" not in names:
                    raise DomainError("DEPENDENCY_MANIFEST_NOT_ALLOWED", "Python dependency resolution requires static pyproject.toml metadata", 422)
                validate_python_manifest(await self._helper(work_id, "read", {"path": "pyproject.toml"}))
                command = ["/usr/local/bin/uv", "lock", "--no-sources", "--no-build", "--no-config"]
                locks = ["uv.lock"]
            else:
                if "package.json" not in names:
                    raise DomainError("DEPENDENCY_MANIFEST_NOT_ALLOWED", "package.json is required", 422)
                manifest = validate_node_manifest(await self._helper(work_id, "read", {"path": "package.json"}))
                if "pnpm-lock.yaml" in names or str(manifest.get("packageManager", "")).startswith("pnpm@"):
                    command = ["/usr/local/bin/pnpm", "install", "--lockfile-only", "--frozen-lockfile=false", "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false"]
                    locks = ["pnpm-lock.yaml"]
                else:
                    command = ["/usr/local/bin/npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]
                    locks = ["package-lock.json"]
            self._forget(work_id)
            try:
                await self._run_dependency_command(work_id, meta, command)
            finally:
                after = await self._persist_workspace(work_id)
            previous = {entry["path"]: entry for entry in before["files"]}
            current = {entry["path"]: entry for entry in after["files"]}
            if any(lock not in current for lock in locks):
                raise DomainError("DEPENDENCY_RESOLUTION_FAILED", "Resolution did not produce a lockfile", 422)
            changed = [name for name in sorted(set(previous) | set(current)) if previous.get(name) != current.get(name)]
            return {"locks": locks, "changed_files": changed, "snapshot_digest": after["digest"]}

    async def prepare_dependencies(self, work_id: str) -> None:
        async with self.lock(work_id), self.slots:
            metadata = await self._ensure_workspace(work_id)
            self._forget(work_id)
            try:
                await self._prepare_dependencies(work_id, metadata)
            finally:
                await self._persist_workspace(work_id)

    def _install_snapshot(self, work_id: str, snapshot: dict) -> None:
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w:gz") as archive:
            for entry in snapshot["files"]:
                path = valid_path(entry["path"])
                content = base64.b64decode(entry["content"], validate=True) if entry["encoding"] == "base64" else entry["content"].encode()
                info = tarfile.TarInfo("snapshot/" + path)
                info.size = len(content)
                info.mode = 0o755 if entry.get("executable") else 0o644
                archive.addfile(info, io.BytesIO(content))
        self._install_archive(work_id, raw.getvalue())

    async def execute_gate(self, work_id: str, argv: list[str], digest: str, timeout_s=300) -> ExecutionResult:
        async with self.lock(work_id), self.slots:
            meta = await self._ensure_workspace(work_id)
            snapshot = await self._helper(work_id, "snapshot")
            if snapshot["digest"] != digest:
                raise DomainError("STALE_SNAPSHOT", "The workspace changed before verification")
            gate_id = f"gate-{uuid4()}"
            await asyncio.to_thread(self._install_snapshot, gate_id, snapshot)
            try:
                await self._prepare_dependencies(gate_id, meta)
                variable = "SABRE_PYTHON_IMAGE" if meta["project"]["profile"] == "python" else "SABRE_NODE_IMAGE"
                return await asyncio.to_thread(self._run, self._image(variable), gate_id, argv, timeout_s)
            finally:
                await asyncio.to_thread(self._remove_workspace_volume, gate_id)

    async def snapshot(self, work_id: str) -> dict:
        async with self.lock(work_id):
            current = self.current.get(work_id)
            if current is not None:
                return {"digest": current["digest"], "files": [dict(entry) for entry in current["files"]],
                        "base_commit": self._metadata(work_id)["base_commit"]}
            meta = await self._ensure_workspace(work_id)
            result = await self._helper(work_id, "snapshot")
            if snapshot_digest(result["files"]) == result["digest"]:
                self._remember(work_id, result)
            result["base_commit"] = meta["base_commit"]
            return result

    async def scan_snapshot(self, work_id: str, digest: str, baseline: list[str]) -> list[SecurityFinding]:
        async with self.lock(work_id), self.security_database_lock, self.slots:
            await self._ensure_workspace(work_id)
            # Scanners mount the workspace; trust only the helper's view until they finish.
            self._forget(work_id)
            initial = await self._helper(work_id, "snapshot")
            if initial["digest"] != digest:
                raise DomainError("STALE_SNAPSHOT", "The workspace changed after gathering evidence")
            findings = []
            for scanner in ("gitleaks", "trivy", "semgrep"):
                try:
                    result = await self._scanner(work_id, scanner)
                    findings.extend(parse_findings(scanner, result))
                except ScannerIncomplete as incomplete:
                    findings.append(scanner_error(scanner, incomplete))
                except (DomainError, ValueError, docker.errors.DockerException):
                    findings.append(scanner_error(scanner))
            final = await self._helper(work_id, "snapshot")
            if final["digest"] != digest:
                raise DomainError("STALE_SNAPSHOT", "The workspace changed during review")
            if snapshot_digest(final["files"]) == final["digest"]:
                self._remember(work_id, final)
            return [finding.model_copy(update={"baseline": finding.fingerprint in baseline and finding.category not in {"secret", "scanner_error"}}) for finding in findings]

    async def security_version(self, work_id: str) -> str:
        async with self.lock(work_id), self.security_database_lock:
            await self._ensure_workspace(work_id)
            images = {scanner: self._image(f"SABRE_{scanner.upper()}_IMAGE") for scanner in ("gitleaks", "trivy", "semgrep")}
            program = "import hashlib,json,pathlib; p=pathlib.Path('/rules'); h=hashlib.sha256(); [h.update(n.encode()+b'\\x00'+(p/n).read_bytes()) for n in ['gitleaks.toml','rules.yml','trivy.yaml','emptyignore']]; h.update(pathlib.Path('/cache/db/metadata.json').read_bytes()); print(json.dumps({'digest':h.hexdigest()}))"
            volumes = {
                os.environ.get("SABRE_SEMGREP_RULES_VOLUME", "sabre-factory-semgrep-rules"): {"bind": "/rules", "mode": "ro"},
                os.environ.get("SABRE_TRIVY_DB_VOLUME", "sabre-factory-trivy-db"): {"bind": "/cache", "mode": "ro"},
            }
            result = await asyncio.to_thread(self._run, self._image("SABRE_HELPER_IMAGE"), work_id,
                                             ["/usr/local/bin/python", "-I", "-S", "-c", program], 30,
                                             readonly_workspace=True, extra_volumes=volumes)
            if result.exit_code:
                raise DomainError("SECURITY_NOT_CONFIGURED", "Cannot identify rule and vulnerability database versions", 503)
            try:
                digest = json.loads(result.output)["digest"]
            except (ValueError, KeyError):
                raise DomainError("SECURITY_NOT_CONFIGURED", "Could not verify the security version", 503) from None
            return hashlib.sha256(json.dumps({"images": images, "rules_and_database": digest}, sort_keys=True).encode()).hexdigest()

    async def current_digest(self, work_id: str) -> str:
        return (await self.snapshot(work_id))["digest"]

    async def refresh_security_database(self) -> dict:
        async with self.security_database_lock, self.slots:
            network = os.environ.get("SABRE_SECURITY_UPDATE_NETWORK", "")
            proxy = os.environ.get("SABRE_SECURITY_UPDATE_PROXY", "")
            parsed = urlsplit(proxy)
            if not network or parsed.scheme != "http" or parsed.hostname != "security-proxy" or parsed.username or parsed.password:
                raise DomainError("SECURITY_UPDATE_NOT_CONFIGURED", "The internal network and security update proxy are missing", 503)
            network_info = await asyncio.to_thread(self.docker.networks.get, network)
            if not network_info.attrs.get("Internal"):
                raise DomainError("SECURITY_UPDATE_NETWORK_UNSAFE", "The update requires an internal Docker network")
            cache = os.environ.get("SABRE_TRIVY_DB_VOLUME", "sabre-factory-trivy-db")
            if not cache.startswith("sabre-factory-"):
                raise DomainError("SECURITY_DATABASE_OWNERSHIP", "The security volume does not belong to SABRE")
            volume = await asyncio.to_thread(self.docker.volumes.get, cache)
            labels = volume.attrs.get("Labels") or {}
            if labels.get("sabre.owner") != "factory" and labels.get("com.docker.compose.project") != "sabre-factory":
                raise DomainError("SECURITY_DATABASE_OWNERSHIP", "Cannot write to an unidentified volume")
            environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": "", "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy,
                           "http_proxy": proxy, "https_proxy": proxy, "TRIVY_SKIP_VERSION_CHECK": "true"}
            result = await asyncio.to_thread(self._run, self._image("SABRE_TRIVY_IMAGE"), "security-update",
                                             ["image", "--cache-dir", "/cache", "--download-db-only", "--db-repository", "ghcr.io/aquasecurity/trivy-db:2", "--no-progress"],
                                             900, include_workspace=False, user="0:0", network=network,
                                             environment=environment, extra_volumes={cache: {"bind": "/cache", "mode": "rw"}}, temporary_size_mb=512)
            if result.exit_code:
                raise DomainError("SECURITY_DATABASE_UPDATE_FAILED", "Could not update the vulnerability database", 503)
            program = "import datetime,hashlib,json,pathlib; b=pathlib.Path('/cache/db/metadata.json').read_bytes(); d=json.loads(b); t=datetime.datetime.fromisoformat(d['UpdatedAt'].replace('Z','+00:00')); age=(datetime.datetime.now(datetime.UTC)-t).total_seconds(); print(json.dumps({'updated_at':d['UpdatedAt'],'age_seconds':age,'digest':hashlib.sha256(b).hexdigest()}))"
            metadata = await asyncio.to_thread(self._run, self._image("SABRE_HELPER_IMAGE"), "security-update",
                                               ["/usr/local/bin/python", "-I", "-S", "-c", program], 30,
                                               include_workspace=False, extra_volumes={cache: {"bind": "/cache", "mode": "ro"}})
            try:
                data = json.loads(metadata.output)
                if metadata.exit_code or not 0 <= data["age_seconds"] <= 172800:
                    raise ValueError("database stale")
                return data
            except (ValueError, KeyError, TypeError):
                raise DomainError("SECURITY_DATABASE_UPDATE_FAILED", "The downloaded database failed the freshness check", 503) from None

    async def _scanner(self, work_id: str, scanner: str):
        image = self._image(f"SABRE_{scanner.upper()}_IMAGE")
        rules = os.environ.get("SABRE_SEMGREP_RULES_VOLUME", "sabre-factory-semgrep-rules")
        volumes = {rules: {"bind": "/rules", "mode": "ro"}}
        if scanner == "gitleaks":
            script = "gitleaks dir /workspace --config /rules/gitleaks.toml --gitleaks-ignore-path /dev/null --ignore-gitleaks-allow --no-banner --redact=100 --report-format json --report-path /tmp/report.json >/tmp/scanner.log 2>&1; s=$?; cat /tmp/report.json; exit $s"
            accepted = {0, 1}
        elif scanner == "trivy":
            cache = os.environ.get("SABRE_TRIVY_DB_VOLUME", "sabre-factory-trivy-db")
            volumes[cache] = {"bind": "/cache", "mode": "ro"}
            fresh_program = "import json,datetime,pathlib; p=pathlib.Path('/cache/db/metadata.json'); d=json.loads(p.read_text()); t=datetime.datetime.fromisoformat(d['UpdatedAt'].replace('Z','+00:00')); age=(datetime.datetime.now(datetime.UTC)-t).total_seconds(); print(json.dumps({'fresh': 0 <= age <= 172800}))"
            freshness = await asyncio.to_thread(self._run, self._image("SABRE_HELPER_IMAGE"), work_id,
                                               ["/usr/local/bin/python", "-I", "-S", "-c", fresh_program], 30,
                                               readonly_workspace=True, extra_volumes=volumes)
            if freshness.exit_code or not json.loads(freshness.output).get("fresh"):
                raise DomainError("SCANNER_DATABASE_STALE", "The vulnerability database is unavailable or requires an update")
            script = "trivy fs --config /rules/trivy.yaml --ignorefile /dev/null --cache-dir /cache --cache-backend memory --skip-db-update --offline-scan --scanners vuln,misconfig --format json --output /tmp/report.json /workspace >/tmp/scanner.log 2>&1; s=$?; cat /tmp/report.json; exit $s"
            accepted = {0}
        else:
            script = ""
            accepted = {0, 1}
        scan_work_id = work_id
        if scanner == "semgrep":
            snapshot = await self._helper(work_id, "snapshot")
            scan_work_id = f"scan-{uuid4()}"
            await asyncio.to_thread(self._install_snapshot, scan_work_id, snapshot)
        try:
            if scanner == "semgrep":
                ignore_file = ".sabre-semgrepignore-" + uuid4().hex
                if any(entry["path"] == ignore_file for entry in snapshot["files"]):
                    raise DomainError("SCANNER_CONFIGURATION", "The reserved scanner name already exists")
                await self._helper(scan_work_id, "write", {"path": ignore_file, "content": ""})
                script = f"semgrep scan --config /rules/rules.yml --no-git-ignore --disable-nosem --x-semgrepignore-filename {ignore_file} --json --metrics off --disable-version-check --error /workspace >/tmp/report.json 2>/tmp/scanner.log; s=$?; cat /tmp/report.json; exit $s"
            result = await asyncio.to_thread(self._run, image, scan_work_id, ["-c", script], 600,
                                             readonly_workspace=True, extra_volumes=volumes, entrypoint="/bin/sh",
                                             environment={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": "", "PYTHONSAFEPATH": "1"})
        finally:
            if scan_work_id != work_id:
                await asyncio.to_thread(self._remove_workspace_volume, scan_work_id)
        if result.exit_code not in accepted:
            raise DomainError("SCANNER_FAILED", f"Did not complete {scanner}")
        return json.loads(result.output)

    async def cleanup(self, work_id: str) -> None:
        self.browser_runner.cancel(work_id)
        async with self.lock(work_id):
            # Browser jobs are admitted only after this metadata is committed.
            # Failed workspace admission therefore has no browser resources to reap.
            if self._metadata_path(work_id).exists():
                await asyncio.to_thread(self.browser_runner.cleanup_orphans, work_id)
            for path in self.root.glob(f"{valid_work_id(work_id)}.browser-*.json"):
                if re.fullmatch(re.escape(work_id) + r"\.browser-[a-f0-9]{64}\.json", path.name):
                    path.unlink()
            await asyncio.to_thread(self._remove_workspace_volume, work_id)
            self._metadata_path(work_id).unlink(missing_ok=True)
            self._snapshot_path(work_id).unlink(missing_ok=True)
            self.restored.discard(work_id)
            self._forget(work_id)


class ExecutorClient:
    def __init__(self, base_url: str, token: str, client: httpx.AsyncClient | None = None):
        self.client = client or httpx.AsyncClient(base_url=base_url, timeout=1900, headers={"Authorization": f"Bearer {token}"})
        self.base_url, self.token = base_url.rstrip("/"), token

    async def _request(self, method: str, path: str, body=None):
        headers = {"Authorization": f"Bearer {self.token}"}
        # The broker continues the caller's trace: each command it runs becomes a span under this one.
        parent = traceparent()
        if parent:
            headers["traceparent"] = parent
        run = re.match(r"/workspaces/([A-Za-z0-9_-]{1,64})(?:/|$)", path)
        try:
            response = await self.client.request(method, f"{self.base_url}{path}", json=body, headers=headers)
        except httpx.HTTPError:
            log("executor.failed", work_id=run.group(1) if run else None, error_code="EXECUTOR_UNAVAILABLE")
            raise DomainError("EXECUTOR_UNAVAILABLE", "The runner is unavailable", 503) from None
        if response.status_code >= 400:
            try:
                error = response.json()
            except ValueError:
                error = {}
            code = str(error.get("code", "EXECUTOR_FAILED"))
            if response.status_code >= 500:
                # A refused request (4xx) is an answer; only a broker that could not do its work is a failure.
                log("executor.failed", work_id=run.group(1) if run else None, error_code=code)
            raise DomainError(code, str(error.get("message", "The runner operation failed")), response.status_code)
        return response.json()

    async def prepare(self, project: Project, work_id: str) -> None:
        await self._request("POST", "/workspaces", {"work_id": work_id, "project": project.model_dump(mode="json")})

    async def list_files(self, work_id: str) -> list[str]:
        return await self._request("GET", f"/workspaces/{valid_work_id(work_id)}/files")

    async def read_file(self, work_id: str, path: str) -> str:
        return await self._request("POST", f"/workspaces/{valid_work_id(work_id)}/read", {"path": valid_path(path)})

    async def write_file(self, work_id: str, path: str, content: str, *, expected_content_digest: str | None = None) -> None:
        body = {"path": valid_path(path), "content": content}
        if expected_content_digest is not None:
            body["expected_content_digest"] = expected_content_digest
        await self._request("PUT", f"/workspaces/{valid_work_id(work_id)}/file", body)

    async def execute(self, work_id: str, argv: list[str], timeout_s=300) -> ExecutionResult:
        return ExecutionResult.model_validate(await self._request("POST", f"/workspaces/{valid_work_id(work_id)}/execute", {"argv": argv, "timeout_s": timeout_s}))

    async def prepare_dependencies(self, work_id: str) -> None:
        await self._request("POST", f"/workspaces/{valid_work_id(work_id)}/dependencies")

    async def resolve_dependencies(self, work_id: str) -> dict:
        return await self._request("POST", f"/workspaces/{valid_work_id(work_id)}/resolve-dependencies")

    async def execute_gate(self, work_id: str, argv: list[str], digest: str, timeout_s=300) -> ExecutionResult:
        return ExecutionResult.model_validate(await self._request("POST", f"/workspaces/{valid_work_id(work_id)}/gate", {"argv": argv, "timeout_s": timeout_s, "digest": digest}))

    async def snapshot(self, work_id: str) -> dict:
        return await self._request("GET", f"/workspaces/{valid_work_id(work_id)}/snapshot")

    async def scan_snapshot(self, work_id: str, digest: str, baseline: list[str]) -> list[SecurityFinding]:
        result = await self._request("POST", f"/workspaces/{valid_work_id(work_id)}/scan", {"digest": digest, "baseline": baseline})
        return [SecurityFinding.model_validate(item) for item in result]

    async def security_version(self, work_id: str) -> str:
        return (await self._request("GET", f"/workspaces/{valid_work_id(work_id)}/security-version"))["rules_version"]

    async def refresh_security_database(self) -> dict:
        return await self._request("POST", "/security/update")

    async def cleanup(self, work_id: str) -> None:
        await self._request("DELETE", f"/workspaces/{valid_work_id(work_id)}")

    async def browser_qa(self, work_id: str, request: BrowserJob) -> dict:
        return await self._request("POST", f"/workspaces/{valid_work_id(work_id)}/browser-qa", request.model_dump(mode="json"))

    async def cancel_browser_jobs(self, work_id: str) -> None:
        await self._request("POST", f"/workspaces/{valid_work_id(work_id)}/browser-cancel")

    async def aclose(self):
        await self.client.aclose()


app = FastAPI(title="SABRE executor", docs_url=None, redoc_url=None)
_broker: DockerBroker | None = None


def broker_bootstrap():
    reject_secret_environment()
    path = os.environ.get("SABRE_BOOTSTRAP_FILE")
    return load_bootstrap(path, kind="broker") if path else {}


_telemetry: Any = None


def command_span(work_id: str, parent: str | None):
    """One span per command the broker runs, under the caller's span when it sent its trace context."""
    global _telemetry
    if _telemetry is None:
        # The broker exports to the same endpoint as the control services, when one is configured.
        _telemetry = configure(os.environ.get("SABRE_OTLP_ENDPOINT")) or False
    return span("executor.command", work_id=work_id, parent=parent)


def measured(observation, result: ExecutionResult) -> ExecutionResult:
    """Record how a command ended and how much it printed, never what it printed."""
    observation.set(exit_code=result.exit_code, output_bytes=len(result.output.encode()))
    return result


def get_broker() -> DockerBroker:
    global _broker
    if _broker is None:
        _broker = DockerBroker()
    return _broker


def authenticate(authorization: str | None = Header(default=None)):
    token = broker_bootstrap().get("executor_token", "")
    if not token:
        raise DomainError("EXECUTOR_NOT_CONFIGURED", "Configure runner authentication", 503)
    if not secrets.compare_digest(authorization or "", f"Bearer {token}"):
        raise DomainError("UNAUTHORIZED", "Unauthorized", 401)


@app.exception_handler(DomainError)
async def domain_error_handler(_request, error: DomainError):
    return JSONResponse(status_code=error.status_code, content={"code": error.code, "message": error.message})


@app.get("/health")
async def health():
    return {"status": "ok", "component": "executor"}


@app.post("/workspaces", dependencies=[Depends(authenticate)])
async def prepare(body: PrepareRequest):
    await get_broker().prepare(body.project, body.work_id)
    return {"prepared": True}


@app.get("/workspaces/{work_id}/files", dependencies=[Depends(authenticate)])
async def list_files(work_id: str):
    return await get_broker().list_files(work_id)


@app.post("/workspaces/{work_id}/read", dependencies=[Depends(authenticate)])
async def read_file(work_id: str, body: dict):
    return await get_broker().read_file(work_id, str(body.get("path", "")))


@app.put("/workspaces/{work_id}/file", dependencies=[Depends(authenticate)])
async def write_file(work_id: str, body: FileWrite):
    await get_broker().write_file(work_id, body.path, body.content, expected_content_digest=body.expected_content_digest)
    return {"written": True}


@app.post("/workspaces/{work_id}/execute", dependencies=[Depends(authenticate)])
async def execute(work_id: str, body: Command, traceparent: str | None = Header(default=None)):
    with command_span(work_id, traceparent) as observation:
        return measured(observation, await get_broker().execute(work_id, body.argv, body.timeout_s))


@app.get("/workspaces/{work_id}/snapshot", dependencies=[Depends(authenticate)])
async def snapshot(work_id: str):
    return await get_broker().snapshot(work_id)


@app.post("/workspaces/{work_id}/dependencies", dependencies=[Depends(authenticate)])
async def dependencies(work_id: str):
    await get_broker().prepare_dependencies(work_id)
    return {"prepared": True}


@app.post("/workspaces/{work_id}/resolve-dependencies", dependencies=[Depends(authenticate)])
async def resolve_dependencies(work_id: str):
    return await get_broker().resolve_dependencies(work_id)


class GateCommand(Command):
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")


@app.post("/workspaces/{work_id}/gate", dependencies=[Depends(authenticate)])
async def execute_gate(work_id: str, body: GateCommand, traceparent: str | None = Header(default=None)):
    with command_span(work_id, traceparent) as observation:
        return measured(observation, await get_broker().execute_gate(work_id, body.argv, body.digest, body.timeout_s))


@app.post("/workspaces/{work_id}/scan", dependencies=[Depends(authenticate)])
async def scan(work_id: str, body: ScanRequest):
    return await get_broker().scan_snapshot(work_id, body.digest, body.baseline)


@app.post("/workspaces/{work_id}/browser-qa", dependencies=[Depends(authenticate)])
async def browser_qa(work_id: str, body: BrowserJob):
    return await get_broker().browser_runner.run(valid_work_id(work_id), body)


@app.post("/workspaces/{work_id}/browser-cancel", dependencies=[Depends(authenticate)])
async def cancel_browser(work_id: str):
    get_broker().browser_runner.cancel(valid_work_id(work_id))
    return {"cancel_requested": True}


@app.get("/workspaces/{work_id}/security-version", dependencies=[Depends(authenticate)])
async def security_version(work_id: str):
    return {"rules_version": await get_broker().security_version(work_id)}


@app.post("/security/update", dependencies=[Depends(authenticate)])
async def refresh_security_database():
    return await get_broker().refresh_security_database()


@app.delete("/workspaces/{work_id}", dependencies=[Depends(authenticate)])
async def cleanup(work_id: str):
    await get_broker().cleanup(work_id)
    return {"removed": True}
