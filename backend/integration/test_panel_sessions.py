"""Browser grants are single-use and survive control-process restarts."""

import asyncio
import secrets

import psycopg
import pytest

from sabre.models import DomainError
from sabre.panel_sessions import PanelSessions
from sabre.repository import PANEL_SESSION_LOCK, Repository
from sabre.settings import Settings

ORIGIN = "http://127.0.0.1:8000"


@pytest.fixture
async def panel():
    repository = Repository(Settings().database_url.get_secret_value())
    await repository.initialize()
    manager = PanelSessions(repository, secrets.token_urlsafe(32), ORIGIN)
    try:
        yield manager
    finally:
        async with repository.connection() as conn:
            await conn.execute("DELETE FROM panel_tickets WHERE epoch=%s", (manager.epoch,))
            await conn.execute("DELETE FROM panel_sessions WHERE epoch=%s", (manager.epoch,))


async def test_simultaneous_exchange_has_one_winner_and_stores_only_hashes(panel):
    ticket = (await panel.issue())["ticket"]
    results = await asyncio.gather(panel.exchange(ticket), panel.exchange(ticket), return_exceptions=True)
    successes = [result for result in results if isinstance(result, tuple)]
    failures = [result for result in results if isinstance(result, DomainError)]
    assert len(successes) == len(failures) == 1
    assert failures[0].code == "SESSION_TICKET_INVALID"
    session, response = successes[0]
    async with panel.repository.connection() as conn:
        tickets = await (await conn.execute("SELECT * FROM panel_tickets WHERE epoch=%s", (panel.epoch,))).fetchall()
        sessions = await (await conn.execute("SELECT * FROM panel_sessions WHERE epoch=%s", (panel.epoch,))).fetchall()
    assert tickets == []
    assert len(sessions) == 1
    assert sessions[0]["session_hash"] == panel.hashed(session)
    for raw in (ticket, session, response["csrf_token"]):
        assert raw not in str(sessions)
    restarted = Repository(panel.repository.dsn)
    await restarted.initialize()
    assert await restarted.panel_session(panel.hashed(session), ORIGIN, panel.epoch) is not None
    await restarted.revoke_panel_session(panel.hashed(session))
    assert await restarted.panel_session(panel.hashed(session), ORIGIN, panel.epoch) is None


async def test_expired_ticket_and_session_are_rejected_by_database_time(panel):
    ticket = (await panel.issue())["ticket"]
    async with panel.repository.connection() as conn:
        await conn.execute("UPDATE panel_tickets SET expires_at=now() WHERE ticket_hash=%s", (panel.hashed(ticket),))
    with pytest.raises(DomainError, match="expired"):
        await panel.exchange(ticket)
    session, _ = await panel.exchange((await panel.issue())["ticket"])
    async with panel.repository.connection() as conn:
        await conn.execute("UPDATE panel_sessions SET expires_at=now() WHERE session_hash=%s", (panel.hashed(session),))
    assert await panel.repository.panel_session(panel.hashed(session), ORIGIN, panel.epoch) is None


async def test_origin_and_owner_rotation_do_not_reuse_existing_grants(panel):
    ticket = (await panel.issue())["ticket"]
    for origin, epoch in (("http://127.0.0.1:8001", panel.epoch), (ORIGIN, "other-owner")):
        assert await panel.repository.exchange_panel_ticket(panel.hashed(ticket), "unused", origin, epoch) is None
    session, _ = await panel.exchange(ticket)
    assert await panel.repository.panel_session(panel.hashed(session), "http://127.0.0.1:8001", panel.epoch) is None
    assert await panel.repository.panel_session(panel.hashed(session), ORIGIN, "other-owner") is None


async def test_session_insert_failure_rolls_back_ticket_consumption(panel):
    first, _ = await panel.exchange((await panel.issue())["ticket"])
    ticket = (await panel.issue())["ticket"]
    with pytest.raises(psycopg.errors.UniqueViolation):
        await panel.repository.exchange_panel_ticket(panel.hashed(ticket), panel.hashed(first), ORIGIN, panel.epoch)
    session, _ = await panel.exchange(ticket)
    assert session != first


async def test_outstanding_tickets_are_bounded_and_expired_grants_are_collected(panel):
    tickets = [await panel.issue() for _ in range(32)]
    with pytest.raises(DomainError) as failure:
        await panel.issue()
    assert failure.value.code == "PANEL_TICKET_LIMIT"
    async with panel.repository.connection() as conn:
        await conn.execute("UPDATE panel_tickets SET expires_at=now() WHERE ticket_hash=%s", (panel.hashed(tickets[0]["ticket"]),))
    assert (await panel.issue())["expires_in"] == 60


async def test_ticket_expiring_while_exchange_waits_for_lock_is_rejected(panel):
    ticket = (await panel.issue())["ticket"]
    task = None
    try:
        async with panel.repository.connection() as blocker:
            await blocker.execute("SELECT pg_advisory_xact_lock(%s)", (PANEL_SESSION_LOCK,))
            task = asyncio.create_task(panel.exchange(ticket))
            async with asyncio.timeout(10):
                while True:
                    waiting = await (await blocker.execute("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=%s AND NOT granted) AS waiting", (PANEL_SESSION_LOCK,))).fetchone()
                    if waiting["waiting"]:
                        break
                    await asyncio.sleep(0.01)
            # The contender's transaction began before this wall-clock expiry. Releasing the
            # blocker must not make transaction-start now() extend a single-use grant's life.
            await blocker.execute("UPDATE panel_tickets SET expires_at=clock_timestamp() WHERE ticket_hash=%s", (panel.hashed(ticket),))
        with pytest.raises(DomainError) as rejected:
            await task
        assert rejected.value.code == "SESSION_TICKET_INVALID"
    finally:
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
