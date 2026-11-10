import base64
import codecs
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from sabre.artifacts import ArtifactStore
from sabre.models import Budget, DomainError, Project, WorkOrder
from sabre.security import SecretGuard
from sabre.workflows import Factory
from tests.test_factory_workflow import TestPublisher

LOCAL_KEY = "local-gateway-pin-42"


@pytest.mark.parametrize("encoding", ["utf-8", "binary", "utf-16", "utf-32", "utf-16-be", "utf-32-be"])
async def test_known_local_key_is_blocked_before_any_github_upload(tmp_path, encoding):
    raw = b"\xff" + LOCAL_KEY.encode() + b"\x80" if encoding == "binary" else LOCAL_KEY.encode(encoding)
    if encoding == "utf-16-be":
        raw = codecs.BOM_UTF16_BE + raw
    elif encoding == "utf-32-be":
        raw = codecs.BOM_UTF32_BE + raw
    entry = {"path": "source.txt", "encoding": "utf-8" if encoding == "utf-8" else "base64",
             "content": LOCAL_KEY if encoding == "utf-8" else base64.b64encode(raw).decode()}
    snapshot = {"digest": "a" * 64, "base_commit": "b" * 40, "files": [entry]}
    project = Project(name="Fixture", repository="https://github.com/example/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    work = WorkOrder(project_id=project.id, mode="patch", objective="Correct the fixture behavior", acceptance=["Correct output"], budget=Budget(max_cost_usd=1), idempotency_key="snapshot-egress")
    publisher, guard = TestPublisher(), SecretGuard([LOCAL_KEY])
    factory = SimpleNamespace(begin=AsyncMock(return_value=work), executor=SimpleNamespace(snapshot=AsyncMock(return_value=snapshot)),
        repository=SimpleNamespace(project=AsyncMock(return_value=project)), publisher=publisher,
        artifacts=ArtifactStore(tmp_path, guard), guard=guard, finish=AsyncMock())
    state = {"snapshot": {"digest": "a" * 64}, "security": {"rules_version": "rules-test", "policy_digest": "policy", "exception_ids": []}, "gates": [], "review": "Reviewed"}
    with pytest.raises(DomainError) as error:
        await Factory.commit(factory, state)
    assert error.value.code == "SECRET_DETECTED"
    assert publisher.calls == []
    assert work.evidence is None


def test_snapshot_guard_checks_metadata_without_guessing_base64_inside_plain_text():
    guard = SecretGuard([LOCAL_KEY])
    snapshot = {"digest": "a" * 64, "files": [{"path": "data.txt", "encoding": "utf-8", "content": base64.b64encode(LOCAL_KEY.encode()).decode()}]}
    original = deepcopy(snapshot)
    guard.check_snapshot(snapshot)
    assert snapshot == original
    snapshot["files"][0]["path"] = LOCAL_KEY
    with pytest.raises(DomainError) as error:
        guard.check_snapshot(snapshot)
    assert error.value.code == "SECRET_DETECTED"


@pytest.mark.parametrize("entry", [
    {"path": "data", "encoding": "base64", "content": "!invalid!"},
    {"path": "data", "encoding": "unknown", "content": "source"},
    {"path": "data", "encoding": "utf-8", "content": "\ud800"},
])
def test_malformed_snapshot_content_fails_closed(entry):
    with pytest.raises(DomainError) as error:
        SecretGuard().check_snapshot({"files": [entry]})
    assert error.value.code == "INVALID_SNAPSHOT"
