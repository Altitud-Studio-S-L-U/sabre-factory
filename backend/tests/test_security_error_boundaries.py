from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from sabre.models import DomainError
from sabre.security import RULES_VERSION, SecretGuard, SecurityService, security_policy_digest
from tests.test_error_boundaries import SECRET, assert_checkpoint_clean


@pytest.mark.parametrize("boundary", ["scanner", "analyst", "triage", "exceptions", "decide"])
async def test_nested_security_graph_sanitizes_failures_before_its_own_checkpoint(monkeypatch, boundary):
    class Scanner:
        async def scan_snapshot(self, *args):
            if boundary == "scanner":
                raise RuntimeError(SECRET)
            return []

    async def analyst(work_id, findings):
        if boundary == "analyst":
            raise RuntimeError(SECRET)
        return []

    if boundary in {"triage", "exceptions", "decide"}:
        def failure(self, state):
            raise RuntimeError(SECRET)
        monkeypatch.setattr(SecurityService, "_" + boundary, failure)
    saver = InMemorySaver()
    service = SecurityService(Scanner(), saver, analyst=analyst, guard=SecretGuard([SECRET]))
    policy = security_policy_digest("work", "a" * 64, RULES_VERSION, [], [])
    config = {"configurable": {"thread_id": f"security:work:{'a' * 64}:{policy}"}}
    with pytest.raises(Exception) as caught:
        await service.review("work", "a" * 64, [])
    await assert_checkpoint_clean(service.graph, saver, config)
    assert isinstance(caught.value, DomainError)
    assert caught.value.code == "SECURITY_REVIEW_FAILED"
    assert caught.value.__context__ is None and caught.value.__cause__ is None


@pytest.mark.parametrize("returns_secret", [False, True])
async def test_security_version_lookup_is_checked_before_initial_checkpoint(returns_secret):
    class Scanner:
        security_version = AsyncMock(return_value=SECRET) if returns_secret else AsyncMock(side_effect=RuntimeError(SECRET))
        scan_snapshot = AsyncMock(return_value=[])

    saver = InMemorySaver()
    service = SecurityService(Scanner(), saver, guard=SecretGuard([SECRET]))
    with pytest.raises(DomainError) as caught:
        await service.review("work", "a" * 64, [])
    assert caught.value.code == ("SECRET_DETECTED" if returns_secret else "SECURITY_REVIEW_FAILED")
    assert SECRET not in str(caught.value)
    assert list(saver.list(None)) == []
