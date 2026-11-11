from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from sabre.models import DomainError

pytest_plugins = ["tests.test_factory_workflow"]


async def test_intake_requests_rebuildable_index_bound_to_actual_source_commit(build_factory):
    factory, repo, _, executor, _, _ = build_factory()
    factory.ingestion = SimpleNamespace(request=AsyncMock())
    result = await factory.intake({"order": repo.current.model_dump(mode="json")})
    project_id, request = factory.ingestion.request.await_args.args
    snapshot = await executor.snapshot(repo.current.id)
    assert project_id == repo.current.project_id
    assert request.expected_source_commit == snapshot["base_commit"]
    assert request.idempotency_key.endswith(snapshot["base_commit"])
    await factory.intake(result)
    assert factory.ingestion.request.await_args_list[0].args == factory.ingestion.request.await_args_list[1].args


async def test_revoked_origin_blocks_a_new_deterministic_stage_before_workspace_effects(build_factory, monkeypatch):
    factory, repo, _, executor, _, _ = build_factory()
    repo.current.channel_thread = "delegated:expired-grant"
    check = AsyncMock(side_effect=DomainError("DELEGATION_EXPIRED", "The originating grant expired", 403))
    monkeypatch.setattr("sabre.delegation.authorize_delegated_work", check)
    with pytest.raises(DomainError) as error:
        await factory.intake({"order": repo.current.model_dump(mode="json")})
    assert error.value.code == "DELEGATION_EXPIRED" and not executor.prepared
    check.assert_awaited_once()
