"""Required integration checks; run explicitly against SABRE's private PostgreSQL service."""

import asyncio
from contextlib import AsyncExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from mcp import Client
from psycopg import sql
from pydantic import SecretStr

from sabre.api import create_app
from sabre.artifacts import ArtifactStore
from sabre.mcp_server import build_mcp
from sabre.memory import MemoryService, verified_fact
from sabre.models import (
    Answer,
    Budget,
    DeliveryEvidence,
    DomainError,
    MemoryCreate,
    Project,
    ScopeChange,
    Status,
    Task,
    WorkOrder,
    new_id,
)
from sabre.owner_confirmations import ConfirmationDecision
from sabre.repository import Repository, digest
from sabre.security import SecretGuard
from sabre.service import FactoryService
from sabre.settings import Settings
from sabre.workflows import Factory
from tests.test_factory_workflow import TestExecutor, TestMemory, TestPublisher, TestSecurity, TestTeam


@pytest.fixture
async def repository():
    dsn = Settings().database_url.get_secret_value()
    repository = Repository(dsn)
    await repository.initialize()
    created = []
    yield repository, created
    for project_id in created:
        async with repository.connection() as conn:
            works = await (await conn.execute("SELECT id FROM work_orders WHERE project_id=%s", (project_id,))).fetchall()
            for work in works:
                for table in ("notifications", "work_events", "model_usage", "security_reports", "security_exceptions", "memories"):
                    column = "source_work_id" if table == "memories" else "work_id"
                    if table == "memories":
                        await conn.execute("DELETE FROM memories WHERE project_id=%s", (project_id,))
                    else:
                        await conn.execute(sql.SQL("DELETE FROM {} WHERE {}=%s").format(sql.Identifier(table), sql.Identifier(column)), (work["id"],))
            await conn.execute("DELETE FROM work_orders WHERE project_id=%s", (project_id,))
            await conn.execute("DELETE FROM projects WHERE id=%s", (project_id,))


async def fixture_work(repository):
    repo, created = repository
    project = Project(name="Integration fixture", repository=f"https://github.com/fixture/{new_id()}", profile="python", gate_commands=[["python", "-m", "unittest"]])
    await repo.create_project(project)
    created.append(project.id)
    work = WorkOrder(project_id=project.id, mode="patch", objective="Correct fixture behavior", acceptance=["Correct output"], budget=Budget(max_cost_usd=10), idempotency_key=new_id())

    async def enqueue(conn, work_id):
        await conn.execute("INSERT INTO work_events(id,work_id,kind,message) VALUES(%s,%s,'admitted','Atomic test enqueue')", (new_id(), work_id))

    await repo.admit(work, enqueue)
    return repo, project, work


async def test_admission_rolls_back_if_enqueue_fails(repository):
    repo, project, work = await fixture_work(repository)
    failed = work.model_copy(update={"id": new_id(), "idempotency_key": new_id()})

    async def fail(conn, work_id):
        raise RuntimeError("Queue insertion failed")

    with pytest.raises(RuntimeError):
        await repo.admit(failed, fail)
    with pytest.raises(DomainError) as missing:
        await repo.work(failed.id)
    assert missing.value.code == "WORK_NOT_FOUND"


async def test_same_key_reuses_identical_request_and_rejects_changed_request(repository):
    repo, project, work = await fixture_work(repository)

    async def should_not_enqueue(conn, work_id):
        pytest.fail("An admitted request must not enqueue twice")

    duplicate = work.model_copy(update={"id": new_id()})
    assert (await repo.admit(duplicate, should_not_enqueue)).id == work.id
    with pytest.raises(DomainError) as conflict:
        await repo.admit(duplicate.model_copy(update={"objective": "Different objective"}), should_not_enqueue)
    assert conflict.value.code == "IDEMPOTENCY_CONFLICT"


