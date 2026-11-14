from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import SecretStr

from sabre import embeddings as embedding_module
from sabre.embeddings import BudgetedEmbeddings
from sabre.memory import MemoryService
from sabre.models import (
    AgentResult,
    Budget,
    DeliveryEvidence,
    DomainError,
    MemoryCreate,
    Project,
    ProposedBy,
    Status,
    WorkOrder,
)
from sabre.security import SecretGuard
from sabre.workflows import Factory


def embedding_config():
    return SimpleNamespace(model_provider="openai", embedding_model="fixture-embedding",
        model_api_key=SecretStr("synthetic-embedding-key"), model_base_url=None,
        monthly_budget_usd=1000, embedding_usd_per_million=1)


def fixture_work():
    project = Project(name="Fixture", repository="https://github.com/example/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    work = WorkOrder(project_id=project.id, mode="patch", objective="Correct arithmetic behavior", acceptance=["Correct output"],
        budget=Budget(max_cost_usd=1, max_calls=1), idempotency_key="memory-budget-fixture")
    return project, work


def provider_embeddings(monkeypatch, repository):
    provider = SimpleNamespace(aembed_query=AsyncMock(return_value=[0.0] * 1536))
    monkeypatch.setattr(embedding_module, "OpenAIEmbeddings", SimpleNamespace(model_validate=lambda values: provider))
    return BudgetedEmbeddings(repository, embedding_config(), SecretGuard()), provider


async def test_factory_memory_consumes_work_budget_before_another_provider_call(monkeypatch):
    project, work = fixture_work()
    repository = SimpleNamespace(reserve_usage=AsyncMock(side_effect=["usage-1", DomainError("BUDGET_EXHAUSTED", "No call remains")]),
        reserve_chat_usage=AsyncMock(return_value="unscoped-usage"), search_memory=AsyncMock(return_value=[]), has_embedded_memory=AsyncMock(return_value=True))
    embeddings, provider = provider_embeddings(monkeypatch, repository)
    team = SimpleNamespace(run=AsyncMock(return_value=AgentResult(accepted=True, summary="Inspected requirements")))
    factory = SimpleNamespace(executor=SimpleNamespace(snapshot=AsyncMock(return_value={"base_commit": "a" * 40, "digest": "b" * 64, "files": []})),
        memory=MemoryService(repository, SecretGuard(), embeddings), team=team, project_context=SimpleNamespace(for_role=AsyncMock()), guard=SecretGuard())
    await Factory.role(factory, "analyst", work, project, "Inspect requirements")
    with pytest.raises(DomainError) as error:
        await Factory.role(factory, "supervisor", work, project, "Organize tasks")
    assert error.value.code == "BUDGET_EXHAUSTED"
    assert repository.reserve_usage.await_count == 2
    assert repository.reserve_usage.await_args_list[0].args[0] is work
    repository.reserve_chat_usage.assert_not_awaited()
    assert provider.aembed_query.await_count == team.run.await_count == 1


async def test_owner_memory_lookup_keeps_service_and_monthly_reservation(monkeypatch):
    repository = SimpleNamespace(reserve_usage=AsyncMock(), reserve_chat_usage=AsyncMock(return_value="owner-usage"), search_memory=AsyncMock(return_value=[]), has_embedded_memory=AsyncMock(return_value=True))
    embeddings, provider = provider_embeddings(monkeypatch, repository)
    assert await MemoryService(repository, SecretGuard(), embeddings).search("project", "public knowledge", "a" * 40) == []
    repository.reserve_usage.assert_not_awaited()
    repository.reserve_chat_usage.assert_awaited_once()
    assert repository.reserve_chat_usage.await_args.args[3] == embedding_config().monthly_budget_usd
    provider.aembed_query.assert_awaited_once_with("public knowledge")


