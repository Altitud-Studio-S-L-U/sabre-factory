"""Exercise projections and delivery leases against the real PostgreSQL instance."""

from unittest.mock import AsyncMock

import pytest

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as postgres_repository
from sabre.events import ExecutionEvent
from sabre.models import DomainError, new_id, now
from sabre.notifications import WebhookDelivery, WebhookDestination, enqueue_notifications

repository = postgres_repository

async def test_events_deduplicate_and_resume_by_cursor(repository):
    repo, _, work = await fixture_work(repository)
    event = ExecutionEvent(id=new_id(), work_id=work.id, plan_revision=1,
        phase="analysis", correlation_id=new_id(), kind="stage", state="started", name="analysis", timestamp=now())
    await repo.record_execution_event(event)
    await repo.record_execution_event(event)
    await repo.record_execution_event(event.model_copy(update={"id": new_id(), "state": "completed", "duration_ms": 5}))
    first = await repo.execution_events(work.id, limit=1)
    assert first.has_more and len(first.items) == 1
    second = await repo.execution_events(work.id, after=first.next_cursor, limit=1)
    assert not second.has_more
    assert second.items[0].event.state == "completed"
    assert second.next_cursor > first.next_cursor
    assert not (await repo.execution_events(work.id, after=second.next_cursor)).items
    with pytest.raises(DomainError):
        await repo.execution_events(work.id, after=-1)


async def test_delivery_leases_deduplicate_and_expire_without_unbounded_retries(repository):
    repo, _, work = await fixture_work(repository)
    destinations = {"fixture": WebhookDestination(endpoint="https://example.com/events")}
    delivery = WebhookDelivery(repo, destinations, AsyncMock())
    event_id = new_id()
    async with repo.connection() as conn:
        await enqueue_notifications(conn, destinations, event_id, work)
        await enqueue_notifications(conn, destinations, event_id, work)
    try:
        claimed = await delivery.claim()
        assert len(claimed) == 1 and claimed[0]["attempts"] == 1
        assert await delivery.claim() == []
        async with repo.connection() as conn:
            await conn.execute("UPDATE notification_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=%s", (event_id,))
        recovered = (await delivery.claim())[0]
        assert recovered["id"] == claimed[0]["id"] and recovered["attempts"] == 2
        # A late worker cannot overwrite the new lease.
        await delivery.settle(claimed[0])
        async with repo.connection() as conn:
            row = await (await conn.execute("SELECT state FROM notification_outbox WHERE event_id=%s", (event_id,))).fetchone()
            assert row["state"] == "sending"
            await conn.execute("UPDATE notification_outbox SET attempts=6 WHERE event_id=%s", (event_id,))
        recovered["attempts"] = 6
        await delivery.settle(recovered, error="HTTP_503", retry=True)
        assert next(item for item in await delivery.statuses() if item.id == recovered["id"]).state == "failed"
        await delivery.retry(recovered["id"])
        assert (await delivery.claim())[0]["attempts"] == 1
    finally:
        async with repo.connection() as conn:
            await conn.execute("DELETE FROM notification_outbox WHERE event_id=%s", (event_id,))
