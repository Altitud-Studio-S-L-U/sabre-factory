import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from sabre.api import create_app
from sabre.console_configuration import ReadinessItem
from sabre.operator_contracts import OperatorContext
from sabre.operator_inspection import recorded_tools
from sabre.operator_readiness import FactoryReadinessView, ReadinessConnection, factory_readiness
from sabre.security import SecretGuard
from sabre.settings import Settings
from sabre.supervisor import conversation_tools


def fixture():
    return FactoryReadinessView(items=[ReadinessItem(id="provider", status="missing", message="Provider connection required", action="Connect in Config"),
        ReadinessItem(id="model", status="missing", message="Choose a model", action="Choose in Config")],
        connections=[ReadinessConnection(id="github.read", enabled=True, credential_configured=False, access="Public access only"),
            ReadinessConnection(id="github.publish", enabled=False, credential_configured=True, access="Saved; permissions unverified")])


async def test_readonly_tool_returns_observed_metadata_and_fixed_navigation_not_credentials(monkeypatch):
    value = fixture()
    configuration = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(readiness=value.items)))
    monkeypatch.setattr("sabre.operator_readiness.ConsoleConfigurationService", lambda _: configuration)
    integrations = SimpleNamespace(list=AsyncMock(return_value=value.connections))
    service = SimpleNamespace(repository=object(), integrations=lambda: integrations, guard=SecretGuard())
    event = OperatorContext(version=1, id="message-a", work_id="run-a", text="Can you access GitHub?", idempotency_key="readiness-request-000")
    tools = {tool.name: tool for tool in conversation_tools(service, None, event)}
    result = await tools["get_factory_readiness"].ainvoke({})
    assert result["connections"][0]["credential_configured"] is False
    assert result["connections"][1]["enabled"] is False
    assert {item["id"] for item in result["actions"]} == {"connect-github-read", "connect-github-publish", "configure-models", "connect-provider", "add-mcp-connection"}
    assert all("href" not in item and "url" not in item for item in result["actions"])
    assert "secret" not in result and "configuration" not in result


def trace(output, *, name="get_factory_readiness", status="success"):
    return [HumanMessage(id="message-a", content="Check access"), AIMessage(content="", tool_calls=[
        {"name": name, "args": {}, "id": "call-a", "type": "tool_call"}]),
        ToolMessage(tool_call_id="call-a", content=output, status=status)]


def test_actions_are_regenerated_from_validated_successful_readiness_records():
    value = fixture()
    page = recorded_tools(trace(value.model_dump_json()), "message-a", SecretGuard())
    assert {action.target for action in page.actions} == {"github.read", "github.publish", "model", "mcp"}
    assert not recorded_tools(trace(value.model_dump_json(), name="get_work"), "message-a", SecretGuard()).actions
    assert not recorded_tools(trace(value.model_dump_json(), status="error"), "message-a", SecretGuard()).actions
    # A claimed action contradicting observed metadata is not an instruction.
    value.items = []
    value.connections = []
    value.actions = page.actions
    assert [action.id for action in recorded_tools(trace(value.model_dump_json()), "message-a", SecretGuard()).actions] == ["add-mcp-connection"]


@pytest.mark.parametrize("output", ["not json", json.dumps({"version": 1, "items": [], "connections": [], "href": "https://malicious.example"}),
    "sk-proj-" + "x" * 40, "x" * 65537])
def test_malformed_secret_or_oversized_results_never_create_navigation(output):
    assert not recorded_tools(trace(output), "message-a", SecretGuard()).actions


async def test_readiness_endpoint_is_owner_authenticated(monkeypatch):
    service = SimpleNamespace()
    operation = AsyncMock(return_value=fixture())
    monkeypatch.setattr("sabre.operator_readiness.factory_readiness", operation)
    cfg = Settings(database_url="postgresql://unused", auth_token="synthetic-readiness-auth-000",
        executor_token="synthetic-executor-token-000")
    app = create_app(service, cfg)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        assert (await client.get("/api/v1/operator/readiness")).status_code == 401
        operation.assert_not_awaited()
        response = await client.get("/api/v1/operator/readiness", headers={"Authorization": "Bearer synthetic-readiness-auth-000"})
        assert response.status_code == 200


async def test_connected_metadata_never_claims_verified_github_permissions(monkeypatch):
    value = fixture()
    value.items = [item.model_copy(update={"status": "ready"}) for item in value.items]
    value.connections = [item.model_copy(update={"enabled": True, "credential_configured": True}) for item in value.connections]
    monkeypatch.setattr("sabre.operator_readiness.ConsoleConfigurationService", lambda _: SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(readiness=value.items))))
    service = SimpleNamespace(integrations=lambda: SimpleNamespace(list=AsyncMock(return_value=value.connections)), guard=SecretGuard())
    result = await factory_readiness(service)
    assert [action.id for action in result.actions] == ["add-mcp-connection"]
    assert "unverified" in result.connections[1].access


async def test_registered_external_tool_metadata_is_bounded_and_omits_endpoints(monkeypatch):
    value = fixture()
    monkeypatch.setattr("sabre.operator_readiness.ConsoleConfigurationService", lambda _: SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(readiness=value.items))))
    external = [SimpleNamespace(id=f"mcp.server-{index}", kind="mcp", enabled=True, credential_configured=False,
        endpoint="https://private-configuration.example", tools=["registered-tool"]) for index in range(51)]
    service = SimpleNamespace(integrations=lambda: SimpleNamespace(list=AsyncMock(return_value=[*value.connections, *external])), guard=SecretGuard())
    result = await factory_readiness(service)
    assert len(result.external_tools) == 50 and result.external_tools_truncated
    assert result.external_tools[0].tool_count == 1
    assert "private-configuration.example" not in result.model_dump_json()
