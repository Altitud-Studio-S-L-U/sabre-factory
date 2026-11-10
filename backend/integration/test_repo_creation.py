import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from psycopg import sql
from pydantic import SecretStr

from integration.test_postgres import repository as repository
from sabre.models import DomainError, new_id
from sabre.repo_creation import RepoCreationDecision, RepoCreationRequest, RepoCreationService
from sabre.security import SecretGuard
from tests.test_repo_creation import receipt


@pytest.fixture
async def creation(repository):
    repo, _ = repository
    prefix = f"fixture-{new_id()}"
    queue_table = sql.Identifier("repository_test_queue_" + new_id().replace("-", ""))
    async with repo.connection() as conn:
        await conn.execute(sql.SQL("CREATE TABLE {}(id text PRIMARY KEY)").format(queue_table))
    async def enqueue(conn, proposal_id):
        await conn.execute(sql.SQL("INSERT INTO {} VALUES(%s)").format(queue_table), (proposal_id,))
    credentials = SimpleNamespace(resolve=AsyncMock(return_value=SecretStr("synthetic-create-token")), revision=("fixture",),
        ensure_enabled=AsyncMock(), assert_current=AsyncMock())
    service = RepoCreationService(repo, credentials, SecretGuard(["synthetic-create-token"]), enqueue=enqueue)
    await service.initialize()
    yield service, prefix, queue_table
    async with repo.connection() as conn:
        await conn.execute("DELETE FROM repository_proposals WHERE request_key LIKE %s", (prefix + "%",))
        await conn.execute(sql.SQL("DROP TABLE {}").format(queue_table))


def request(prefix, **changes):
    return RepoCreationRequest(owner_type="org", owner="fixture", name=prefix, idempotency_key=prefix, **changes)


def decision(proposal, choice="approve", **changes):
    return RepoCreationDecision(expected_revision=proposal.revision, request_digest=proposal.request_digest, decision=choice, **changes)


async def test_proposal_replay_digest_conflict_and_approval_enqueue_cas_are_durable(creation):
    service, prefix, queue_table = creation
    proposal = await service.propose(request(prefix))
    assert (await service.propose(request(prefix))).id == proposal.id
    with pytest.raises(DomainError) as pending:
        await service.propose(request(prefix).model_copy(update={"idempotency_key": prefix + "-other"}))
    assert pending.value.code == "REPOSITORY_PROPOSAL_EXISTS"
    with pytest.raises(DomainError) as mismatch:
        await service.propose(request(prefix, visibility="public"))
    assert mismatch.value.code == "REPOSITORY_REQUEST_CONFLICT"
    wrong = decision(proposal).model_copy(update={"request_digest": "a" * 64})
    with pytest.raises(DomainError):
        await service.decide(proposal.id, wrong)
    assert (await service.get(proposal.id)).status == "proposed"
    outcomes = await asyncio.gather(*(service.decide(proposal.id, decision(proposal)) for _ in range(2)), return_exceptions=True)
    assert sum(getattr(item, "status", None) == "approved" for item in outcomes) == 1
    assert sum(isinstance(item, DomainError) and item.code == "REPOSITORY_PROPOSAL_CHANGED" for item in outcomes) == 1
    async with service.repository.connection() as conn:
        row = await (await conn.execute(sql.SQL("SELECT count(*) count FROM {}").format(queue_table))).fetchone()
    assert row["count"] == 1
    restarted = RepoCreationService(service.repository, service.credentials, service.guard)
    assert (await restarted.get(proposal.id)).status == "approved"


async def test_failed_enqueue_rolls_back_approval_and_rejection_never_enqueues(creation):
    service, prefix, queue_table = creation
    proposal = await service.propose(request(prefix))
    real_enqueue = service.enqueue
    async def failing(conn, proposal_id):
        await real_enqueue(conn, proposal_id)
        raise RuntimeError("Synthetic queue failure")
    service.enqueue = failing
    with pytest.raises(RuntimeError):
        await service.decide(proposal.id, decision(proposal))
    current = await service.get(proposal.id)
    assert current.status == "proposed" and current.revision == 0 and current.approved_at is None
    rejected = await service.decide(proposal.id, decision(current, "reject"))
    assert rejected.status == "rejected"
    assert (await service.execute(proposal.id)).status == "rejected"
    async with service.repository.connection() as conn:
        row = await (await conn.execute(sql.SQL("SELECT count(*) count FROM {}").format(queue_table))).fetchone()
    assert row["count"] == 0


async def test_concurrent_execution_posts_once_and_recovers_the_persisted_receipt(creation):
    service, prefix, _ = creation
    proposal = await service.propose(request(prefix))
    await service.decide(proposal.id, decision(proposal))
    started, release = asyncio.Event(), asyncio.Event()
    posts = []
    async def respond(request):
        if request.method == "GET":
            return httpx.Response(404)
        posts.append(request)
        started.set()
        await release.wait()
        return httpx.Response(201, json=receipt(full_name=f"fixture/{prefix}"))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        service.client = client
        execution = asyncio.create_task(service.execute(proposal.id))
        await asyncio.wait_for(started.wait(), 10)
        try:
            assert (await service.execute(proposal.id)).status == "executing"
        finally:
            release.set()
        finished = await execution
        assert finished.status == "created" and finished.receipt.id == 42 and len(posts) == 1
        restarted = RepoCreationService(service.repository, service.credentials, service.guard, client=client)
        assert (await restarted.execute(proposal.id)).receipt == finished.receipt
        assert (await restarted.reconcile(proposal.id)).status == "created"
        assert len(posts) == 1


async def test_unknown_post_response_is_not_replayed_or_adopted_on_matching_get(creation):
    service, prefix, _ = creation
    proposal = await service.propose(request(prefix))
    await service.decide(proposal.id, decision(proposal))
    posts = []
    async def respond(request):
        if request.method == "POST":
            posts.append(request)
            raise httpx.ReadTimeout("Synthetic lost response")
        return httpx.Response(200, json=receipt(full_name=f"fixture/{prefix}")) if posts else httpx.Response(404)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        service.client = client
        assert (await service.execute(proposal.id)).status == "reconciliation_required"
        restarted = RepoCreationService(service.repository, service.credentials, service.guard, client=client)
        assert (await restarted.execute(proposal.id)).status == "reconciliation_required"
        reconciled = await restarted.reconcile(proposal.id)
        assert reconciled.status == "reconciliation_required" and reconciled.receipt is None
        assert reconciled.candidate.id == 42 and len(posts) == 1


async def test_crash_after_claim_remains_uncertain_without_a_second_post(creation):
    service, prefix, _ = creation
    proposal = await service.propose(request(prefix))
    await service.decide(proposal.id, decision(proposal))
    claimed, first = await service._claim(proposal.id)
    assert first and claimed.status == "executing"
    with pytest.raises(DomainError) as active:
        await service.reconcile(proposal.id)
    assert active.value.code == "REPOSITORY_EXECUTION_ACTIVE"
    async with service.repository.connection() as conn:
        await conn.execute("UPDATE repository_proposals SET started_at=clock_timestamp()-interval '61 seconds' WHERE id=%s", (proposal.id,))
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(404)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        service.client = client
        assert (await service.execute(proposal.id)).status == "executing"
        reconciled = await service.reconcile(proposal.id)
        assert reconciled.status == "reconciliation_required" and reconciled.error_code == "REPOSITORY_NOT_OBSERVED"
        assert [item.method for item in seen] == ["GET"]
