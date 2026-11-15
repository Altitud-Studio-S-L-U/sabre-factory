import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from psycopg import sql

from sabre.console_configuration import (
    ConfigurationSave,
    ConsoleConfigurationService,
    configuration_history_page,
    document,
    pinned_models,
    prepare_run_configuration,
)
from sabre.flows import resolve_flow
from sabre.model_configuration import ModelConfigurationChange, ModelConfigurationService
from sabre.models import Budget, DomainError, WorkOrder, WorkOrderCreate
from sabre.security import SecretGuard
from sabre.settings import Settings

pytest_plugins = ["integration.test_postgres"]


@pytest.fixture
async def configuration_service(repository):
    repo, _ = repository
    cfg = Settings(database_url="postgresql://unused", auth_token="synthetic-test-token-000000", executor_token="synthetic-executor-token-000", model_provider="codex_cli", model_name="initial-model")
    guard = SecretGuard()
    models = ModelConfigurationService(repo, cfg, guard)
    owner = SimpleNamespace(repository=repo, guard=guard, model_configuration=lambda: models,
        status=AsyncMock(return_value={"model": {"configured": True}}),
        integrations=lambda: SimpleNamespace(list=AsyncMock(return_value=[])),
        _credentials=lambda: SimpleNamespace(refresh=AsyncMock()))

    async def cleanup():
        async with repo.connection() as conn:
            for table in ("factory_configuration_events", "factory_configuration", "model_configuration_events", "model_configuration"):
                await conn.execute(sql.SQL("DELETE FROM {}").format(sql.Identifier(table)))

    await cleanup()
    try:
        yield ConsoleConfigurationService(owner), models, owner
    finally:
        await cleanup()


def save_request(revision, configuration):
    destinations = {configuration.models.default.destination, *(choice.destination for choice in configuration.models.roles.values() if choice)}
    return ConfigurationSave(version=1, expected_revision=revision, document=document(configuration), approved_destinations=sorted(destinations))


async def test_concurrent_configuration_cas_persists_models_and_document_as_one_revision(configuration_service):
    service, models, _ = configuration_service
    revision, before = await service.snapshot()
    first, second = before.model_copy(deep=True), before.model_copy(deep=True)
    first.models.default.name, second.models.default.name = "model-first", "model-second"
    first.flows["patch"].repair_cycles, second.flows["patch"].repair_cycles = 1, 0
    results = await asyncio.gather(service.save(save_request(revision, first)), service.save(save_request(revision, second)), return_exceptions=True)
    assert sum(isinstance(result, DomainError) for result in results) == 1
    saved_revision, saved = await service.snapshot()
    model_revision, selected = await models.snapshot()
    assert saved_revision == (1 << 32) | model_revision and model_revision == 1
    assert saved.models == selected
    assert (saved.models.default.name, saved.flows["patch"].repair_cycles) in {("model-first", 1), ("model-second", 0)}
    async with service.repository.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS count FROM factory_configuration_events")).fetchone())["count"] == 1
        assert (await (await conn.execute("SELECT count(*) AS count FROM model_configuration_events")).fetchone())["count"] == 1


async def test_a_view_names_the_saved_revision_as_the_history_does_and_keeps_the_save_token_apart(configuration_service):
    service, models, owner = configuration_service
    owner.repository.projects = AsyncMock(return_value=[])
    fresh = await service.get()
    assert (fresh.saved_revision, fresh.revision) == (0, 0)
    changed = fresh.configuration.model_copy(deep=True)
    changed.flows["patch"].repair_cycles = 1
    first = await service.save(save_request(fresh.revision, changed))
    # The token joins both counters; the number an owner reads is the one the history lists.
    assert first.revision == (1 << 32) | 1
    assert first.saved_revision == 1
    history = await configuration_history_page(service.repository, 5)
    assert [item.revision for item in history.items] == [first.saved_revision]
    # A model edit through its own editor moves the token, so a stale draft still fails, and not the saved revision.
    model_revision, data = await models.snapshot()
    edited = data.model_copy(deep=True)
    edited.default.name = "edited-elsewhere"
    await models.change(ModelConfigurationChange(**edited.model_dump(), expected_revision=model_revision, approved_destinations=[edited.default.destination]))
    after = await service.get()
    assert after.saved_revision == 1 and after.revision == (1 << 32) | 2
    with pytest.raises(DomainError) as stale:
        await service.save(save_request(first.revision, changed))
    assert stale.value.code == "MODEL_CONFIGURATION_CHANGED"
    changed.models = after.configuration.models
    changed.flows["patch"].repair_cycles = 0
    second = await service.save(save_request(after.revision, changed))
    assert second.saved_revision == 2
    assert [item.revision for item in (await configuration_history_page(service.repository, 5)).items] == [2, 1]


async def test_model_write_is_rolled_back_if_atomic_configuration_save_fails(configuration_service, monkeypatch):
    service, models, _ = configuration_service
    revision, before = await service.snapshot()
    proposed = before.model_copy(deep=True)
    proposed.models.default.name = "must-not-persist"
    original = models._change

    async def interrupted(conn, change, data):
        await original(conn, change, data)
        raise DomainError("SYNTHETIC_INTERRUPTION", "Synthetic transaction interruption", 503)

    monkeypatch.setattr(models, "_change", interrupted)
    with pytest.raises(DomainError, match="Synthetic transaction interruption"):
        await service.save(save_request(revision, proposed))
    assert await service.snapshot() == (revision, before)
    assert (await models.snapshot())[0] == 0


