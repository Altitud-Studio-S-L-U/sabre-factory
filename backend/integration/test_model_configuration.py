import asyncio

import pytest
from psycopg.errors import CheckViolation

from integration.test_postgres import repository as repository
from sabre.credentials import Credentials
from sabre.model_configuration import ModelConfigurationChange, ModelConfigurationService
from sabre.models import DomainError
from sabre.security import SecretGuard
from tests.test_credentials import VaultFixture, config
from tests.test_model_configuration import change, choice


@pytest.fixture
async def configuration(repository):
    repo, _ = repository
    async with repo.connection() as conn:
        assert not await (await conn.execute("SELECT revision FROM model_configuration")).fetchall()
    service = ModelConfigurationService(repo, config(model_provider="codex_cli"), SecretGuard())
    yield service
    async with repo.connection() as conn:
        await conn.execute("DELETE FROM model_configuration_events")
        await conn.execute("DELETE FROM model_configuration")


async def test_configuration_cas_restart_and_cross_process_boundary(configuration):
    service = configuration
    reader_cfg = config(model_provider="codex_cli")
    reader = ModelConfigurationService(service.repository, reader_cfg, SecretGuard())
    credentials = Credentials(VaultFixture(), reader_cfg, reader.guard)
    credentials.model_configuration = reader
    previous = await credentials.refresh()
    request = change().model_dump()
    request["roles"]["reviewer"] = choice("claude_cli").model_dump()
    request["approved_destinations"].append(choice("claude_cli").destination)
    update = ModelConfigurationChange.model_validate(request)
    results = await asyncio.gather(service.change(update), service.change(update), return_exceptions=True)
    success = [value for value in results if not isinstance(value, Exception)]
    failed = [value for value in results if isinstance(value, DomainError)]
    assert len(success) == len(failed) == 1 and failed[0].code == "MODEL_CONFIGURATION_CHANGED"
    assert success[0].revision == 1
    with pytest.raises(DomainError) as stale:
        await credentials.assert_current(previous)
    assert stale.value.code == "CREDENTIALS_CHANGED"
    assert reader_cfg.for_role("reviewer").model_provider == "claude_cli"
    assert reader_cfg.for_role("developer").model_provider == "codex_cli"
    assert reader_cfg.model_configuration_revision == 1
    restarted = ModelConfigurationService(service.repository, config(model_provider="openai"), SecretGuard())
    assert (await restarted.get()).model_dump() == success[0].model_dump()
    async with service.repository.connection() as conn:
        rows = await (await conn.execute("SELECT revision,data FROM model_configuration_events")).fetchall()
    assert len(rows) == 1 and rows[0]["data"]["roles"]["reviewer"]["provider"] == "claude_cli"


async def test_configuration_and_audit_rollback_together(configuration):
    service = configuration
    async with service.repository.connection() as conn:
        await conn.execute("ALTER TABLE model_configuration_events ADD CONSTRAINT fixture_reject_model_config CHECK(revision<1)")
    try:
        with pytest.raises(CheckViolation):
            await service.change(change())
        assert (await service.get()).revision == 0
    finally:
        async with service.repository.connection() as conn:
            await conn.execute("ALTER TABLE model_configuration_events DROP CONSTRAINT fixture_reject_model_config")