async def test_effect_lookup_preserves_binding_and_rejects_changed_retry(repository):
    repo, _ = repository
    key = f"{new_id()}/1/publish"
    request = {"repo": "owner/fixture", "branch": "sabre/legacy/r1", "commit": "a" * 40}
    result = {"branch": request["branch"], "pr_url": "https://github.com/owner/fixture/pull/1", "commit": request["commit"]}
    try:
        assert await repo.get_effect(key) is None
        await repo.begin_effect(key, request)
        recovered = Repository(repo.dsn)
        pending = await recovered.get_effect(key)
        assert pending["request_hash"] == digest(request)
        assert pending["state"] == "pending"
        with pytest.raises(DomainError) as conflict:
            await recovered.begin_effect(key, {**request, "branch": "fix/fixture"})
        assert conflict.value.code == "EFFECT_CONFLICT"
        assert await repo.get_effect(key) == pending
        await recovered.finish_effect(key, result)
        completed = await repo.get_effect(key)
        assert completed["request_hash"] == pending["request_hash"]
        assert completed["state"] == "completed"
        assert completed["result"] == result
    finally:
        async with repo.connection() as conn:
            await conn.execute("DELETE FROM effects WHERE operation_key=%s", (key,))


async def test_persistent_checkpoint_recovers_pending_hitl_after_connections_close(repository, tmp_path):
    repo, project, work = await fixture_work(repository)
    guard = SecretGuard()

    def factory(saver, ask):
        executor = TestExecutor()
        executor.prepared = True
        return Factory(repo, TestTeam(ask), executor, TestSecurity(), TestPublisher(), ArtifactStore(tmp_path), guard, TestMemory(), saver)

    async with AsyncPostgresSaver.from_conn_string(repo.dsn) as first_saver:
        await first_saver.setup()
        first = await factory(first_saver, True).drive(work.id)
    assert first.status == Status.WAITING_INPUT
    question = first.questions[0]

    async def enqueue(conn, work_id):
        await conn.execute("INSERT INTO work_events(id,work_id,kind,message) VALUES(%s,%s,'response','Resume requested')", (new_id(), work_id))

    answer = Answer(question_id=question.id, plan_revision=1, answer="Preserve compatibility")
    results = await asyncio.gather(repo.answer(work.id, answer.model_dump(), enqueue), repo.answer(work.id, answer.model_dump(), enqueue), return_exceptions=True)
    assert sum(isinstance(r, DomainError) for r in results) == 1
    async with AsyncPostgresSaver.from_conn_string(repo.dsn) as recovered_saver:
        recovered = await factory(recovered_saver, False).drive(work.id)
        assert recovered.status == Status.COMPLETED
        assert recovered.questions[0].answer == answer.answer
        await recovered_saver.adelete_thread(work.id)


async def test_budget_reservation_is_atomic(repository):
    repo, project, work = await fixture_work(repository)
    work.budget.max_calls = 1
    results = await asyncio.gather(repo.reserve_usage(work, 100, 0.01, 1000), repo.reserve_usage(work, 100, 0.01, 1000), return_exceptions=True)
    assert sum(isinstance(r, DomainError) for r in results) == 1
    assert (await repo.usage(work.id))["calls"] == 1


