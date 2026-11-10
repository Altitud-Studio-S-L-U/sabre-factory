from importlib import metadata
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from sabre.system_info import PACKAGES, system_info


def source(**changes):
    status = {
        "version": "stale-hardcoded-version", "graph_version": "untrusted-status-version",
        "database": "connected", "model": {"provider": "codex_cli", "cli": {"available": True, "authenticated": True, "busy": False}},
        "roles": {}, "github": {"configured": True}, "slack": {"configured": False},
        "memory": {"semantic_search": False}, "telemetry": {"configured": True},
        "limits": {"concurrent_work": 2, "writers_per_repository": 1, "repair_cycles": 2},
        "private_extra": "synthetic-secret-never-export", "otlp_endpoint": "https://private.invalid/secret",
    }
    status.update(changes)
    return SimpleNamespace(status=AsyncMock(return_value=status))


async def test_inventory_uses_installed_versions_one_probe_and_allowlisted_metadata(monkeypatch):
    monkeypatch.setattr("sabre.system_info.metadata.version", lambda package: f"installed-{package}")
    service = source()
    result = await system_info(service)
    service.status.assert_awaited_once_with()
    assert result.application.version == "installed-sabre-factory"
    assert result.application.graph_version == "sabre-v1"
    assert [item.distribution for item in result.packages] == list(PACKAGES)
    assert all(item.version == f"installed-{item.distribution}" for item in result.packages)
    assert result.checked_at.tzinfo is not None
    assert result.runtime.python
    assert result.limits.concurrent_work == 2
    assert result.limits.codex_invocations == 1
    serialized = result.model_dump_json()
    assert "synthetic-secret" not in serialized
    assert "private.invalid" not in serialized
    assert "stale-hardcoded-version" not in serialized


async def test_configured_integrations_and_safety_controls_are_not_reported_healthy():
    result = await system_info(source())
    components = {item.id: item for item in result.components}
    assert components["database"].state == "available"
    assert components["codex"].configured is True
    for name in ("github", "slack", "worker", "executor", "security", "memory", "telemetry"):
        assert components[name].state == "unknown"
    assert components["github"].configured is True
    assert components["slack"].configured is False


async def test_heterogeneous_roles_keep_independent_runner_status_and_capacity():
    codex = {"available": True, "authenticated": True, "busy": False}
    claude = {"available": True, "authenticated": None, "busy": True}
    result = await system_info(source(runners={"codex_cli": codex, "claude_cli": claude}, roles={
        "developer": {"provider": "codex_cli", "name": "", "configured": True},
        "reviewer": {"provider": "claude_cli", "name": "sonnet", "configured": False}}))
    components = {item.id: item for item in result.components}
    assert components["codex"].configured is True
    assert components["claude"].state == "busy" and components["claude"].configured is None
    assert result.limits.codex_invocations == result.limits.claude_invocations == 1
    assert next(model for model in result.models if model.provider == "claude_cli").configured is None


@pytest.mark.parametrize("cli,state,configured", [
    ({"available": True, "authenticated": None, "busy": True}, "busy", None),
    ({"available": False, "authenticated": False, "busy": False}, "unavailable", False),
    ({"available": True, "authenticated": False, "busy": False}, "available", False),
])
async def test_busy_and_unauthenticated_states_are_distinct(cli, state, configured):
    roles = {"developer": {"provider": "codex_cli", "name": "", "configured": cli["authenticated"] is True}}
    result = await system_info(source(database="unavailable", model={"provider": "codex_cli", "cli": cli}, roles=roles))
    components = {item.id: item for item in result.components}
    assert components["database"].state == "unavailable"
    assert components["codex"].state == state
    assert components["codex"].configured is configured
    assert result.models[0].role == "developer"
    assert result.models[0].name == ""
    assert result.models[0].configured is configured


async def test_missing_distribution_is_unknown_and_other_provider_has_no_claimed_cli_capacity(monkeypatch):
    def missing(package):
        raise metadata.PackageNotFoundError(package)
    monkeypatch.setattr("sabre.system_info.metadata.version", missing)
    result = await system_info(source(model={"provider": "openai", "cli": None}))
    assert result.application.version is None
    assert all(item.version is None for item in result.packages)
    assert result.limits.codex_invocations is None
    assert all(item.id != "codex" for item in result.components)
