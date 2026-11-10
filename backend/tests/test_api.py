from types import SimpleNamespace

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