@pytest.mark.parametrize("checkpoint_usage", [(1, 120, 0.0012), (2, 1200, 0.012)], ids=["older-counts", "settled-reservation"])
async def test_resume_projects_ledger_usage_before_entering_agent(repository, tmp_path, checkpoint_usage):
    repo, project, work = await fixture_work(repository)
    settled = await repo.reserve_usage(work, 900, 0.009, 1000)
    await repo.settle_usage(settled, 120, 0.0012)
    await repo.reserve_usage(work, 300, 0.003, 1000)
    work.status, work.phase = Status.PAUSED, "implementation"
    work.tasks = [Task(id="preserved-task", title="Continue the same product task")]
    work.calls_used, work.tokens_used, work.cost_usd = 2, 420, 0.0042
    await repo.save(work)
    checkpoint_work = work.model_copy(deep=True)
    checkpoint_work.calls_used, checkpoint_work.tokens_used, checkpoint_work.cost_usd = checkpoint_usage
    observations = []

    async def observe_then_stop(role, current, *args, **kwargs):
        observations.extend([current, await repo.work(work.id)])
        raise DomainError("SYNTHETIC_STOP", "Stop after observing the running projection")

    async with repo.connection() as conn:
        ledger_before = await (await conn.execute("SELECT * FROM model_usage WHERE work_id=%s ORDER BY id", (work.id,))).fetchall()
    async with AsyncPostgresSaver.from_conn_string(repo.dsn) as saver:
        await saver.setup()
        team = TestTeam()
        team.run = observe_then_stop
        factory = Factory(repo, team, TestExecutor(), TestSecurity(), TestPublisher(), ArtifactStore(tmp_path), SecretGuard(), TestMemory(), saver)
        try:
            await factory.graph.aupdate_state(factory.config(work.id), {"order": checkpoint_work.model_dump(mode="json")}, as_node="plan")
            await repo.resume(work.id, AsyncMock())
            result = await factory.drive(work.id)
        finally:
            await saver.adelete_thread(work.id)
    assert result.error_code == "SYNTHETIC_STOP" and len(observations) == 2
    for observed in observations:
        assert (observed.calls_used, observed.tokens_used, observed.cost_usd) == pytest.approx((2, 420, 0.0042))
        assert observed.status == Status.RUNNING and observed.phase == "implementation"
        assert observed.id == work.id and observed.plan_revision == work.plan_revision
        assert observed.tasks[0].id == "preserved-task" and observed.budget == work.budget
    async with repo.connection() as conn:
        ledger_after = await (await conn.execute("SELECT * FROM model_usage WHERE work_id=%s ORDER BY id", (work.id,))).fetchall()
    assert ledger_after == ledger_before


def budget_control(repo):
    service = FactoryService(repo, None, None, None, SecretGuard(), None)
    config = SimpleNamespace(auth_token=SecretStr("synthetic-owner-control-token"),
        gateway_token=SecretStr("synthetic-gateway-control-token"), allowed_origins=["http://localhost:8000"])
    return service, create_app(service, config)


