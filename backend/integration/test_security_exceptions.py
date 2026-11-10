"""Owner exception persistence and concurrency against the private PostgreSQL service."""

import asyncio
from datetime import timedelta

import pytest
from psycopg.types.json import Jsonb

from sabre.models import (
    Budget,
    DomainError,
    Project,
    SecurityExceptionCreate,
    SecurityFinding,
    Status,
    WorkOrder,
    new_id,
    now,
)
from sabre.repository import Repository, payload
from sabre.security import RULES_VERSION
from sabre.settings import Settings


@pytest.fixture
async def exception_work():
    dsn = Settings().database_url.get_secret_value()
    repository = Repository(dsn)
    await repository.initialize()
    project = Project(name="Exception fixture", repository=f"https://github.com/fixture/{new_id()}", profile="python", gate_commands=[["python", "-m", "unittest"]])
    await repository.create_project(project)
    work = WorkOrder(project_id=project.id, mode="patch", objective="Correct the fixture behavior", acceptance=["Correct output"], budget=Budget(max_cost_usd=1), idempotency_key=new_id())

    async def no_enqueue(conn, work_id):
        return None

    await repository.admit(work, no_enqueue)
    work.status = Status.BLOCKED
    work.security_snapshot_digest, work.security_rules_version = "a" * 64, RULES_VERSION
    work.findings = [SecurityFinding(fingerprint="finding", scanner="trivy", category="vulnerability", severity="high", title="Known fixture vulnerability")]
    await repository.save(work)
    try:
        yield repository, work
    finally:
        async with repository.connection() as conn:
            await conn.execute("DELETE FROM security_exceptions WHERE work_id=%s", (work.id,))
            await conn.execute("DELETE FROM work_orders WHERE id=%s", (work.id,))
            await conn.execute("DELETE FROM projects WHERE id=%s", (project.id,))


def request(**changes):
    values = {"fingerprint": "finding", "justification": "Owner accepts temporary exposure while the fix is scheduled",
              "expires_at": now() + timedelta(days=1), "snapshot_digest": "a" * 64,
              "rules_version": RULES_VERSION, "plan_revision": 1}
    return SecurityExceptionCreate(**(values | changes))


async def test_owner_approval_is_idempotent_and_revocation_is_durable(exception_work):
    repository, work = exception_work
    proposed = request()
    first, second = await asyncio.gather(repository.create_security_exception(work.id, proposed), repository.create_security_exception(work.id, proposed))
    assert first.id == second.id and first.approved_by == "owner"
    assert first.justification == proposed.justification and first.expires_at == proposed.expires_at
    assert len(await repository.security_exceptions(work.id)) == 1
    revoked = await repository.revoke_security_exception(work.id, first.id)
    assert revoked.revoked_at is not None
    assert (await repository.revoke_security_exception(work.id, first.id)).revoked_at == revoked.revoked_at
    with pytest.raises(DomainError) as error:
        await repository.create_security_exception(work.id, proposed)
    assert error.value.code == "SECURITY_EXCEPTION_REVOKED"


@pytest.mark.parametrize("changes,code", [
    ({"fingerprint": "absent"}, "FINDING_NOT_FOUND"),
    ({"snapshot_digest": "b" * 64}, "STALE_SECURITY"),
    ({"rules_version": "changed"}, "STALE_SECURITY"),
    ({"plan_revision": 2}, "STALE_SECURITY"),
    ({"expires_at": now() - timedelta(seconds=1)}, "SECURITY_EXCEPTION_EXPIRY"),
    ({"expires_at": now() + timedelta(days=31)}, "SECURITY_EXCEPTION_EXPIRY"),
])
async def test_grants_reject_missing_stale_or_unbounded_approvals(exception_work, changes, code):
    repository, work = exception_work
    with pytest.raises(DomainError) as error:
        await repository.create_security_exception(work.id, request(**changes))
    assert error.value.code == code
    assert await repository.security_exceptions(work.id) == []


@pytest.mark.parametrize("category", ["secret", "scanner_error"])
async def test_even_owner_cannot_waive_secrets_or_scanner_failure(exception_work, category):
    repository, work = exception_work
    work.findings[0].category = category
    await repository.save(work)
    with pytest.raises(DomainError) as error:
        await repository.create_security_exception(work.id, request())
    assert error.value.code == "SECURITY_EXCEPTION_FORBIDDEN"


async def test_grants_cannot_be_silently_extended_or_revoked_from_another_work(exception_work):
    repository, work = exception_work
    approved = await repository.create_security_exception(work.id, request())
    with pytest.raises(DomainError) as duplicate:
        await repository.create_security_exception(work.id, request(expires_at=now() + timedelta(days=2)))
    assert duplicate.value.code == "SECURITY_EXCEPTION_EXISTS"
    with pytest.raises(DomainError) as other_work:
        await repository.revoke_security_exception("another-work", approved.id)
    assert other_work.value.code == "SECURITY_EXCEPTION_NOT_FOUND"
    assert (await repository.security_exceptions(work.id))[0].revoked_at is None


async def test_expired_approvals_remain_readable_for_audit(exception_work):
    repository, work = exception_work
    approved = await repository.create_security_exception(work.id, request())
    approved.expires_at = now() - timedelta(seconds=1)
    async with repository.connection() as conn:
        await conn.execute("UPDATE security_exceptions SET data=%s WHERE id=%s", (Jsonb(payload(approved)), approved.id))
    assert (await repository.security_exceptions(work.id))[0].expires_at == approved.expires_at


async def test_running_work_cannot_approve_its_own_exception(exception_work):
    repository, work = exception_work
    work.status = Status.RUNNING
    await repository.save(work)
    with pytest.raises(DomainError) as error:
        await repository.create_security_exception(work.id, request())
    assert error.value.code == "PAUSE_REQUIRED"