async def test_launch_pins_effective_flow_context_and_same_model_revision_across_later_edit(configuration_service):
    service, models, owner = configuration_service
    revision, configuration = await service.snapshot()
    configuration.models.default.name = "pinned-model"
    configuration.flows["patch"].repair_cycles = 1
    configuration.context.max_input_bytes = 8192
    await service.save(save_request(revision, configuration))
    request = WorkOrderCreate(project_id="p", mode="patch", objective="Correct behavior", acceptance=["Correct output"], budget=Budget(), idempotency_key="pinned-config-request")
    work = WorkOrder(**request.model_dump())
    work, resolved_request = await prepare_run_configuration(owner, work, request)
    initial_snapshot = work.configuration_snapshot.copy()
    current_revision, data = await models.snapshot()
    changed = data.model_copy(deep=True)
    changed.default.name = "later-model"
    await models.change(ModelConfigurationChange(**changed.model_dump(), expected_revision=current_revision, approved_destinations=[changed.default.destination]))
    credentials = SimpleNamespace(vault=SimpleNamespace(list_metadata=AsyncMock(return_value=[])))
    resolved = await resolve_flow(resolved_request.flow_config, "patch", models, credentials, model_snapshot=pinned_models(work))
    assert resolved.model_revision == current_revision
    assert all(phase.model.name == "pinned-model" for phase in resolved.phases.values())
    assert work.flow_config.repair_cycles == 1
    assert work.configuration_snapshot["configuration"]["context"]["max_input_bytes"] == 8192
    assert work.configuration_snapshot == initial_snapshot
    assert (await models.snapshot())[1].default.name == "later-model"


async def test_an_effort_saved_with_a_model_is_read_back_and_is_what_a_launch_pins_for_each_phase(configuration_service):
    from sabre.model_providers import chat_model
    from sabre.model_selection import DESTINATIONS, ModelSelection

    service, models, owner = configuration_service
    revision, configuration = await service.snapshot()
    careful = ModelSelection(provider="claude_cli", name="claude-fixture", destination=DESTINATIONS["claude_cli"], effort="high")
    configuration.models.default = careful
    configuration.models.roles["qa"] = careful.model_copy(update={"effort": "low"})
    # A role with its own selection and no level: the provider decides, whatever the default names.
    configuration.models.roles["security"] = careful.model_copy(update={"effort": None})
    await service.save(save_request(revision, configuration))
    assert (await service.snapshot())[1].models == configuration.models
    # What is stored names a level only where one was chosen.
    async with service.repository.connection() as conn:
        stored = (await (await conn.execute("SELECT data FROM model_configuration")).fetchone())["data"]
    assert (stored["default"]["effort"], stored["roles"]["qa"]["effort"]) == ("high", "low")
    assert "effort" not in stored["roles"]["security"]
    # A process that starts later with another seed gives each role the level it was saved with.
    seed = Settings(database_url="postgresql://unused", auth_token="synthetic-test-token-000000", executor_token="synthetic-executor-token-000",
                    model_provider="openai", model_name="seed-model")
    reader = ModelConfigurationService(service.repository, seed, SecretGuard())
    cfg = reader.configured(*await reader.snapshot())
    assert [cfg.for_role(role).model_effort for role in ("developer", "qa", "security")] == ["high", "low", None]
    assert [chat_model(cfg.for_role(role)).effort for role in ("developer", "qa", "security")] == ["high", "low", ""]
    # A launch pins the level of each phase, and an edit made afterwards does not reach that run.
    request = WorkOrderCreate(project_id="p", mode="patch", objective="Correct behavior", acceptance=["Correct output"], budget=Budget(), idempotency_key="pinned-effort-request")
    work, resolved_request = await prepare_run_configuration(owner, WorkOrder(**request.model_dump()), request)
    current_revision, data = await models.snapshot()
    changed = data.model_copy(deep=True)
    changed.default.effort = "max"
    await models.change(ModelConfigurationChange(**changed.model_dump(), expected_revision=current_revision, approved_destinations=[changed.default.destination]))
    assert (await models.snapshot())[1].default.effort == "max"
    credentials = SimpleNamespace(vault=SimpleNamespace(list_metadata=AsyncMock(return_value=[])))
    resolved = await resolve_flow(resolved_request.flow_config, "patch", models, credentials, model_snapshot=pinned_models(work))
    assert {phase: binding.model.effort for phase, binding in resolved.phases.items()} == {
        "analysis": "high", "planning": "high", "implementation": "high", "verification": "low", "review": "high", "security": None}


async def test_configured_github_credential_is_not_claimed_as_verified_repository_readiness(configuration_service):
    service, _, owner = configuration_service
    owner.integrations = lambda: SimpleNamespace(list=AsyncMock(return_value=[SimpleNamespace(id="github.publish", enabled=True, credential_configured=True)]))
    view = await service.get()
    delivery = next(item for item in view.readiness if item.id == "delivery")
    assert delivery.status == "unavailable" and "not been verified" in delivery.message


async def test_configuration_history_summarizes_changed_paths_newest_first(configuration_service):
    from sabre.console_configuration import configuration_history_page
    service, _, owner = configuration_service
    assert (await configuration_history_page(owner.repository, 5)).items == []
    revision, current = await service.snapshot()
    await service.save(save_request(revision, current))
    revision, current = await service.snapshot()
    current.flows["patch"].repair_cycles = 0
    await service.save(save_request(revision, current))
    history = await configuration_history_page(owner.repository, 5)
    assert [item.revision for item in history.items] == [2, 1] and not history.truncated
    assert history.items[0].changed_paths == ["flows.patch.repair_cycles"] and history.items[0].summary == "Changed flows.patch.repair_cycles"
    assert history.items[1].summary == "Initial saved configuration" and history.items[0].actor == "owner"
    page = await configuration_history_page(owner.repository, 1)
    assert [item.revision for item in page.items] == [2] and page.truncated and page.items[0].changed_paths == ["flows.patch.repair_cycles"]
