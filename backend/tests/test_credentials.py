from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import SecretStr

from sabre.agents import GuardedCalls
from sabre.api import create_app
from sabre.credentials import Credentials, endpoint_digest
from sabre.models import DomainError
from sabre.private_credentials import fetch_credentials
from sabre.security import SecretGuard
from sabre.settings import RoleModelSettings, Settings
from sabre.tools import ToolCatalog, ToolDefinition, ToolPolicy


class VaultFixture:
    def __init__(self, values=None):
        self.records = {key: [1, value] for key, value in (values or {}).items()}

    async def list_metadata(self):
        return [SimpleNamespace(id=key, version=item[0], configured=item[1] is not None) for key, item in self.records.items()]

    async def resolve(self, identifier):
        return SecretStr(self.records[identifier][1])


def config(**kwargs):
    return Settings(database_url="postgresql://fixture", auth_token="synthetic-owner-token-long-enough", executor_token="synthetic-broker-token-long-enough", **kwargs)


async def test_provider_and_endpoint_credentials_are_bound_and_old_values_stay_guarded():
    cfg = config(role_models={"reviewer": RoleModelSettings(model_provider="anthropic", model_name="test")})
    vault = VaultFixture({"model.openai.default": "synthetic-openai-value", "model.google.default": "synthetic-unselected-value"})
    guard = SecretGuard()
    credentials = Credentials(vault, cfg, guard)
    await credentials.refresh()
    assert cfg.for_role("developer").model_api_key.get_secret_value() == "synthetic-openai-value"
    assert cfg.for_role("reviewer").model_api_key.get_secret_value() == ""
    with pytest.raises(DomainError, match="credential"):
        guard.check("synthetic-unselected-value")
    vault.records["model.openai.default"] = [2, "synthetic-replacement-value"]
    await credentials.refresh()
    for value in ("synthetic-openai-value", "synthetic-replacement-value"):
        with pytest.raises(DomainError):
            guard.check(value)


async def test_disabled_or_explicit_empty_role_never_falls_back_to_default():
    cfg = config(role_models={"qa": RoleModelSettings(secret_ref="")})
    vault = VaultFixture({"model.openai.default": "synthetic-openai-value", "model.openai.reviewer": None})
    credentials = Credentials(vault, cfg, SecretGuard())
    await credentials.refresh()
    assert not cfg.for_role("qa").model_api_key.get_secret_value()
    assert not cfg.for_role("reviewer").model_api_key.get_secret_value()
    revision = await credentials.refresh()
    vault.records["model.openai.default"] = [2, None]
    with pytest.raises(DomainError) as error:
        await credentials.assert_current(revision)
    assert error.value.code == "CREDENTIALS_CHANGED"
    assert not cfg.model_api_key.get_secret_value()


@pytest.mark.parametrize("endpoint", ["https://user:pass@example.com/mcp", "https://example.com/mcp?token=value", "file:///tmp/socket", "https://example.com/#credential"])
def test_credential_endpoints_reject_embedded_or_ambiguous_authority(endpoint):
    with pytest.raises(DomainError):
        endpoint_digest(endpoint)


def test_endpoint_normalization_and_refs_cannot_cross_destinations():
    assert endpoint_digest("HTTPS://EXAMPLE.COM:443/mcp") == endpoint_digest("https://example.com/mcp")
    assert endpoint_digest("https://example.com") == endpoint_digest("https://example.com/")
    assert endpoint_digest("https://example.com/mcp/") != endpoint_digest("https://example.com/mcp")
    assert endpoint_digest("https://example.com/other") != endpoint_digest("https://example.com/mcp")
    with pytest.raises(DomainError) as error:
        Credentials(VaultFixture(), config(model_secret_ref="model.anthropic.default"), SecretGuard())
    assert error.value.code == "CREDENTIAL_DESTINATION"