@pytest.mark.parametrize("status", [Status.COMPLETED, Status.QUEUED, Status.BLOCKED])
async def test_what_the_factory_records_after_delivery_is_lexical_even_when_the_embedding_budget_is_exhausted(status):
    project, work = fixture_work()
    work.status, work.calls_used = status, 1
    work.evidence = DeliveryEvidence(commit="a" * 40, snapshot_digest="b" * 64, profile_digest="c" * 64,
        rules_version="fixture", gates=[], findings=[], review="Reviewed")
    repository = SimpleNamespace(work=AsyncMock(return_value=work), create_memory=AsyncMock(side_effect=lambda item, embedding: item))
    embeddings = SimpleNamespace(aembed_query=AsyncMock(side_effect=DomainError("BUDGET_EXHAUSTED", "No paid operation is allowed after delivery")))
    request = MemoryCreate(project_id=project.id, kind="lesson", content="Repair lesson: the check failed until the total was rounded",
        source_commit=work.evidence.commit, source_work_id=work.id, evidence_digest=work.evidence.snapshot_digest, scope="project")
    stored = await MemoryService(repository, SecretGuard(), embeddings).propose(request, proposed_by=ProposedBy(channel="factory", role="repair", work_id=work.id))
    # Consolidation makes no paid request, and its lesson waits for the owner like any other record.
    assert not stored.active
    embeddings.aembed_query.assert_not_awaited()
    assert repository.create_memory.await_args.args[1] is None


async def test_an_owner_proposal_against_a_delivery_is_embedded_and_waits_for_approval():
    project, work = fixture_work()
    work.status = Status.COMPLETED
    work.evidence = DeliveryEvidence(commit="a" * 40, snapshot_digest="b" * 64, profile_digest="c" * 64,
        rules_version="fixture", gates=[], findings=[], review="Reviewed")
    repository = SimpleNamespace(work=AsyncMock(return_value=work), create_memory=AsyncMock(side_effect=lambda item, embedding: item))
    embeddings = SimpleNamespace(aembed_query=AsyncMock(return_value=[0.0] * 1536))
    request = MemoryCreate(project_id=project.id, kind="fact", content="Totals are rounded half even", source_commit=work.evidence.commit,
        source_work_id=work.id, evidence_digest=work.evidence.snapshot_digest)
    stored = await MemoryService(repository, SecretGuard(), embeddings).propose(request, proposed_by=ProposedBy(channel="owner_console"))
    assert not stored.active
    embeddings.aembed_query.assert_awaited_once()


async def test_embedding_provider_failure_keeps_reservation_and_hides_registered_key(monkeypatch):
    secret = "synthetic-private-role-gateway-key"
    repository = SimpleNamespace(reserve_chat_usage=AsyncMock(return_value="reserved-usage"))
    embeddings, provider = provider_embeddings(monkeypatch, repository)
    embeddings.guard = SecretGuard([secret])
    provider.aembed_query.side_effect = RuntimeError(secret)
    with pytest.raises(DomainError) as error:
        await embeddings.aembed_query("public query")
    assert error.value.code == "EMBEDDING_PROVIDER_FAILED"
    assert secret not in str(error.value)
    assert error.value.__context__ is None and error.value.__cause__ is None
    repository.reserve_chat_usage.assert_awaited_once()


async def test_owner_lesson_proposal_keeps_embedding_and_requires_review():
    project, work = fixture_work()
    work.status = Status.COMPLETED
    work.evidence = DeliveryEvidence(commit="a" * 40, snapshot_digest="b" * 64, profile_digest="c" * 64,
        rules_version="fixture", gates=[], findings=[], review="Reviewed")
    repository = SimpleNamespace(work=AsyncMock(return_value=work), create_memory=AsyncMock(side_effect=lambda item, embedding: item))
    vector = [0.0] * 1536
    embeddings = SimpleNamespace(aembed_query=AsyncMock(return_value=vector))
    request = MemoryCreate(project_id=project.id, kind="lesson", content="Preserve compatibility with empty input", source_commit=work.evidence.commit, source_work_id=work.id)
    stored = await MemoryService(repository, SecretGuard(), embeddings).propose(request)
    assert not stored.active
    embeddings.aembed_query.assert_awaited_once_with(request.content)
    assert repository.create_memory.await_args.args[1] == vector
