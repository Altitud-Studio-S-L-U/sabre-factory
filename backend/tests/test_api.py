from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
from pydantic import SecretStr

from sabre.api import create_app
from sabre.models import DomainError


class Service:
    async def status(self):
        return {"version": "test", "model": {"configured": False}}

    async def create_project(self, request):
        raise DomainError("PROJECT_EXISTS", "Ya existe")


def app():
    return create_app(Service(), SimpleNamespace(auth_token=SecretStr("owner-test-token-at-least-24"), allowed_origins=["http://localhost:8000"]))


async def test_api_requires_auth_and_rejects_other_origin():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app()), base_url="http://localhost:8000") as client:
        assert (await client.get("/health")).status_code == 200
        assert (await client.get("/api/v1/status")).status_code == 401
        headers = {"Authorization": "Bearer owner-test-token-at-least-24"}
        assert (await client.get("/api/v1/status", headers=headers)).json()["version"] == "test"
        assert (await client.get("/api/v1/status", headers=headers | {"Origin": "https://attacker.example"})).status_code == 403


async def test_validation_does_not_echo_secret_input():
    secret = "sensitive-request-body-must-not-be-echoed"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app()), base_url="http://localhost:8000") as client:
        response = await client.post("/api/v1/projects", headers={"Authorization": "Bearer owner-test-token-at-least-24"}, json={"profile": secret})
        assert response.status_code == 422
        assert secret not in response.text
        assert response.json()["code"] == "INVALID_REQUEST"


def test_openapi_describes_durable_commands_and_required_output_fields():
    schema = app().openapi()
    assert "/api/v1/work/{work_id}/scope" in schema["paths"]
    work = schema["components"]["schemas"]["WorkOrder"]
    assert {"id", "status", "tasks", "questions"} <= set(work["required"])
    usage = schema["paths"]["/api/v1/work/{work_id}/usage"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert usage == {"$ref": "#/components/schemas/RunUsageSnapshot"}


async def test_live_usage_requires_owner_and_checks_work_before_reading_ledger():
    application = app()
    repository = SimpleNamespace(work=AsyncMock(side_effect=DomainError("WORK_NOT_FOUND", "Unknown work", 404)), audit_usage_breakdown=AsyncMock())
    application.state.service.repository = repository
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application), base_url="http://localhost:8000") as client:
        assert (await client.get("/api/v1/work/missing/usage")).status_code == 401
        repository.work.assert_not_awaited()
        response = await client.get("/api/v1/work/missing/usage", headers={"Authorization": "Bearer owner-test-token-at-least-24"})
    assert response.status_code == 404
    repository.work.assert_awaited_once_with("missing")
    repository.audit_usage_breakdown.assert_not_awaited()


async def test_agent_activity_route_is_not_shadowed_by_agent_definitions_and_bounds_days():
    application = app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application), base_url="http://localhost:8000") as client:
        headers = {"Authorization": "Bearer owner-test-token-at-least-24"}
        assert (await client.get("/api/v1/agents/activity?days=0", headers=headers)).status_code == 422
        assert (await client.get("/api/v1/agents/activity?days=91", headers=headers)).status_code == 422
    assert "/api/v1/agents/activity" in application.openapi()["paths"]