@pytest.mark.parametrize("limit,old,new,later,ceiling", [("tokens", 1000, 2000, 2500, 10000000), ("calls", 40, 50, 60, 500)])
async def test_budget_control_requires_owner_and_cas_preserves_usage_and_other_limits(repository, limit, old, new, later, ceiling):
    repo, project, work = await fixture_work(repository)
    work.status, work.error_code = Status.BLOCKED, "BUDGET_EXHAUSTED"
    work.budget = Budget(max_calls=40, max_tokens=1000, max_cost_usd=0, active_seconds=1800)
    await repo.reserve_usage(work, 900, 0, 0)
    work.calls_used, work.tokens_used, work.active_seconds_used = 1, 900, 12.5
    work.tasks = [Task(id="pending-product-task", title="Continue product work")]
    await repo.save(work)
    service, app = budget_control(repo)
    field, other_field = f"max_{limit}", "max_calls" if limit == "tokens" else "max_tokens"
    path = f"/api/v1/work/{work.id}/budget/{limit}"
    body = {"expected_revision": 1, f"expected_{field}": old, field: new}
    owner = {"Authorization": "Bearer synthetic-owner-control-token"}
    gateway = {"Authorization": "Bearer synthetic-gateway-control-token"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        assert (await client.post(path, json=body)).status_code == 401
        assert (await client.post(path, headers=gateway, json=body)).status_code == 401
        assert (await client.post("/mcp/", headers=gateway, json={})).status_code == 401
        for invalid in [body | {field: old}, body | {field: old - 1}, body | {field: str(new)}, body | {field: ceiling + 1}, body | {other_field: 50}]:
            assert (await client.post(path, headers=owner, json=invalid)).status_code == 422
        responses = await asyncio.gather(client.post(path, headers=owner, json=body), client.post(path, headers=owner, json=body))
        assert sorted(response.status_code for response in responses) == [200, 409]
    persisted = await repo.work(work.id)
    assert getattr(persisted.budget, field) == new
    assert persisted.budget.model_dump(exclude={field}) == work.budget.model_dump(exclude={field})
    assert persisted.model_dump(exclude={"budget", "summary", "updated_at"}) == work.model_dump(exclude={"budget", "summary", "updated_at"})
    assert (await repo.usage(work.id))["tokens"] == 900 and await repo.pending_scope(work.id) is None
    async with Client(build_mcp(lambda: service)) as client:
        tool = f"sabre_increase_{limit[:-1]}_budget"
        filed = await client.call_tool(tool, {"work_id": work.id, "change": body | {f"expected_{field}": new, field: later}})
        assert not filed.is_error and filed.structured_content["state"] == "pending"
        replay = await client.call_tool(tool, {"work_id": work.id, "change": body})
        assert not replay.is_error and replay.structured_content["state"] == "pending"
    # An MCP request alone changes nothing; the owner's confirmation applies it with the same checks.
    assert getattr((await repo.work(work.id)).budget, field) == new
    confirmations = service.owner_confirmations()

    def decision(item):
        return ConfirmationDecision(version=1, request_digest=item["request_digest"])

    confirmed = await confirmations.confirm(filed.structured_content["id"], decision(filed.structured_content))
    assert confirmed.state == "applied"
    persisted = await repo.work(work.id)
    assert getattr(persisted.budget, field) == later and (await repo.usage(work.id))["tokens"] == 900
    stale = await confirmations.confirm(replay.structured_content["id"], decision(replay.structured_content))
    assert stale.state == "failed" and stale.error_code
    assert getattr((await repo.work(work.id)).budget, field) == later
    events = [event for event in await repo.events(work.id) if event["kind"] == "budget_increased"]
    assert len(events) == 2 and f"{old} → {new}" in events[0]["message"] and f"{new} → {later}" in events[1]["message"]


@pytest.mark.parametrize("case", ["queued", "running", "waiting_input", "completed", "cancelled", "cancel_pending", "stale_revision"])
@pytest.mark.parametrize("limit", ["tokens", "calls"])
async def test_budget_control_rejects_wrong_state_or_revision_without_mutation(repository, case, limit):
    repo, project, work = await fixture_work(repository)
    work.status = Status.BLOCKED if case in {"cancel_pending", "stale_revision"} else Status(case)
    await repo.save(work)
    if case == "cancel_pending":
        await repo.request_control(work.id, "cancel")
    before = await repo.work(work.id)
    field = f"max_{limit}"
    old = getattr(work.budget, field)
    _, app = budget_control(repo)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        response = await client.post(f"/api/v1/work/{work.id}/budget/{limit}", headers={"Authorization": "Bearer synthetic-owner-control-token"},
            json={"expected_revision": 2 if case == "stale_revision" else 1, f"expected_{field}": old, field: old + 1})
    assert response.status_code == 409
    assert await repo.work(work.id) == before
    assert not any(event["kind"] == "budget_increased" for event in await repo.events(work.id))


@pytest.mark.parametrize("limit", ["tokens", "calls"])
async def test_budget_resume_uses_owner_limit_without_rewriting_checkpoint_or_refunding_reservations(repository, tmp_path, limit):
    repo, project, work = await fixture_work(repository)
    work.status, work.phase = Status.PAUSED, "implementation"
    work.budget = Budget(max_calls=1 if limit == "calls" else 40, max_tokens=2000 if limit == "calls" else 1000, max_cost_usd=0, active_seconds=1800)
    field = f"max_{limit}"
    old = getattr(work.budget, field)
    new = old + (1 if limit == "calls" else 1000)
    work.tasks = [Task(id="same-product-task", title="Continue the same product task")]
    await repo.reserve_usage(work, 900, 0, 0)
    work.calls_used, work.tokens_used = 1, 900
    await repo.save(work)
    async with AsyncPostgresSaver.from_conn_string(repo.dsn) as saver:
        await saver.setup()
        team, executor = TestTeam(), TestExecutor()
        factory = Factory(repo, team, executor, TestSecurity(), TestPublisher(), ArtifactStore(tmp_path), SecretGuard(), TestMemory(), saver)
        await factory.graph.aupdate_state(factory.config(work.id), {"order": work.model_dump(mode="json")}, as_node="plan")
        before = await factory.graph.aget_state(factory.config(work.id))
        _, app = budget_control(repo)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
            response = await client.post(f"/api/v1/work/{work.id}/budget/{limit}", headers={"Authorization": "Bearer synthetic-owner-control-token"},
                json={"expected_revision": 1, f"expected_{field}": old, field: new})
            assert response.status_code == 200
        unchanged = await factory.graph.aget_state(factory.config(work.id))
        assert unchanged.config == before.config and unchanged.values == before.values

        async def reserve_then_stop(role, current, *args, **kwargs):
            assert role == "developer" and getattr(current.budget, field) == new
            assert current.id == work.id and current.plan_revision == 1 and current.tasks[0].id == "same-product-task"
            await repo.reserve_usage(current, 200, 0, 0)
            raise DomainError("SYNTHETIC_STOP", "Stop after observing the preserved reservation")

        team.run = reserve_then_stop
        await repo.resume(work.id, AsyncMock())
        result = await factory.drive(work.id)
        assert result.error_code == "SYNTHETIC_STOP" and getattr(result.budget, field) == new
        assert result.calls_used == 2 and result.tokens_used == 1100
        assert result.budget.model_dump(exclude={field}) == work.budget.model_dump(exclude={field})
        async with repo.connection() as conn:
            rows = await (await conn.execute("SELECT reserved_tokens,actual_tokens FROM model_usage WHERE work_id=%s ORDER BY created_at", (work.id,))).fetchall()
        assert rows == [{"reserved_tokens": 900, "actual_tokens": None}, {"reserved_tokens": 200, "actual_tokens": None}]
        await saver.adelete_thread(work.id)


async def test_scope_revision_returns_persisted_paused_receipt_without_broker_or_rebilling(repository):
    repo, project, work = await fixture_work(repository)
    reservation = await repo.reserve_usage(work, 200, 0.01, 1000)
    await repo.settle_usage(reservation, 120, 0.005)
    await repo.reserve_usage(work, 300, 0.02, 1000)
    work.status, work.phase = Status.BLOCKED, "implementation"
    work.calls_used, work.tokens_used, work.cost_usd, work.active_seconds_used = 2, 420, 0.025, 12.5
    work.tasks = [Task(title="Old task")]
    await repo.save(work)
    forbidden = AsyncMock(side_effect=AssertionError("Scope admission must not invoke the broker"))
    service = FactoryService(repo, SimpleNamespace(executor=SimpleNamespace(cleanup=forbidden)), None, None, SecretGuard(), None)
    change = ScopeChange(expected_revision=1, objective="Implement only product changes", acceptance=work.acceptance)
    response = await service.change_scope(work.id, change)
    persisted = await Repository(repo.dsn).work(work.id)
    assert response == persisted
    assert persisted.status == Status.PAUSED and persisted.phase == "intake" and persisted.plan_revision == 2
    assert persisted.id == work.id and persisted.idempotency_key == work.idempotency_key and persisted.budget == work.budget
    assert (persisted.calls_used, persisted.tokens_used, persisted.cost_usd, persisted.active_seconds_used) == (2, 420, 0.025, 12.5)
    assert persisted.tasks == [] and await repo.pending_scope(work.id) == 2
    assert (await repo.usage(work.id))["tokens"] == 420
    forbidden.assert_not_awaited()
    with pytest.raises(DomainError) as stale:
        await service.change_scope(work.id, change)
    assert stale.value.code == "STALE_PLAN"
    assert len([event for event in await repo.events(work.id) if event["kind"] == "scope_changed"]) == 1


@pytest.mark.parametrize("failure_point", ["before_checkpoint", "after_checkpoint", "after_ack"])
async def test_scope_revision_recovers_same_revision_across_checkpoint_admission_gap(repository, tmp_path, monkeypatch, failure_point):
    repo, project, work = await fixture_work(repository)
    work.status, work.phase = Status.BLOCKED, "implementation"
    work.tasks = [Task(id="old-task", title="Never execute the superseded task")]
    await repo.save(work)

    def factory(saver, current_repo):
        return Factory(current_repo, TestTeam(), TestExecutor(), TestSecurity(), TestPublisher(), ArtifactStore(tmp_path), SecretGuard(), TestMemory(), saver)

    async with AsyncPostgresSaver.from_conn_string(repo.dsn) as saver:
        await saver.setup()
        first = factory(saver, repo)
        await first.graph.aupdate_state(first.config(work.id), {"order": work.model_dump(mode="json")}, as_node="plan")
        service = FactoryService(repo, first, None, None, SecretGuard(), None)
        await service.change_scope(work.id, ScopeChange(expected_revision=1, objective="Implement revised product changes", acceptance=work.acceptance))
        assert (await first.drive(work.id)).status == Status.PAUSED
        assert first.team.calls == [] and not first.executor.prepared
        await repo.resume(work.id, AsyncMock())
        with monkeypatch.context() as patch:
            if failure_point == "after_ack":
                acknowledge = repo.acknowledge_scope

                async def lost_ack(*args):
                    await acknowledge(*args)
                    raise RuntimeError("Synthetic scope interruption")

                patch.setattr(repo, "acknowledge_scope", lost_ack)
            else:
                target, name = (first.graph, "aupdate_state") if failure_point == "before_checkpoint" else (repo, "acknowledge_scope")
                patch.setattr(target, name, AsyncMock(side_effect=RuntimeError("Synthetic scope interruption")))
            with pytest.raises(RuntimeError, match="Synthetic scope interruption"):
                await first.drive(work.id)
        assert await repo.pending_scope(work.id) == (None if failure_point == "after_ack" else 2)
        assert first.team.calls == [] and not first.executor.prepared
        if failure_point != "before_checkpoint":
            pending = await first.graph.aget_state(first.config(work.id))
            assert pending.next == ("intake",) and pending.values["reset_workspace"] is True
    async with AsyncPostgresSaver.from_conn_string(repo.dsn) as saver:
        recovered = factory(saver, Repository(repo.dsn))
        result = await recovered.drive(work.id)
        assert result.status == Status.COMPLETED and result.id == work.id and result.plan_revision == 2
        assert recovered.team.calls == ["analyst", "supervisor", "developer", "qa", "reviewer"]
        assert all(task.id != "old-task" for task in result.tasks)
        assert await repo.pending_scope(work.id) is None
        saved = await recovered.graph.aget_state(recovered.config(work.id))
        assert saved.values["reset_workspace"] is False
        await saver.adelete_thread(work.id)


@pytest.mark.parametrize("outcome", ["failure", "cancel"])
async def test_scope_revision_preparation_failure_or_cancellation_never_reaches_agents(repository, tmp_path, outcome):
    repo, project, work = await fixture_work(repository)
    work.status = Status.BLOCKED
    await repo.save(work)
    async with AsyncPostgresSaver.from_conn_string(repo.dsn) as saver:
        await saver.setup()
        executor, team = TestExecutor(), TestTeam()

        async def prepare_dependencies(work_id):
            if outcome == "cancel":
                await repo.request_control(work_id, "cancel")
            else:
                raise DomainError("DEPENDENCY_PREPARATION_FAILED", "Synthetic preparation failure")

        executor.prepare_dependencies = prepare_dependencies
        factory = Factory(repo, team, executor, TestSecurity(), TestPublisher(), ArtifactStore(tmp_path), SecretGuard(), TestMemory(), saver)
        service = FactoryService(repo, factory, None, None, SecretGuard(), None)
        await service.change_scope(work.id, ScopeChange(expected_revision=1, objective="Implement revised behavior", acceptance=work.acceptance))
        await repo.resume(work.id, AsyncMock())
        result = await factory.drive(work.id)
        assert result.status == (Status.CANCELLED if outcome == "cancel" else Status.BLOCKED)
        assert result.plan_revision == 2 and team.calls == []
        assert (await repo.usage(work.id))["calls"] == 0
        if outcome == "failure":
            saved = await factory.graph.aget_state(factory.config(work.id))
            assert saved.next == ("intake",) and saved.values["reset_workspace"] is True
        await saver.adelete_thread(work.id)


async def test_repository_lock_and_global_two_execution_limit(repository):
    repo, project, work = await fixture_work(repository)
    async with AsyncExitStack() as stack:
        assert await stack.enter_async_context(repo.project_lock(project.id))
        assert not await stack.enter_async_context(repo.project_lock(project.id))
        assert await stack.enter_async_context(repo.project_lock(new_id()))
        assert not await stack.enter_async_context(repo.project_lock(new_id()))
        assert await stack.enter_async_context(repo.project_lock(new_id(), execution_slot=False))


async def test_resume_and_answer_roll_back_if_enqueue_fails(repository):
    repo, project, work = await fixture_work(repository)
    work.status = Status.PAUSED
    await repo.save(work)
    await repo.command(work.id, "pause")

    async def fail(conn, work_id):
        raise RuntimeError("Queue unavailable")

    with pytest.raises(RuntimeError):
        await repo.resume(work.id, fail)
    assert (await repo.work(work.id)).status == Status.PAUSED
    assert await repo.control(work.id) == "pause"
    from sabre.models import HumanQuestion
    work.status = Status.WAITING_INPUT
    work.questions = [HumanQuestion(work_id=work.id, plan_revision=1, prompt="¿Qué salida?", kind="clarification")]
    await repo.save(work)
    with pytest.raises(RuntimeError):
        await repo.answer(work.id, {"question_id": work.questions[0].id, "plan_revision": 1, "answer": "Cero"}, fail)
    assert await repo.pending_answer(work.id) is None
    assert (await repo.work(work.id)).questions[0].answer is None


async def test_memory_provenance_approval_invalidation_and_hybrid_project_scope(repository):
    repo, project, work = await fixture_work(repository)
    work.status = Status.COMPLETED
    work.evidence = DeliveryEvidence(commit="b" * 40, snapshot_digest="a" * 64, profile_digest="c" * 64,
        rules_version="test", gates=[], findings=[], review="Reviewed")
    await repo.save(work)
    service = MemoryService(repo, SecretGuard())
    request = MemoryCreate(project_id=project.id, kind="lesson", content="Compatibility requires retaining empty input behavior",
        source_commit=work.evidence.commit, source_work_id=work.id)
    pending = await service.propose(request)
    assert not pending.active
    assert await service.search(project.id, "Compatibility", work.evidence.commit) == []
    approved = await service.update(pending.id, True)
    assert approved.active
    assert (await service.propose(request)).active
    assert len(await service.search(project.id, "Compatibility", work.evidence.commit)) == 1
    assert await service.search(project.id, "Compatibility", "d" * 40) == []
    assert await service.search("another-project", "Compatibility", work.evidence.commit) == []
    # Lexical knowledge without an embedding still participates in hybrid retrieval.
    vector = [1.0] + [0.0] * 1535
    assert len(await repo.search_memory(project.id, "Compatibility", work.evidence.commit, vector)) == 1
    await service.update(pending.id, False)
    assert not (await service.propose(request)).active
    with pytest.raises(DomainError, match="invalidated"):
        await service.update(pending.id, True)
    assert await service.search(project.id, "Compatibility", work.evidence.commit) == []
    fact = await service.propose(request.model_copy(update={"kind": "fact", "content": verified_fact(work), "evidence_digest": work.evidence.snapshot_digest}))
    assert fact.active
    with pytest.raises(DomainError) as wrong:
        await service.propose(request.model_copy(update={"source_commit": "e" * 40}))
    assert wrong.value.code == "MEMORY_PROVENANCE"


async def test_cancel_does_not_overwrite_new_progress_or_clean_an_active_writer(repository):
    repo, project, work = await fixture_work(repository)
    original = repo.work
    first_read = True
    cleaned = []

    async def concurrent_progress(work_id):
        nonlocal first_read
        stale = await original(work_id)
        if first_read:
            first_read = False
            updated = stale.model_copy(deep=True)
            updated.status, updated.summary = Status.RUNNING, "New progress from the worker"
            await repo.save(updated)
        return stale

    async def cleanup(work_id):
        cleaned.append(work_id)

    repo.work = concurrent_progress
    service = FactoryService(repo, SimpleNamespace(executor=SimpleNamespace(cleanup=cleanup)), None, None, SecretGuard(), None)
    async with repo.project_lock(project.id) as held:
        assert held
        response = await service.control(work.id, "cancel")
        assert response.status == Status.RUNNING
        assert response.summary == "New progress from the worker"
        assert response.control == "cancel"
        assert cleaned == []
    cancelled = await service.control(work.id, "cancel")
    assert cancelled.status == Status.CANCELLED
    assert cleaned == [work.id]


async def test_idle_cancel_of_a_blocked_run_keeps_evidence_and_records_one_event(repository):
    repo, project, work = await fixture_work(repository)
    work.status, work.error_code, work.limiting_metric = Status.BLOCKED, "BUDGET_EXHAUSTED", "tokens"
    work.summary = "The budget does not allow another model call"
    await repo.save(work)
    cleaned = []

    async def cleanup(work_id):
        cleaned.append(work_id)

    service = FactoryService(repo, SimpleNamespace(executor=SimpleNamespace(cleanup=cleanup)), None, None, SecretGuard(), None)
    cancelled = await service.control(work.id, "cancel")
    assert cancelled.status == Status.CANCELLED and cancelled.summary == "Work order cancelled"
    assert (cancelled.error_code, cancelled.limiting_metric) == ("BUDGET_EXHAUSTED", "tokens")
    assert [event["kind"] for event in await repo.events(work.id)].count("cancelled") == 1
    with pytest.raises(DomainError) as closed:
        await service.control(work.id, "cancel")
    assert closed.value.code == "WORK_TERMINAL"
    assert [event["kind"] for event in await repo.events(work.id)].count("cancelled") == 1


async def test_a_cancel_requested_while_another_run_holds_the_project_is_applied_when_that_run_releases_it(repository):
    repo, project, blocked = await fixture_work(repository)
    blocked.status, blocked.error_code, blocked.summary = Status.BLOCKED, "SECRET_DETECTED", "Content containing a possible credential was blocked"
    await repo.save(blocked)
    running = WorkOrder(project_id=project.id, mode="patch", objective="Second run of the project", acceptance=["Correct output"], budget=Budget(max_cost_usd=10), idempotency_key=new_id())
    waiting = WorkOrder(project_id=project.id, mode="patch", objective="Third run of the project", acceptance=["Correct output"], budget=Budget(max_cost_usd=10), idempotency_key=new_id())

    async def enqueue(conn, work_id):
        return None

    for order in (running, waiting):
        await repo.admit(order, enqueue)
    running.status, waiting.status = Status.RUNNING, Status.WAITING_INPUT
    await repo.save(running)
    await repo.save(waiting)
    cleaned = []

    async def cleanup(work_id):
        cleaned.append(work_id)

    executor = SimpleNamespace(cleanup=cleanup)
    service = FactoryService(repo, SimpleNamespace(executor=executor), None, None, SecretGuard(), None)
    factory = SimpleNamespace(repository=repo, executor=executor)
    async with Factory.project_run(factory, running) as acquired:
        assert acquired
        # The owner's requests arrive while the project is busy: recorded, not applied.
        assert (await service.control(blocked.id, "cancel")).status == Status.BLOCKED
        assert (await service.control(waiting.id, "pause")).status == Status.WAITING_INPUT
        assert (await service.control(running.id, "pause")).status == Status.RUNNING
        assert cleaned == []
    cancelled, paused, still_running = await repo.work(blocked.id), await repo.work(waiting.id), await repo.work(running.id)
    assert cancelled.status == Status.CANCELLED and cancelled.error_code == "SECRET_DETECTED"
    assert paused.status == Status.PAUSED
    assert still_running.status == Status.RUNNING, "the driven run settles its own control at its next boundary"
    assert cleaned == [blocked.id]
    assert [event["kind"] for event in await repo.events(blocked.id)].count("cancelled") == 1
    async with Factory.project_run(factory, running) as acquired:
        assert acquired
    assert cleaned == [blocked.id] and [event["kind"] for event in await repo.events(waiting.id)].count("paused") == 1


async def test_repeated_idle_pause_records_a_single_event(repository):
    repo, project, work = await fixture_work(repository)
    work.status = Status.BLOCKED
    await repo.save(work)
    service = FactoryService(repo, SimpleNamespace(executor=SimpleNamespace(cleanup=AsyncMock())), None, None, SecretGuard(), None)
    assert (await service.control(work.id, "pause")).status == Status.PAUSED
    assert (await service.control(work.id, "pause")).status == Status.PAUSED
    assert [event["kind"] for event in await repo.events(work.id)].count("paused") == 1
