import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from integration.test_postgres import fixture_work
from sabre.agent_catalog import SPECIALISTS, AgentCatalogService
from sabre.agent_contracts import AgentDraftSave, AgentRevision
from sabre.models import DomainError, WorkOrder, WorkOrderCreate, new_id
from sabre.operator_contracts import OperatorMessageRequest, OperatorMessageResume
from sabre.operator_conversation import OperatorConversationStore
from sabre.repository import digest
from sabre.security import SecretGuard
from sabre.service import FactoryService

pytest_plugins = ["integration.test_postgres"]


async def test_draft_cas_publication_and_immutable_launch_snapshot(repository):
    repo, _ = repository
    service = AgentCatalogService(repo, SecretGuard())
    initial = await service.get("pm")
    draft = initial.draft.model_copy(deep=True)
    draft.instructions = "Inspect exact requirements and evidence"
    outcomes = await asyncio.gather(*(service.change("pm", AgentDraftSave(expected_revision=initial.revision, definition=draft)) for _ in range(2)), return_exceptions=True)
    assert sum(isinstance(item, DomainError) and item.code == "AGENT_REVISION_CONFLICT" for item in outcomes) == 1
    saved = await service.get("pm")
    assert saved.published.digest == initial.published.digest
    assert (await service.change("pm", AgentRevision(expected_revision=saved.revision), validate=True)).valid
    old_snapshot = (await service.published())["pm"]
    published = await service.change("pm", AgentRevision(expected_revision=saved.revision), publish=True)
    assert published.published.version == initial.published.version + 1
    assert published.published.definition.instructions == draft.instructions
    assert old_snapshot.definition.instructions == initial.published.definition.instructions
    assert len(published.versions) == len(initial.versions) + 1
    restarted = AgentCatalogService(repo, SecretGuard())
    assert (await restarted.get("pm")).published == published.published


async def test_invalid_draft_is_retained_but_cannot_publish_or_change_model_capability(repository):
    repo, _ = repository
    service = AgentCatalogService(repo, SecretGuard())
    entry = await service.get("designer")
    draft = entry.draft.model_copy(deep=True)
    draft.context.visual_review = True
    saved = await service.change("designer", AgentDraftSave(expected_revision=entry.revision, definition=draft))
    assert not saved.validation.valid
    with pytest.raises(DomainError) as error:
        await service.change("designer", AgentRevision(expected_revision=saved.revision), publish=True)
    assert error.value.code == "AGENT_DEFINITION_INVALID"
    assert (await service.get("designer")).published == entry.published


async def test_duplicate_original_admission_reconciles_before_mutable_defaults_or_model_preflight(repository):
    repo, _, prior = await fixture_work(repository)
    request = WorkOrderCreate(**{key: getattr(prior, key) for key in WorkOrderCreate.model_fields})
    request.idempotency_key = new_id()
    work = WorkOrder(**request.model_dump())
    work.admission_request_digest = digest(request.model_dump(mode="json"))
    work.flow_config.repair_cycles = 1  # Effective factory defaults differ from the original implicit launch.
    enqueue = AsyncMock()
    await repo.admit(work, enqueue)
    models = SimpleNamespace(snapshot=AsyncMock(side_effect=AssertionError("Mutable configuration must not be read on replay")))
    service = FactoryService(repo, None, None, SimpleNamespace(model_configuration=models), SecretGuard(), None)
    replayed = await service.submit(request)
    assert replayed.id == work.id and replayed.flow_config.repair_cycles == 1
    models.snapshot.assert_not_awaited()
    enqueue.assert_awaited_once()


async def test_message_admission_pins_manager_definition_once_across_publication_and_resume(repository):
    repo, _ = repository
    guard = SecretGuard()
    catalog = AgentCatalogService(repo, guard)
    store = OperatorConversationStore(repo, guard, AsyncMock())
    request = OperatorMessageRequest(version=1, text="Inspect the factory", idempotency_key=new_id())
    message = await store.admit(request)
    initial = (await store.get(message.id))["data"]["definition"]
    entry = await catalog.get("manager")
    definition = entry.draft.model_copy(deep=True)
    definition.instructions = "Newly published Manager instructions"
    saved = await catalog.change("manager", AgentDraftSave(expected_revision=entry.revision, definition=definition))
    await catalog.change("manager", AgentRevision(expected_revision=saved.revision), publish=True)
    assert (await store.admit(request)).id == message.id
    assert (await store.get(message.id))["data"]["definition"] == initial
    await store.transition(message.id, "blocked", error_code="MODEL_NOT_READY")
    await store.resume(message.id, OperatorMessageResume(version=1, expected_error_code="MODEL_NOT_READY"))
    assert (await store.get(message.id))["data"]["definition"] == initial
    new_message = await store.admit(request.model_copy(update={"idempotency_key": new_id()}))
    assert (await store.get(new_message.id))["data"]["definition"]["definition"]["instructions"] == definition.instructions
    await store.transition(message.id, "completed", reply="Test completed")
    await store.transition(new_message.id, "completed", reply="Test completed")


async def test_initial_published_version_is_persisted_once_across_changed_application_defaults(repository, monkeypatch):
    repo, _ = repository
    catalog = AgentCatalogService(repo, SecretGuard())
    initial = await catalog.get("devops")
    label, capabilities, skills, _ = SPECIALISTS["devops"]
    monkeypatch.setitem(SPECIALISTS, "devops", (label, capabilities, skills, "New defaults in a later application version"))
    reloaded = await AgentCatalogService(repo, SecretGuard()).get("devops")
    assert reloaded.published == initial.published
    assert reloaded.draft.instructions == initial.draft.instructions
    async with repo.connection() as conn:
        history = await (await conn.execute("SELECT data FROM agent_definition_versions WHERE agent_id='devops' ORDER BY version")).fetchall()
    assert history[0]["data"] == initial.published.model_dump(mode="json")
