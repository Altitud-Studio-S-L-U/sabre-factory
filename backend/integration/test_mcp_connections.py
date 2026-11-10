import asyncio

import pytest

from sabre.credentials import Credentials
from sabre.integrations import INTEGRATIONS_SCHEMA, IntegrationService, IntegrationStateChange
from sabre.mcp_connections import MCP_CONNECTIONS_SCHEMA, MCPConnectionSave, MCPConnectionStore
from sabre.models import DomainError, new_id
from sabre.repository import Repository
from sabre.security import SecretGuard
from sabre.settings import Settings
from tests.test_credentials import VaultFixture, config


async def test_connection_creation_edit_cas_and_revocation_persist_together():
    repo = Repository(Settings().database_url.get_secret_value())
    cfg, guard = config(), SecretGuard()
    credentials = Credentials(VaultFixture(), cfg, guard)
    store = MCPConnectionStore(repo, cfg, guard)
    integrations = IntegrationService(repo, cfg, credentials, guard)
    credentials.mcp_connections, credentials.integrations = store, integrations
    name = f"fixture-{new_id()[:8]}"
    identifier = f"mcp.{name}"
    async with repo.connection() as conn:
        await conn.execute(INTEGRATIONS_SCHEMA)
        await conn.execute(MCP_CONNECTIONS_SCHEMA)
    try:
        created = await store.save(name, MCPConnectionSave(expected_revision=0, endpoint="https://example.com/mcp"))
        await credentials.refresh()
        assert created.revision == 1 and created.tools == {}
        with pytest.raises(DomainError):
            await integrations.ensure_enabled(identifier)
        await integrations.change_state(identifier, IntegrationStateChange(enabled=True, expected_revision=1))
        revision = await credentials.refresh()
        outcomes = await asyncio.gather(*(store.save(name, MCPConnectionSave(expected_revision=1, endpoint="https://example.org/mcp")) for _ in range(2)), return_exceptions=True)
        assert sum(isinstance(value, DomainError) and value.code == "MCP_CONNECTION_CHANGED" for value in outcomes) == 1
        assert sum(getattr(value, "revision", None) == 2 for value in outcomes) == 1
        with pytest.raises(DomainError):
            await credentials.assert_current(revision)
        with pytest.raises(DomainError):
            await integrations.ensure_enabled(identifier)
        fresh = MCPConnectionStore(repo, config(), guard)
        info = next(value for value in await fresh.list() if value.name == name)
        assert info.revision == 2 and info.endpoint == "https://example.org/mcp"
        async with repo.connection() as conn:
            events = await (await conn.execute("SELECT revision,enabled FROM integration_events WHERE integration_id=%s ORDER BY revision", (identifier,))).fetchall()
            connection_events = await (await conn.execute("SELECT revision FROM mcp_connection_events WHERE name=%s ORDER BY revision", (name,))).fetchall()
        assert events == [{"revision": 1, "enabled": False}, {"revision": 2, "enabled": True}, {"revision": 3, "enabled": False}]
        assert connection_events == [{"revision": 1}, {"revision": 2}]
        assert credentials.values == {}
    finally:
        async with repo.connection() as conn:
            await conn.execute("DELETE FROM mcp_connection_events WHERE name=%s", (name,))
            await conn.execute("DELETE FROM mcp_connections WHERE name=%s", (name,))
            await conn.execute("DELETE FROM integration_events WHERE integration_id=%s", (identifier,))
            await conn.execute("DELETE FROM integration_preferences WHERE id=%s", (identifier,))
