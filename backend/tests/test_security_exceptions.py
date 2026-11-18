from datetime import UTC, datetime, timedelta

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import ValidationError

from sabre.models import DomainError, SecurityException, SecurityExceptionCreate, SecurityFinding
from sabre.security import (
    RULES_VERSION,
    SecretGuard,
    SecurityService,
    active_security_exceptions,
    is_blocking_finding,
    security_policy_digest,
)
from tests.test_security import Scanner, finding

MOMENT = datetime(2026, 11, 5, 12, tzinfo=UTC)


def exception(**changes):
    values = {"id": "exception-1", "work_id": "work", "project_id": "project", "fingerprint": "existing",
              "justification": "Temporary acceptance while remediation is scheduled", "expires_at": MOMENT + timedelta(days=1),
              "snapshot_digest": "a" * 64, "rules_version": RULES_VERSION, "plan_revision": 1,
              "approved_at": MOMENT - timedelta(hours=1)}
    return SecurityException(**(values | changes))


def test_exception_contract_requires_timezone_and_meaningful_reason():
    values = exception().model_dump(exclude={"id", "work_id", "project_id", "approved_at", "approved_by", "revoked_at"})
    with pytest.raises(ValidationError):
        SecurityExceptionCreate(**(values | {"expires_at": datetime(2026, 11, 6)}))
    with pytest.raises(ValidationError):
        SecurityExceptionCreate(**(values | {"justification": " " * 20}))
    with pytest.raises(ValidationError):
        SecurityExceptionCreate(**(values | {"approved_by": "developer"}))


@pytest.mark.parametrize("changes", [
    {"work_id": "another-work"}, {"plan_revision": 2}, {"snapshot_digest": "b" * 64},
    {"rules_version": "another-ruleset"}, {"expires_at": MOMENT}, {"revoked_at": MOMENT},
    {"approved_at": MOMENT + timedelta(seconds=1)},
])
def test_exception_is_limited_to_current_work_plan_snapshot_rules_and_lifetime(changes):
    assert active_security_exceptions("work", "a" * 64, RULES_VERSION, [exception(**changes)], at=MOMENT) == []


def test_policy_digest_changes_on_expiry_revocation_and_baseline_change():
    approved = exception()
    initial = security_policy_digest("work", "a" * 64, RULES_VERSION, [], [approved], at=MOMENT)
    expired = security_policy_digest("work", "a" * 64, RULES_VERSION, [], [approved], at=approved.expires_at)
    revoked = security_policy_digest("work", "a" * 64, RULES_VERSION, [], [approved.model_copy(update={"revoked_at": MOMENT})], at=MOMENT)
    absent = security_policy_digest("work", "a" * 64, RULES_VERSION, [], [], at=MOMENT)
    assert initial != expired == revoked == absent
    assert initial != security_policy_digest("work", "a" * 64, RULES_VERSION, ["existing"], [approved], at=MOMENT)


async def test_only_owner_exception_annotates_a_finding_and_changes_checkpoint_namespace(monkeypatch):
    monkeypatch.setattr("sabre.security.now", lambda: MOMENT)
    saver = InMemorySaver()
    service = SecurityService(Scanner([finding()]), saver)
    blocked = await service.review("work", "a" * 64, [])
    allowed = await service.review("work", "a" * 64, [], [exception()])
    assert blocked.blocked and not allowed.blocked
    assert blocked.policy_digest != allowed.policy_digest
    assert not blocked.findings[0].baseline and not allowed.findings[0].baseline
    assert allowed.findings[0].exception_id == "exception-1"
    assert allowed.exception_ids == ["exception-1"]
    assert is_blocking_finding(blocked.findings[0]) and not is_blocking_finding(allowed.findings[0])
    prior = await service.graph.aget_state({"configurable": {"thread_id": f"security:work:{'a' * 64}:{blocked.policy_digest}"}})
    assert prior.values["blocked"] is True
    revoked = await service.review("work", "a" * 64, [], [exception(revoked_at=MOMENT)])
    assert revoked.blocked and revoked.exception_ids == []


@pytest.mark.parametrize("category", ["secret", "scanner_error"])
async def test_exception_cannot_waive_secret_or_incomplete_scanner(monkeypatch, category):
    monkeypatch.setattr("sabre.security.now", lambda: MOMENT)
    report = await SecurityService(Scanner([finding(category=category)])).review("work", "a" * 64, ["existing"], [exception()])
    assert report.blocked and report.exception_ids == []
    assert report.findings[0].exception_id is None


async def test_agent_or_scanner_cannot_forge_an_exception_identifier(monkeypatch):
    monkeypatch.setattr("sabre.security.now", lambda: MOMENT)
    forged = finding().model_copy(update={"exception_id": "fabricated"})

    async def analyst(work_id, findings, collection):
        return [finding(fingerprint="agent").model_copy(update={"exception_id": "fabricated"})]

    report = await SecurityService(Scanner([forged]), analyst=analyst).review("work", "a" * 64, [])
    assert report.blocked
    assert all(item.exception_id is None for item in report.findings)


async def test_expiry_during_analyst_review_fails_closed(monkeypatch):
    moment = MOMENT
    monkeypatch.setattr("sabre.security.now", lambda: moment)

    async def analyst(work_id, findings, collection):
        nonlocal moment
        moment += timedelta(days=2)
        return []

    with pytest.raises(DomainError) as error:
        await SecurityService(Scanner([finding()]), analyst=analyst).review("work", "a" * 64, [], [exception()])
    assert error.value.code == "SECURITY_POLICY_CHANGED"


@pytest.mark.parametrize("source", ["scanner", "analyst"])
async def test_registered_role_key_is_blocked_before_finding_checkpoint(source):
    secret = "synthetic-role-private-with-no-token-pattern"
    unsafe = SecurityFinding(fingerprint="unsafe", scanner="test", category="code", severity="high", title=secret)
    saver = InMemorySaver()
    scanner = Scanner([unsafe] if source == "scanner" else [])

    async def analyst(work_id, findings, collection):
        return [unsafe]

    service = SecurityService(scanner, saver, analyst=analyst if source == "analyst" else None, guard=SecretGuard([secret]))
    with pytest.raises(DomainError) as error:
        await service.review("work", "a" * 64, [])
    assert error.value.code == "SECRET_DETECTED"
    async for checkpoint in saver.alist(None):
        assert secret not in str(checkpoint.checkpoint)