async def test_private_adapters_require_their_own_identity_and_are_hidden_from_openapi():
    class Service:
        async def private_credentials(self, purpose):
            return {"token": "synthetic-read-value"} if purpose == "github-read" else {"bot_token": "synthetic-bot-value", "app_token": "synthetic-app-value"}

        async def status(self):
            return {"status": "ok"}

    cfg = config()
    cfg.gateway_token = SecretStr("synthetic-gateway-token-long-enough")
    app = create_app(Service(), cfg)
    assert not any(path.startswith("/internal") for path in app.openapi()["paths"])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://api") as client:
        read = "/internal/credentials/github-read"
        slack = "/internal/credentials/slack"
        owner = {"Authorization": "Bearer " + cfg.auth_token.get_secret_value()}
        broker = {"Authorization": "Bearer " + cfg.executor_token.get_secret_value()}
        gateway = {"Authorization": "Bearer " + cfg.gateway_token.get_secret_value()}
        for headers in ({}, owner, gateway):
            assert (await client.get(read, headers=headers)).status_code == 401
        response = await client.get(read, headers=broker)
        assert response.json() == {"token": "synthetic-read-value"}
        assert response.headers["cache-control"] == "no-store"
        assert (await client.get(slack, headers=broker)).status_code == 401
        assert (await client.get(slack, headers=gateway)).status_code == 200
        assert (await client.get("/api/v1/status", headers=gateway)).status_code == 401
        assert (await client.get("/api/v1/secrets", headers=broker)).status_code == 401


async def test_private_client_does_not_follow_redirect_or_echo_dependency_errors():
    canary = "synthetic-private-response-value"
    async def handler(request):
        return httpx.Response(302, headers={"Location": "https://foreign.example/" + canary})
    async with httpx.AsyncClient(base_url="http://api", transport=httpx.MockTransport(handler), follow_redirects=False) as client:
        with pytest.raises(DomainError) as error:
            await fetch_credentials("http://api", "synthetic-broker-token", "github-read", client=client)
    assert canary not in str(error.value)
    assert error.value.__context__ is None


async def test_gateway_can_only_admit_chat_and_dependency_failure_is_safe(monkeypatch):
    from sabre import slack
    canary = "synthetic-slack-credential-value"
    async def broken(service, body):
        raise RuntimeError(canary)
    monkeypatch.setattr(slack, "admit_message", broken)
    cfg = config(gateway_token="synthetic-gateway-token-long-enough")
    service = SimpleNamespace(guard=SecretGuard([canary]))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(service, cfg)), base_url="http://api") as client:
        response = await client.post("/api/v1/chat", headers={"Authorization": "Bearer " + cfg.gateway_token.get_secret_value()}, json={"text": "Consultar estado"})
        assert response.status_code == 503
        assert response.json()["code"] == "SLACK_ADMISSION_FAILED"
        assert canary not in response.text
        assert (await client.get("/api/v1/secrets", headers={"Authorization": "Bearer " + cfg.gateway_token.get_secret_value()})).status_code == 401


async def test_rotation_blocks_cached_model_and_tool_before_any_execution():
    cfg = config()
    vault = VaultFixture({"model.openai.default": "synthetic-original-value"})
    guard = SecretGuard()
    credentials = Credentials(vault, cfg, guard)
    revision = await credentials.refresh()
    async def current():
        await credentials.assert_current(revision)
    provider = AsyncMock()
    repository = SimpleNamespace(control=AsyncMock(return_value=None), reserve_usage=AsyncMock())
    middleware = GuardedCalls(repository, cfg.model_copy(deep=True), SimpleNamespace(id="work"), guard, credential_check=current)
    tool = AsyncMock(return_value="executed")
    catalog = ToolCatalog(guard)
    catalog.credential_check = current
    catalog.register(ToolDefinition("fixture", "Read a fixture", {"type": "object", "properties": {}}, ToolPolicy(frozenset({"developer"}), "read"), tool))
    vault.records["model.openai.default"] = [2, None]
    with pytest.raises(DomainError) as model_error:
        await middleware.awrap_model_call(SimpleNamespace(), provider)
    with pytest.raises(DomainError) as tool_error:
        await catalog.invoke("fixture", {}, "developer")
    assert model_error.value.code == tool_error.value.code == "CREDENTIALS_CHANGED"
    provider.assert_not_awaited()
    tool.assert_not_awaited()
    repository.reserve_usage.assert_not_awaited()
