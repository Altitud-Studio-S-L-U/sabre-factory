import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from mcp import Client
from pydantic import SecretStr

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.api import create_app
from sabre.artifacts import ArtifactStore
from sabre.mcp_server import build_mcp
from sabre.model_configuration import ModelConfigurationService
from sabre.models import Budget, CliProgressLimitsChange, DomainError, Status, TokenBudgetIncrease
from sabre.security import SecretGuard
from sabre.service import FactoryService
from sabre.settings import RoleModelSettings, Settings
from sabre.workflows import Factory
from tests.test_context_receipts import receipt
from tests.test_factory_workflow import TestExecutor, TestMemory, TestPublisher, TestSecurity, TestTeam


def controls(repo, *, provider="codex_cli", role_provider="claude_cli"):
    cfg = Settings(model_provider=provider, role_models={"reviewer": RoleModelSettings(model_provider=role_provider)},
        auth_token=SecretStr("synthetic-owner-control-token"), gateway_token=SecretStr("synthetic-gateway-control-token"))
    selection = ModelConfigurationService(repo, cfg, SecretGuard())
    service = FactoryService(repo, None, None, SimpleNamespace(model_configuration=selection), SecretGuard(), cfg)
    return service, create_app(service, cfg)


async def paused_work(repository):
    repo, project, work = await fixture_work(repository)
    work.status, work.error_code = Status.BLOCKED, "BUDGET_EXHAUSTED"
    work.budget = Budget(max_calls=2, max_tokens=1000, active_seconds=60, max_cost_usd=0)
    await repo.save(work)
    return repo, project, work


def change_for(work):
    return CliProgressLimitsChange(expected_revision=work.plan_revision, expected_budget=work.budget.model_copy(deep=True))


async def test_owner_cas_preserves_ledger_checkpoint_and_requires_separate_resume(repository, tmp_path):
    repo, project, work = await paused_work(repository)
    first = await repo.reserve_usage(work, 700, 0, 0)
    await repo.settle_usage(first, 600, 0)
    await repo.reserve_usage(work, 300, 0, 0)
    work.calls_used, work.tokens_used, work.active_seconds_used = 2, 900, 61.5
    await repo.save(work)
    async with repo.connection() as conn:
        before_usage = await (await conn.execute("SELECT * FROM model_usage WHERE work_id=%s ORDER BY id", (work.id,))).fetchall()
    service, app = controls(repo)
    body = change_for(work).model_dump(mode="json")
    path = f"/api/v1/work/{work.id}/cli-progress-limits"
    owner = {"Authorization": "Bearer synthetic-owner-control-token"}
    async with AsyncPostgresSaver.from_conn_string(repo.dsn) as saver:
        await saver.setup()
        factory = Factory(repo, TestTeam(), TestExecutor(), TestSecurity(), TestPublisher(), ArtifactStore(tmp_path), SecretGuard(), TestMemory(), saver)
        await factory.graph.aupdate_state(factory.config(work.id), {"order": work.model_dump(mode="json"), "review_ok": False}, as_node="review")
        before_checkpoint = await factory.graph.aget_state(factory.config(work.id))
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
                assert (await client.post(path, json=body)).status_code == 401
                assert (await client.post(path, json=body, headers={"Authorization": "Bearer synthetic-gateway-control-token"})).status_code == 401
                responses = await asyncio.gather(client.post(path, json=body, headers=owner), client.post(path, json=body, headers=owner))
                assert sorted(item.status_code for item in responses) == [200, 409]
            unchanged = await factory.graph.aget_state(factory.config(work.id))
            assert unchanged.config == before_checkpoint.config and unchanged.values == before_checkpoint.values
        finally:
            await saver.adelete_thread(work.id)
    persisted = await repo.work(work.id)
    assert persisted.budget.progress_limits and persisted.budget.max_cost_usd == 0
    assert persisted.model_dump(exclude={"budget", "summary", "updated_at"}) == work.model_dump(exclude={"budget", "summary", "updated_at"})
    async with repo.connection() as conn:
        after_usage = await (await conn.execute("SELECT * FROM model_usage WHERE work_id=%s ORDER BY id", (work.id,))).fetchall()
    assert after_usage == before_usage and await repo.pending_scope(work.id) is None
    assert len([event for event in await repo.events(work.id) if event["kind"] == "cli_progress_limits"]) == 1
    with pytest.raises(DomainError) as error:
        await service.increase_token_budget(work.id, TokenBudgetIncrease(expected_revision=1, expected_max_tokens=1000, max_tokens=2000))
    assert error.value.code == "CLI_PROGRESS_LIMITS_ACTIVE"
    for provider in ("codex_cli", "claude_cli"):
        await repo.reserve_usage(persisted, 2000, 0, 0, context_receipt=receipt(work.id, project.id, model_provider=provider))
    assert (await repo.audit_usage(work.id))["unknown_reserved_tokens"] == 4300


