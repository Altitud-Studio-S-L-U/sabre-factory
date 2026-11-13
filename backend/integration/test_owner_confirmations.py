"""Owner confirmation storage and concurrency against the private PostgreSQL service."""

import asyncio
from types import SimpleNamespace

import pytest

from sabre.models import Budget, DomainError, Project, Status, TokenBudgetIncrease, WorkOrder, new_id
from sabre.owner_confirmations import ConfirmationDecision, OwnerConfirmations
from sabre.repository import Repository
from sabre.security import SecretGuard
from sabre.settings import Settings


@pytest.fixture
async def confirmations():
    repository = Repository(Settings().database_url.get_secret_value())
    await repository.initialize()
    project = Project(name="Confirmation fixture", repository=f"https://github.com/fixture/{new_id()}", profile="python",
                      gate_commands=[["python", "-m", "unittest"]])
    await repository.create_project(project)
    work = WorkOrder(project_id=project.id, mode="patch", objective="Correct the fixture behavior", acceptance=["Correct output"],
                     budget=Budget(max_cost_usd=1), idempotency_key=new_id())

    async def no_enqueue(conn, work_id):
        return None

    await repository.admit(work, no_enqueue)
    work.status = Status.BLOCKED
    await repository.save(work)
    applied = []

    async def increase_token_budget(work_id, change):
        applied.append(change)
        await asyncio.sleep(0.05)

    service = SimpleNamespace(repository=repository, guard=SecretGuard(), increase_token_budget=increase_token_budget)
    try:
        yield OwnerConfirmations(service), work, applied
    finally:
        async with repository.connection() as conn:
            await remove_work(conn, work)
            await conn.execute("DELETE FROM projects WHERE id=%s", (project.id,))


async def remove_work(conn, work):
    await conn.execute("DELETE FROM notifications WHERE work_id=%s", (work.id,))
    await conn.execute("DELETE FROM work_events WHERE work_id=%s", (work.id,))
    await conn.execute("DELETE FROM work_orders WHERE id=%s", (work.id,))


def increase(tokens=250000):
    return TokenBudgetIncrease(expected_revision=1, expected_max_tokens=100000, max_tokens=tokens)


def decision(confirmation):
    return ConfirmationDecision(version=1, request_digest=confirmation.request_digest)


async def rows(manager, work):
    async with manager.service.repository.connection() as conn:
        return await (await conn.execute("SELECT id,state FROM owner_confirmations WHERE work_id=%s ORDER BY created_at", (work.id,))).fetchall()


async def test_concurrent_identical_requests_store_one_proposal_and_one_event(confirmations):
    manager, work, applied = confirmations
    filed = await asyncio.gather(*[manager.request("budget.tokens", work.id, increase()) for _ in range(4)])
    assert len({item.id for item in filed}) == 1 and filed[0].state == "pending"
    assert len(await rows(manager, work)) == 1 and applied == []
    events = [event for event in await manager.service.repository.events(work.id) if event["kind"] == "owner_confirmation_requested"]
    assert len(events) == 1
    page = await manager.list()
    assert filed[0].id in {item.id for item in page.items if item.state == "pending"}


async def test_concurrent_confirmations_apply_the_request_once(confirmations):
    manager, work, applied = confirmations
    pending = await manager.request("budget.tokens", work.id, increase())
    results = await asyncio.gather(*[manager.confirm(pending.id, decision(pending)) for _ in range(3)], return_exceptions=True)
    confirmed = [item for item in results if not isinstance(item, Exception)]
    refused = [item for item in results if isinstance(item, DomainError)]
    assert len(confirmed) == 1 and confirmed[0].state == "applied"
    assert [error.code for error in refused] == ["CONFIRMATION_CLOSED"] * 2
    assert applied == [increase()]
    assert (await manager.get(pending.id)).state == "applied"


async def test_expired_proposal_is_closed_and_frees_the_slot_for_a_new_request(confirmations):
    manager, work, applied = confirmations
    stale = await manager.request("budget.tokens", work.id, increase())
    async with manager.service.repository.connection() as conn:
        await conn.execute("UPDATE owner_confirmations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s", (stale.id,))
    assert (await manager.get(stale.id)).state == "expired"
    with pytest.raises(DomainError) as error:
        await manager.confirm(stale.id, decision(stale))
    assert error.value.code == "CONFIRMATION_CLOSED" and applied == []
    fresh = await manager.request("budget.tokens", work.id, increase())
    assert fresh.id != stale.id
    assert [row["state"] for row in await rows(manager, work)] == ["expired", "pending"]
    rejected = await manager.reject(fresh.id, decision(fresh))
    assert rejected.state == "rejected" and applied == []


async def test_proposals_are_removed_with_their_run(confirmations):
    manager, work, _applied = confirmations
    await manager.request("budget.tokens", work.id, increase())
    async with manager.service.repository.connection() as conn:
        await remove_work(conn, work)
    assert await rows(manager, work) == []
