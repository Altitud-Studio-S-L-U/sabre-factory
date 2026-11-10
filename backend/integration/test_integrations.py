import asyncio

import pytest

from sabre.credentials import Credentials
from sabre.integrations import INTEGRATIONS_SCHEMA, IntegrationService, IntegrationStateChange
from sabre.models import DomainError, Project, new_id
from sabre.repository import Repository
from sabre.security import SecretGuard
from sabre.settings import MCPServerSettings, Settings
from tests.test_credentials import VaultFixture, config


async def test_concurrent_repository_import_has_one_registration_and_a_domain_conflict():
    repository = Repository(Settings().database_url.get_secret_value())
    await repository.initialize()
    url = f"https://github.com/fixture/{new_id()}"
    projects = [Project(name="Import fixture", repository=url, profile="node", gate_commands=[["npm", "test"]]) for _ in range(2)]
    try:
        outcomes = await asyncio.gather(*(repository.create_project(project) for project in projects), return_exceptions=True)
        assert sum(isinstance(item, Project) for item in outcomes) == 1
        assert sum(isinstance(item, DomainError) and item.code == "PROJECT_EXISTS" for item in outcomes) == 1
    finally:
        async with repository.connection() as conn:
            await conn.execute("DELETE FROM projects WHERE id=ANY(%s)", ([project.id for project in projects],))


async def test_persisted_connection_switch_cas_and_audit_are_atomic():
    repository = Repository(Settings().database_url.get_secret_value())
    name = f"fixture-{new_id()[:8]}"
    identifier = f"mcp.{name}"
    cfg, guard = config(mcp_servers={name: MCPServerSettings(endpoint="https://example.org/mcp", tools={})}), SecretGuard()
    credentials = Credentials(VaultFixture(), cfg, guard)
    service = IntegrationService(repository, cfg, credentials, guard)
    credentials.integrations = service
    async with repository.connection() as conn:
        await conn.execute(INTEGRATIONS_SCHEMA)
    try:
        before = await credentials.refresh()
        outcomes = await asyncio.gather(*(service.change_state(identifier, IntegrationStateChange(enabled=False, expected_revision=0)) for _ in range(2)), return_exceptions=True)
        assert sum(isinstance(value, DomainError) and value.code == "INTEGRATION_CHANGED" for value in outcomes) == 1
        assert sum(getattr(value, "revision", None) == 1 for value in outcomes) == 1
        with pytest.raises(DomainError) as error:
            await service.ensure_enabled(identifier)
        assert error.value.code == "INTEGRATION_DISABLED"
        with pytest.raises(DomainError):
            await credentials.assert_current(before)
        fresh = IntegrationService(repository, cfg, credentials, guard)
        assert next(item for item in await fresh.list() if item.id == identifier).enabled is False
        with pytest.raises(DomainError):
            await fresh.change_state(identifier, IntegrationStateChange(enabled=True, expected_revision=0))
        enabled = await fresh.change_state(identifier, IntegrationStateChange(enabled=True, expected_revision=1))
        assert enabled.enabled and enabled.revision == 2
        await fresh.ensure_enabled(identifier)
        async with repository.connection() as conn:
            events = await (await conn.execute("SELECT revision,enabled FROM integration_events WHERE integration_id=%s ORDER BY revision", (identifier,))).fetchall()
        assert events == [{"revision": 1, "enabled": False}, {"revision": 2, "enabled": True}]
        assert credentials.values == {}
    finally:
        async with repository.connection() as conn:
            await conn.execute("DELETE FROM integration_events WHERE integration_id=%s", (identifier,))
            await conn.execute("DELETE FROM integration_preferences WHERE id=%s", (identifier,))
