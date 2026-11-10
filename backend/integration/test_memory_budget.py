"""Work-attributed embedding reservations using real PostgreSQL and a local provider stub."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import SecretStr

from sabre import embeddings as embedding_module
from sabre.artifacts import ArtifactStore
from sabre.embeddings import BudgetedEmbeddings
from sabre.memory import MemoryService
from sabre.models import AgentResult, Budget, DomainError, MemoryItem, Project, Status, WorkOrder, new_id
from sabre.repository import Repository
from sabre.security import SecretGuard
from sabre.settings import Settings
from sabre.workflows import Factory


def provider_embeddings(monkeypatch, repository):
    provider = SimpleNamespace(aembed_query=AsyncMock(return_value=[0.0] * 1536))
    monkeypatch.setattr(embedding_module, "OpenAIEmbeddings", SimpleNamespace(model_validate=lambda values: provider))
    config = SimpleNamespace(model_provider="openai", embedding_model="fixture-embedding", model_api_key=SecretStr("synthetic-embedding-key"),
        model_base_url=None, monthly_budget_usd=1000, embedding_usd_per_million=1)
    return BudgetedEmbeddings(repository, config, SecretGuard()), provider


@pytest.fixture
async def memory_work(monkeypatch):
    dsn = Settings().database_url.get_secret_value()
    repository = Repository(dsn)
    await repository.initialize()
    project = Project(name="Memory budget fixture", repository=f"https://github.com/fixture/{new_id()}", profile="python", gate_commands=[["python", "-m", "unittest"]])
    await repository.create_project(project)
    work = WorkOrder(project_id=project.id, mode="patch", objective="Correct arithmetic behavior", acceptance=["Correct output"],
        budget=Budget(max_cost_usd=1, max_calls=1), idempotency_key=new_id())

    async def no_enqueue(conn, work_id):
        return None

    await repository.admit(work, no_enqueue)
    for commit in ("a" * 40, "b" * 40):
        await repository.create_memory(MemoryItem(project_id=project.id, kind="lesson", content="Arithmetic behavior requirements",
            source_commit=commit, source_work_id=work.id, active=True), [1.0] + [0.0] * 1535)
    usage_ids = []
    for method in ("reserve_usage", "reserve_chat_usage"):
        original = getattr(repository, method)

        def capture_reservation(reserve):
            async def wrapped(*args, **kwargs):
                usage_id = await reserve(*args, **kwargs)
                usage_ids.append(usage_id)
                return usage_id
            return wrapped

        monkeypatch.setattr(repository, method, capture_reservation(original))
    try:
        yield repository, project, work
    finally:
        async with repository.connection() as conn:
            await conn.execute("DELETE FROM model_usage WHERE id=ANY(%s)", (usage_ids,))
            await conn.execute("DELETE FROM work_events WHERE work_id=%s", (work.id,))
            await conn.execute("DELETE FROM notifications WHERE work_id=%s", (work.id,))
            await conn.execute("DELETE FROM memories WHERE project_id=%s", (project.id,))
            await conn.execute("DELETE FROM work_orders WHERE id=%s", (work.id,))
            await conn.execute("DELETE FROM projects WHERE id=%s", (project.id,))


async def test_factory_retrieval_is_attributed_to_work_and_cannot_exceed_its_call_limit(memory_work, monkeypatch):
    repository, project, work = memory_work
    embeddings, provider = provider_embeddings(monkeypatch, repository)
    factory = SimpleNamespace(executor=SimpleNamespace(snapshot=AsyncMock(return_value={"base_commit": "a" * 40, "digest": "b" * 64, "files": []})),
        memory=MemoryService(repository, SecretGuard(), embeddings), team=SimpleNamespace(run=AsyncMock(return_value=AgentResult(accepted=True, summary="Inspected"))),
        project_context=SimpleNamespace(for_role=AsyncMock()), guard=SecretGuard())
    await Factory.role(factory, "analyst", work, project, "Inspect requirements")
    totals = await repository.usage(work.id)
    assert totals["calls"] == 1
    assert work.objective in provider.aembed_query.await_args.args[0]
    assert "Inspect requirements" in provider.aembed_query.await_args.args[0]
    assert totals["tokens"] == len(provider.aembed_query.await_args.args[0].encode()) + 64
    assert float(totals["usd"]) > 0
    with pytest.raises(DomainError) as error:
        await Factory.role(factory, "supervisor", work, project, "Organize tasks")
    assert error.value.code == "BUDGET_EXHAUSTED"
    assert provider.aembed_query.await_count == 1


async def test_budget_block_reports_embedding_reservation_in_work_counters(memory_work, monkeypatch, tmp_path):
    repository, project, work = memory_work
    embeddings, provider = provider_embeddings(monkeypatch, repository)

    class GuardedTeam:
        async def run(self, role, work, project, instruction, memory=None, source_context=None, **kwargs):
            await repository.reserve_usage(work, 100, 0.001, 1000)
            return AgentResult(accepted=True, summary="Should not reach provider after embedding uses the final call")

    snapshot = {"digest": "a" * 64, "base_commit": "b" * 40, "files": [{"path": "app.py", "content": "print('ok')"}]}
    executor = SimpleNamespace(prepare=AsyncMock(), prepare_dependencies=AsyncMock(), snapshot=AsyncMock(return_value=snapshot))
    factory = Factory(repository, GuardedTeam(), executor, object(), object(), ArtifactStore(tmp_path),
        SecretGuard(), MemoryService(repository, SecretGuard(), embeddings), InMemorySaver())
    result = await factory.drive(work.id)
    assert result.status == Status.BLOCKED and result.error_code == "BUDGET_EXHAUSTED"
    assert result.calls_used == 1
    assert result.tokens_used == len(provider.aembed_query.await_args.args[0].encode()) + 64
    assert result.cost_usd == pytest.approx(float((await repository.usage(work.id))["usd"]))
    assert provider.aembed_query.await_count == 1


async def test_zero_api_charge_does_not_require_monthly_spending_authorization(memory_work):
    repository, _, work = memory_work
    await repository.reserve_chat_usage("prior-paid-call", 10, 0.1, 1_000_000)
    with pytest.raises(DomainError) as error:
        await repository.reserve_usage(work, 10, 0.01, 0)
    assert error.value.code == "BUDGET_EXHAUSTED"
    await repository.reserve_usage(work, 10, 0, 0)
    await repository.reserve_chat_usage("subscription-call", 10, 0, 0)
    totals = await repository.usage(work.id)
    assert totals["calls"] == 1 and totals["tokens"] == 10 and float(totals["usd"]) == 0


async def test_task_memory_reader_keeps_scope_and_revocation_after_selection(memory_work):
    repository, project, work = memory_work
    service = MemoryService(repository, SecretGuard())
    selected = await service.context_for_role(project.id, "Broad unrelated objective", "Inspect arithmetic", "a" * 40, work=work)
    assert len(selected) == 1 and selected[0]["kind"] == "lesson"
    value = selected[0]
    reader = service.reader(project.id, "a" * 40)
    assert (await reader(value["id"], value["content_digest"]))["content"] == "Arithmetic behavior requirements"
    for project_id, commit in (("other-project", "a" * 40), (project.id, "b" * 40)):
        with pytest.raises(DomainError) as wrong_scope:
            await service.reader(project_id, commit)(value["id"], value["content_digest"])
        assert wrong_scope.value.code == "MEMORY_NOT_AVAILABLE"
    assert await repository.has_embedded_memory(project.id, "a" * 40)
    await service.update(value["id"], False)
    assert not await repository.has_embedded_memory(project.id, "a" * 40)
    with pytest.raises(DomainError) as revoked:
        await reader(value["id"], value["content_digest"])
    assert revoked.value.code == "MEMORY_NOT_AVAILABLE"
    assert await service.context_for_role(project.id, "Arithmetic", "Inspect arithmetic", "a" * 40, work=work) == []
