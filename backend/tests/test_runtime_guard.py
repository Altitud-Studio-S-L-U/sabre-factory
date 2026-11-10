from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import SecretStr

from sabre import runtime
from sabre.models import DomainError
from sabre.settings import Settings


async def test_runtime_registers_role_override_keys_before_creating_agents(monkeypatch, tmp_path):
    override_keys = ["synthetic-developer-private-override", "synthetic-security-private-override"]
    cfg = Settings(database_url="postgresql://fixture:synthetic-project-db-password@fixture/sabre", auth_token="synthetic-owner-token-24-characters",
                   vault_database_url="postgresql://fixture:synthetic-vault-db-password@fixture/sabre_vault", vault_master_key_file=tmp_path / "master.key",
                   executor_token="synthetic-broker-token-24-characters", data_dir=tmp_path,
                   role_models={
                       "developer": {},
                       "security": {},
                       "reviewer": {"model_name": "inherits-the-default-key"},
                   })
    stored = {"model.openai.default": "synthetic-default-provider-key", "model.openai.developer": override_keys[0], "model.openai.security": override_keys[1]}
    vault = SimpleNamespace(initialize=AsyncMock(),
        list_metadata=AsyncMock(return_value=[SimpleNamespace(id=identifier, version=1, configured=True) for identifier in stored]),
        resolve=AsyncMock(side_effect=lambda identifier: SecretStr(stored[identifier])))
    monkeypatch.setattr(runtime, "Vault", lambda *args: vault)
    async def execute(query, *args):
        row = None if isinstance(query, str) and "FROM model_configuration" in query else {"present": True}
        return SimpleNamespace(fetchone=AsyncMock(return_value=row), fetchall=AsyncMock(return_value=[]))

    connection = SimpleNamespace(execute=AsyncMock(side_effect=execute))

    @asynccontextmanager
    async def connect():
        yield connection

    checkpoint = SimpleNamespace(setup=AsyncMock())

    @asynccontextmanager
    async def checkpoint_context(*args):
        yield checkpoint

    repository = SimpleNamespace(initialize=AsyncMock(), close=AsyncMock(), connection=connect)
    monkeypatch.setattr(runtime, "Repository", lambda dsn, **kwargs: repository)
    monkeypatch.setattr(runtime, "configure", lambda endpoint: None)
    monkeypatch.setattr(runtime, "AsyncPostgresSaver", SimpleNamespace(from_conn_string=checkpoint_context))
    monkeypatch.setattr(runtime.procrastinate, "App", lambda **kwargs: SimpleNamespace(open_async=AsyncMock(), close_async=AsyncMock()))
    monkeypatch.setattr(runtime, "ExecutorClient", lambda *args: object())
    monkeypatch.setattr(runtime, "ArtifactStore", lambda *args: object())
    monkeypatch.setattr(runtime, "MemoryService", lambda *args: object())
    captured = []

    class Captured(Exception):
        pass

    def capture_team(config, repository, executor, guard, **kwargs):
        captured.append(guard)
        return object()

    def capture_security(scanner, *, checkpointer, analyst, guard):
        captured.append(guard)
        raise Captured

    monkeypatch.setattr(runtime, "AgentTeam", capture_team)
    monkeypatch.setattr(runtime, "SecurityService", capture_security)
    application = runtime.Runtime(cfg)
    try:
        with pytest.raises(Captured):
            await application.__aenter__()
    finally:
        await application.stack.aclose()
    assert cfg.for_role("developer").model_api_key.get_secret_value() == override_keys[0]
    assert len(captured) == 2 and captured[0] is captured[1]
    for key in [*override_keys, cfg.model_api_key.get_secret_value(), "synthetic-project-db-password", "synthetic-vault-db-password"]:
        with pytest.raises(DomainError) as error:
            captured[0].check({"file": key})
        assert error.value.code == "SECRET_DETECTED"
        assert captured[0].redact(key) == "[REDACTED]"
