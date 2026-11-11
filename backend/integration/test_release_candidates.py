import hashlib
import json
from types import SimpleNamespace

import httpx
import pytest

from integration.test_postgres import fixture_work
from sabre.artifacts import ArtifactStore
from sabre.executor import snapshot_digest
from sabre.models import DeliveryEvidence, DomainError, GateResult, Status
from sabre.publisher import GitHubPublisher
from sabre.release_candidates import (
    ReleaseAuthorization,
    ReleasePreparation,
    ReleasePublication,
    ReleaseService,
)
from sabre.repository import digest
from sabre.security import SecretGuard, security_policy_digest

pytest_plugins = ["integration.test_postgres"]


@pytest.fixture
async def release_service(repository, tmp_path):
    repo, project, work = await fixture_work(repository)
    guard = SecretGuard(["synthetic-private-value"])
    artifacts = ArtifactStore(tmp_path, guard)
    snapshot = {"digest": "a" * 64, "base_commit": "b" * 40, "files": [{"path": "app.py", "content": "print('ok')\n"}]}
    snapshot["digest"] = snapshot_digest(snapshot["files"])
    work.status = Status.COMPLETED
    work.evidence = DeliveryEvidence(commit="c" * 40, snapshot_digest=snapshot["digest"], profile_digest=digest(project.gate_commands), rules_version="rules-v1",
        gates=[GateResult(command=project.gate_commands[0], exit_code=0, output_digest="d" * 64, snapshot_digest=snapshot["digest"])], findings=[], review="Reviewed independently",
        source_digest=artifacts.put(json.dumps(snapshot)), branch="fix/checked", pr_url="https://github.com/fixture/project/pull/1")
    work.evidence.security_policy_digest = security_policy_digest(work.id, work.evidence.snapshot_digest, "rules-v1", [], [], plan_revision=work.plan_revision)
    await repo.save(work)
    remote = {"release": None, "assets": {}, "create_count": 0, "publish_count": 0, "upload_count": {}, "lost": None,
              "ci_sha": work.evidence.commit, "ci_success": True, "required": [], "tag_sha": None}

    async def transport(request):
        path, method = request.url.path, request.method
        if path.endswith("/protection/required_status_checks"):
            return httpx.Response(200, json={"contexts": remote["required"], "checks": []})
        if path.endswith("/check-runs"):
            return httpx.Response(200, json={"total_count": 1, "check_runs": [{"name": "unit", "head_sha": remote["ci_sha"], "status": "completed", "conclusion": "success" if remote["ci_success"] else "failure"}]})
        if path.endswith("/status"):
            return httpx.Response(200, json={"sha": work.evidence.commit, "statuses": [], "total_count": 0})
        if "/git/commits/" in path:
            return httpx.Response(200, json={"sha": work.evidence.commit, "message": "fix: checked behavior", "author": {"email": "author@example.org"}})
        if "/git/ref/tags/" in path:
            return httpx.Response(200, json={"object": {"type": "commit", "sha": remote["tag_sha"]}}) if remote["tag_sha"] else httpx.Response(404)
        if method == "GET" and "/releases/tags/" in path:
            return httpx.Response(200, json=remote["release"]) if remote["release"] and not remote["release"]["draft"] else httpx.Response(404)
        if method == "GET" and path.endswith("/releases"):
            return httpx.Response(200, json=[remote["release"]] if remote["release"] else [])
        if method == "POST" and path.endswith("/releases"):
            remote["create_count"] += 1
            remote["release"] = {**json.loads(request.content), "id": 17, "html_url": "https://github.com/fixture/project/releases/tag/v1.0.0"}
            if remote["lost"] == "create":
                remote["lost"] = None
                raise httpx.ReadTimeout("Synthetic response loss", request=request)
            return httpx.Response(201, json=remote["release"])
        if method == "GET" and path.endswith("/assets"):
            return httpx.Response(200, json=list(remote["assets"].values()))
        if method == "POST" and path.endswith("/assets"):
            name = request.url.params["name"]
            remote["upload_count"][name] = remote["upload_count"].get(name, 0) + 1
            asset = {"name": name, "size": len(request.content), "digest": "sha256:" + hashlib.sha256(request.content).hexdigest(), "state": "uploaded"}
            remote["assets"][name] = asset
            if remote["lost"] == "asset":
                remote["lost"] = None
                raise httpx.ReadTimeout("Synthetic response loss", request=request)
            return httpx.Response(201, json=asset)
        if method == "PATCH":
            remote["publish_count"] += 1
            remote["release"]["draft"] = False
            remote["tag_sha"] = work.evidence.commit
            if remote["lost"] == "publish":
                remote["lost"] = None
                raise httpx.ReadTimeout("Synthetic response loss", request=request)
            return httpx.Response(200, json=remote["release"])
        if method == "GET" and path.endswith("/releases/17"):
            return httpx.Response(200, json=remote["release"])
        raise AssertionError(f"Unexpected synthetic route {method} {path}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport), base_url="https://api.github.com") as client:
        publisher = GitHubPublisher(repo, "synthetic-token", client)
        service = ReleaseService(SimpleNamespace(repository=repo, guard=guard, factory=SimpleNamespace(artifacts=artifacts, publisher=publisher)))
        try:
            yield service, remote, work, artifacts
        finally:
            async with repo.connection() as conn:
                await conn.execute("DELETE FROM release_authorizations WHERE candidate_id IN (SELECT id FROM release_candidates WHERE project_id=%s)", (project.id,))
                await conn.execute("DELETE FROM release_candidates WHERE project_id=%s", (project.id,))


async def candidate(service, work):
    prepared = await service.prepare(ReleasePreparation(version=1, work_id=work.id, package_version="1.0.0", idempotency_key="release-fixture", required_checks=["unit"]))
    return prepared


@pytest.mark.parametrize("lost", ["create", "asset", "publish"])
async def test_lost_github_response_reconciles_exact_candidate_without_duplicate_effects(release_service, lost):
    service, remote, work, _ = release_service
    prepared = await candidate(service, work)
    assert not prepared.blockers and prepared.status == "prepared"
    approved = await service.authorize(prepared.id, ReleaseAuthorization(version=1, expected_revision=0, candidate_digest=prepared.digest, authorize_publication=True))
    remote["lost"] = lost
    request = ReleasePublication(version=1, expected_revision=approved.revision, candidate_digest=prepared.digest, idempotency_key="publication-" + work.id)
    with pytest.raises(httpx.ReadTimeout):
        await service.publish(prepared.id, request)
    assert (await service.get(prepared.id)).status == "uncertain"
    completed = await service.publish(prepared.id, request.model_copy(update={"idempotency_key": "reload-" + work.id}))
    assert completed.status == "published" and completed.release_url
    assert remote["create_count"] == 1 and remote["publish_count"] == 1
    assert all(count == 1 for count in remote["upload_count"].values())
    assert (await service.publish(prepared.id, request)).status == "published"


async def test_wrong_commit_ci_missing_policy_and_stale_candidate_block_before_publication(release_service):
    service, remote, work, _ = release_service
    prepared = await candidate(service, work)
    request = ReleaseAuthorization(version=1, expected_revision=0, candidate_digest=prepared.digest, authorize_publication=True)
    remote["ci_sha"] = "e" * 40
    with pytest.raises(DomainError) as error:
        await service.authorize(prepared.id, request)
    assert error.value.code == "RELEASE_CI_BLOCKED"
    remote["ci_sha"] = work.evidence.commit
    remote["required"] = ["security"]
    with pytest.raises(DomainError) as error:
        await service.authorize(prepared.id, request)
    assert error.value.code == "RELEASE_CI_POLICY_CHANGED"
    remote["required"] = []
    approved = await service.authorize(prepared.id, request)
    with pytest.raises(DomainError) as error:
        await service.authorize(prepared.id, request)
    assert error.value.code == "RELEASE_REVISION_CONFLICT"
    with pytest.raises(DomainError) as error:
        await service.publish(prepared.id, ReleasePublication(version=1, expected_revision=approved.revision, candidate_digest="f" * 64, idempotency_key="wrong-candidate"))
    assert error.value.code == "RELEASE_AUTHORIZATION_REQUIRED" and remote["create_count"] == 0


async def test_changed_artifact_and_failed_gates_block_and_inventory_contains_no_author_email(release_service):
    service, remote, work, artifacts = release_service
    prepared = await candidate(service, work)
    assert (await candidate(service, work)).id == prepared.id
    assert all(b"author@example.org" not in artifacts.get(item.digest) for item in prepared.artifacts)
    artifact = prepared.artifacts[0]
    artifacts._path(artifact.digest).write_bytes(b"changed")
    with pytest.raises(DomainError) as error:
        await service.authorize(prepared.id, ReleaseAuthorization(version=1, expected_revision=0, candidate_digest=prepared.digest, authorize_publication=True))
    assert error.value.code == "ARTIFACT_CORRUPT" and remote["create_count"] == 0
    work.evidence.gates[0].exit_code = 1
    await service.repository.save(work)
    with pytest.raises(DomainError) as error:
        await candidate(service, work)
    assert error.value.code == "RELEASE_CHECKS_FAILED"
