from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
from pydantic import SecretStr

from sabre.api import create_app
from sabre.mcp_connections import MCPConnectionInfo
from sabre.models import DomainError
from sabre.project_tools import ProjectToolsPolicy
from sabre.security import SecretGuard
from sabre.service import FactoryService


async def test_owner_control_routes_share_runtime_services_and_validate_decisions():
    connection = MCPConnectionInfo(name="fixture", endpoint="https://tools.example.com/mcp", revision=1,
        credential_id="mcp.fixture.digest.token", tools={}, tool_digests={}, source="dynamic")
    registry = SimpleNamespace(list=AsyncMock(return_value=[connection]), save=AsyncMock(return_value=connection))
    permissions = SimpleNamespace(get=AsyncMock(return_value=ProjectToolsPolicy(project_id="p", revision=0, servers=[])))
    proposals = SimpleNamespace(decide=AsyncMock())
    credentials = SimpleNamespace(refresh=AsyncMock())
    runtime = SimpleNamespace(mcp_connections=registry, project_tools=permissions, repository_proposals=proposals, credentials=credentials)
    service = FactoryService(None, None, None, runtime, SecretGuard(), None)
    cfg = SimpleNamespace(auth_token=SecretStr("synthetic-owner-control-token"), allowed_origins=[])
    app = create_app(service, cfg)
    headers = {"Authorization": "Bearer synthetic-owner-control-token"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture") as client:
        assert (await client.get("/api/v1/mcp-connections")).status_code == 401
        response = await client.get("/api/v1/mcp-connections", headers=headers)
        assert response.status_code == 200 and response.json()[0]["name"] == "fixture"
        assert response.headers["cache-control"] == "no-store"
        response = await client.put("/api/v1/mcp-connections/fixture", headers=headers,
            json={"expected_revision": 0, "endpoint": connection.endpoint})
        assert response.status_code == 200
        registry.save.assert_awaited_once()
        credentials.refresh.assert_awaited_once()
        response = await client.get("/api/v1/projects/p/mcp-tools", headers=headers)
        assert response.status_code == 200 and response.json()["revision"] == 0
        permissions.get.assert_awaited_once_with("p")
        response = await client.post("/api/v1/repository-proposals/id/decision", headers=headers,
            json={"expected_revision": 0, "decision": "approve"})
        assert response.status_code == 422
        proposals.decide.assert_not_awaited()


def test_control_service_unavailable_fails_explicitly():
    service = FactoryService(None, None, None, object(), SecretGuard(), None)
    for name in ("mcp_connections", "project_tools", "repository_proposals"):
        try:
            getattr(service, name)()
        except DomainError as error:
            assert error.status_code == 503
        else:
            raise AssertionError("Missing runtime service must not look successful")