@pytest.mark.parametrize("case", ["running", "stale_plan", "stale_budget", "cancel", "api_default", "api_role", "configuration_changed", "project_busy"])
async def test_progress_change_rejects_unsafe_or_stale_admission_without_effects(repository, case):
    repo, _, work = await paused_work(repository)
    change = change_for(work)
    service, _ = controls(repo, provider="openai" if case == "api_default" else "codex_cli",
        role_provider="openai" if case == "api_role" else "claude_cli")
    if case == "running":
        work.status = Status.RUNNING
        await repo.save(work)
    elif case == "stale_plan":
        change.expected_revision = 2
    elif case == "stale_budget":
        change.expected_budget.max_tokens = 2000
    elif case == "cancel":
        await repo.request_control(work.id, "cancel")
    elif case == "configuration_changed":
        view = await service.model_configuration().get()
        view.revision += 1
        service.queue.model_configuration.get = AsyncMock(return_value=view)
    before = await repo.work(work.id)
    if case == "project_busy":
        async with repo.project_lock(work.project_id, execution_slot=False) as acquired:
            assert acquired
            with pytest.raises(DomainError) as error:
                await service.use_cli_progress_limits(work.id, change)
        assert error.value.code == "PROJECT_BUSY"
    else:
        with pytest.raises(DomainError) as error:
            await service.use_cli_progress_limits(work.id, change)
        assert error.value.code == {"running": "PAUSE_REQUIRED", "stale_plan": "STALE_PLAN", "stale_budget": "STALE_BUDGET", "cancel": "CANCEL_REQUESTED",
            "api_default": "MODEL_LIMITS_REQUIRED", "api_role": "MODEL_LIMITS_REQUIRED", "configuration_changed": "MODEL_CONFIGURATION_CHANGED"}[case]
    assert await repo.work(work.id) == before
    assert not any(event["kind"] == "cli_progress_limits" for event in await repo.events(work.id))


async def test_mcp_uses_same_owner_policy_and_non_cli_reservations_fail_before_insert(repository):
    repo, project, work = await paused_work(repository)
    service, _ = controls(repo)
    unpersisted = work.model_copy(update={"budget": Budget(max_calls=None, max_tokens=None, active_seconds=None)})
    with pytest.raises(DomainError) as error:
        await repo.reserve_usage(unpersisted, 100, 0, 0, context_receipt=receipt(work.id, project.id, model_provider="codex_cli"))
    assert error.value.code == "STALE_BUDGET"
    async with Client(build_mcp(lambda: service)) as client:
        result = await client.call_tool("sabre_use_cli_progress_limits", {"work_id": work.id, "change": change_for(work).model_dump(mode="json")})
        assert not result.is_error and result.structured_content["budget"]["max_calls"] is None
    current = await repo.work(work.id)
    for context, usd in [(None, 0), (receipt(work.id, project.id), 0),
            (receipt(work.id, project.id, model_provider="openai"), 0),
            (receipt(work.id, project.id, model_provider="local"), 0),
            (receipt(work.id, project.id, model_provider="claude_cli"), 0.01)]:
        with pytest.raises(DomainError) as error:
            await repo.reserve_usage(current, 100, usd, 10, context_receipt=context)
        assert error.value.code == "MODEL_LIMITS_REQUIRED"
    with pytest.raises(DomainError) as error:
        await repo.reserve_usage(current, 100, 0, 0, context_receipt=receipt(work.id, "another-project", model_provider="codex_cli"))
    assert error.value.code == "CONTEXT_RECEIPT_SCOPE"
    with pytest.raises(DomainError) as error:
        await repo.reserve_usage(work, 100, 0, 0, context_receipt=receipt(work.id, project.id, model_provider="codex_cli"))
    assert error.value.code == "STALE_BUDGET"
    assert (await repo.usage(work.id))["calls"] == 0


@pytest.mark.parametrize("authorization", ["api_budget", "api_history"])
async def test_owner_endpoint_rejects_api_budget_or_spend_without_changing_state_or_ledger(repository, authorization):
    repo, _, work = await paused_work(repository)
    work.budget.max_cost_usd = 1
    await repo.save(work)
    await repo.reserve_usage(work, 100, 0.01, 1)
    work.cost_usd, work.calls_used, work.tokens_used = 0.01, 1, 100
    if authorization == "api_history":
        work.budget.max_cost_usd = 0
    await repo.save(work)
    _, app = controls(repo)
    async with repo.connection() as conn:
        before = await (await conn.execute("SELECT * FROM model_usage WHERE work_id=%s", (work.id,))).fetchall()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        response = await client.post(f"/api/v1/work/{work.id}/cli-progress-limits", json=change_for(work).model_dump(mode="json"),
            headers={"Authorization": "Bearer synthetic-owner-control-token"})
    assert response.status_code == 409 and response.json()["code"] == "MODEL_LIMITS_REQUIRED"
    assert await repo.work(work.id) == work
    async with repo.connection() as conn:
        after = await (await conn.execute("SELECT * FROM model_usage WHERE work_id=%s", (work.id,))).fetchall()
    assert after == before
    assert not any(event["kind"] == "cli_progress_limits" for event in await repo.events(work.id))
