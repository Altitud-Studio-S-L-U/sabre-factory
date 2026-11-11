import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from sabre.artifacts import ArtifactStore
from sabre.browser_contracts import BrowserJob
from sabre.browser_qa import BrowserQAService, browser_seccomp
from sabre.models import Budget, DomainError, Status, WorkOrder
from sabre.repository import digest
from sabre.security import SecretGuard


def fixture(tmp_path):
    work = WorkOrder(project_id="synthetic-project", mode="audit", objective="Inspect synthetic UI behavior",
        acceptance=["Capture real UI evidence"], budget=Budget(), idempotency_key="synthetic-ui-1", status=Status.RUNNING)
    repository = SimpleNamespace(work=AsyncMock(return_value=work), begin_command=AsyncMock(return_value=None), finish_effect=AsyncMock())
    raw = {"version": 1, "snapshot_digest": "a" * 64, "evaluator": "playwright-1.64.0+axe-core-4.11.0", "passed": True,
        "results": [{"viewport": "desktop", "passed": True}], "visual_review": "unavailable",
        "artifacts": [{"kind": "screenshot", "viewport": "desktop", "media_type": "image/png",
            "content": base64.b64encode(b"synthetic-image-fixture").decode(), "review_required": False}]}
    executor = SimpleNamespace(browser_qa=AsyncMock(return_value=raw), snapshot=AsyncMock(return_value={"digest": "a" * 64}))
    guard = SecretGuard()
    service = BrowserQAService(repository, executor, ArtifactStore(tmp_path, guard), guard)
    job = BrowserJob(idempotency_key="synthetic-browser-key", snapshot_digest="a" * 64,
        operations=[{"action": "navigate", "target": "/"}])
    return service, work, job


async def test_real_evidence_receipts_have_snapshot_identity_and_no_invented_visual_review(tmp_path):
    service, work, job = fixture(tmp_path)
    report = await service.run(work, job)
    assert report.visual_review == "unavailable"
    assert report.work_id == work.id and report.snapshot_digest == job.snapshot_digest
    assert [item.kind for item in report.artifacts] == ["screenshot", "report"]
    content = service.artifacts.get(report.artifacts[0].digest)
    assert content == b"synthetic-image-fixture"
    saved = service.repository.finish_effect.call_args.args[1]
    assert "content" not in json.dumps(saved)
    service.repository.begin_command.return_value = {"state": "completed", "request_hash": digest(job.model_dump(mode="json")), "result": saved}
    assert (await service.run(work, job)) == report
    service.executor.browser_qa.assert_awaited_once()
    service.executor.snapshot.return_value = {"digest": "b" * 64}
    with pytest.raises(DomainError) as stale:
        await service.run(work, job)
    assert stale.value.code == "BROWSER_SOURCE_STALE"


async def test_cancelled_or_changed_revision_cannot_start_browser_effect(tmp_path):
    service, work, job = fixture(tmp_path)
    service.repository.work.return_value = work.model_copy(update={"status": Status.CANCELLED})
    with pytest.raises(DomainError):
        await service.run(work, job)
    service.executor.browser_qa.assert_not_awaited()
    service.repository.work.return_value = work.model_copy(update={"plan_revision": work.plan_revision + 1})
    with pytest.raises(DomainError):
        await service.run(work, job)


def test_chromium_sandbox_profile_remains_deny_by_default_without_outer_capabilities():
    profile = json.loads(browser_seccomp())
    assert profile["defaultAction"] == "SCMP_ACT_ERRNO"
    assert any("chroot" in rule["names"] and rule["action"] == "SCMP_ACT_ALLOW" for rule in profile["syscalls"])
    assert "unprivileged user namespace" in profile["comment"]
