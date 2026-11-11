"""Read-only observed readiness and a fixed set of local navigation actions."""

from typing import Literal

from pydantic import Field

from sabre.console_configuration import ConsoleConfigurationService, ReadinessItem
from sabre.contracts import StrictContract
from sabre.operator_contracts import FactoryNavigationAction


class ReadinessConnection(StrictContract):
    id: Literal["github.read", "github.publish"]
    enabled: bool
    credential_configured: bool
    access: str = Field(max_length=500)


class ReadinessExternalTools(StrictContract):
    id: str = Field(max_length=100)
    kind: Literal["mcp"]
    enabled: bool
    credential_configured: bool
    tool_count: int = Field(ge=0)


class FactoryReadinessView(StrictContract):
    version: Literal[1] = 1
    items: list[ReadinessItem] = Field(max_length=10)
    connections: list[ReadinessConnection] = Field(max_length=2)
    external_tools: list[ReadinessExternalTools] = Field(default_factory=list, max_length=50)
    external_tools_truncated: bool = False
    actions: list[FactoryNavigationAction] = Field(default_factory=list, max_length=5)


def navigation_actions(readiness):
    actions = []
    for connection in readiness.connections:
        if not connection.enabled or not connection.credential_configured:
            suffix = "read" if connection.id == "github.read" else "publish"
            actions.append(FactoryNavigationAction.model_validate({"id": f"connect-github-{suffix}", "kind": "open_tool",
                "target": connection.id, "label": "Connect GitHub repositories" if suffix == "read" else "Connect GitHub deliveries"}))
    for item in readiness.items:
        if item.id == "model" and item.status != "ready":
            actions.append(FactoryNavigationAction(id="configure-models", kind="open_models", target="model", label="Choose a model"))
        elif item.id == "provider" and item.status != "ready":
            actions.append(FactoryNavigationAction(id="connect-provider", kind="open_models", target="model", label="Connect model provider"))
    actions.append(FactoryNavigationAction(id="add-mcp-connection", kind="open_tools", target="mcp", label="Add MCP connection"))
    return actions[:5]


async def factory_readiness(service):
    configuration = await ConsoleConfigurationService(service).get()
    integrations = await service.integrations().list()
    connections = [ReadinessConnection.model_validate({"id": item.id, "enabled": item.enabled,
        "credential_configured": item.credential_configured, "access": item.access})
        for item in integrations if item.id in {"github.read", "github.publish"}]
    external = [item for item in integrations if getattr(item, "kind", None) == "mcp"]
    result = FactoryReadinessView(items=configuration.readiness, connections=connections,
        external_tools=[ReadinessExternalTools(id=item.id, kind="mcp", enabled=item.enabled,
            credential_configured=item.credential_configured, tool_count=len(item.tools)) for item in external[:50]],
        external_tools_truncated=len(external) > 50)
    result.actions = navigation_actions(result)
    service.guard.check(result)
    return result
