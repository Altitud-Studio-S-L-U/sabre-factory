from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
from mcp import Client
from pydantic import SecretStr

from sabre.api import create_app
from sabre.commands import CommandResult
from sabre.mcp_delegated import build_delegated_mcp
from sabre.models import Budget, DomainError, Project, WorkOrder

GRANT = {"id": "grant-one", "principal": "ci-agent", "data": {
    "principal": "ci-agent", "projects": ["allowed"], "operations": ["work.submit", "work.query"],
    "expires_in": 3600, "max_calls": 10, "max_tokens": 50000, "max_cost_usd": 0, "active_seconds": 600, "max_runs": 2}}


class FakeDelegations:
    def __init__(self):
        self.revoked = False
        self.executed = []

    async def authenticate(self, authorization):
        if authorization != "Bearer sabre_d_valid" or self.revoked:
            raise DomainError("DELEGATION_EXPIRED", "The delegated credential is expired or revoked", 401)
        return GRANT

    async def execute(self, grant_id, message_id, command):
        self.executed.append((grant_id, message_id, command.payload.type))
        work = await self.query(grant_id, "work-1")
        return CommandResult(command_id="delegated:x", correlation_id=command.correlation_id, work_id=work.id,
                             phase=work.phase, work=work)

    async def query(self, grant_id, work_id):
        assert grant_id == GRANT["id"]
        return WorkOrder(id=work_id, project_id="allowed", mode="patch", objective="Fix it", acceptance=["Tests pass"],
                         budget=Budget(max_cost_usd=0), idempotency_key="delegated-fixture")


def server(grants, token):
    projects = [Project(id="allowed", name="Allowed", repository="https://github.com/example/a", profile="python", gate_commands=[["pytest"]]),
                Project(id="other", name="Other", repository="https://github.com/example/b", profile="python", gate_commands=[["pytest"]])]
    service = SimpleNamespace(repository=SimpleNamespace(projects=AsyncMock(return_value=projects)))
    return build_delegated_mcp(lambda: service, delegations=lambda: grants, credential=lambda ctx: token["value"])


def submit(key="delegated-key-1"):
    return {"version": 1, "idempotency_key": key, "correlation_id": "corr-0001", "payload": {
        "type": "work.submit", "request": {"project_id": "allowed", "mode": "patch", "objective": "Fix the failing test",
            "acceptance": ["Tests pass"], "idempotency_key": "remote-run-0001",
            "budget": {"max_calls": 5, "max_tokens": 20000, "max_cost_usd": 0, "active_seconds": 600}}}}


async def test_the_delegated_catalog_has_no_owner_or_policy_tools():
    async with Client(server(FakeDelegations(), {"value": "Bearer sabre_d_valid"})) as client:
        names = {tool.name for tool in (await client.list_tools()).tools}
    assert names == {"sabre_grant", "sabre_list_projects", "sabre_command", "sabre_get_work"}


async def test_projects_are_filtered_and_commands_carry_the_authenticated_grant():
    grants = FakeDelegations()
    async with Client(server(grants, {"value": "Bearer sabre_d_valid"})) as client:
        listed = await client.call_tool("sabre_list_projects", {})
        assert [item["id"] for item in listed.structured_content["result"]] == ["allowed"]
        described = await client.call_tool("sabre_grant", {})
        assert described.structured_content["principal"] == "ci-agent"
        result = await client.call_tool("sabre_command", {"command": submit()})
        assert not result.is_error
        work = await client.call_tool("sabre_get_work", {"work_id": "work-1"})
        assert work.structured_content["project_id"] == "allowed"
    assert grants.executed == [("grant-one", "delegated-key-1", "work.submit")]


async def test_revocation_applies_to_the_next_call_and_owner_tokens_are_refused():
    grants, token = FakeDelegations(), {"value": "Bearer sabre_d_valid"}
    async with Client(server(grants, token)) as client:
        assert not (await client.call_tool("sabre_grant", {})).is_error
        grants.revoked = True
        refused = await client.call_tool("sabre_command", {"command": submit("delegated-key-2")})
        assert refused.is_error and refused.content[0].text == "DELEGATION_EXPIRED: The delegated credential is expired or revoked"
        grants.revoked = False
        token["value"] = "Bearer owner-test-token-at-least-24"
        assert (await client.call_tool("sabre_get_work", {"work_id": "work-1"})).is_error
    assert grants.executed == []


async def test_http_surface_rejects_missing_owner_and_browser_credentials():
    rows = []

    class Connection:
        async def execute(self, *args):
            rows.append(args)
            return SimpleNamespace(fetchone=AsyncMock(return_value=None))

    class Repository:
        def connection(self):

            class Context:
                async def __aenter__(self):
                    return Connection()

                async def __aexit__(self, *exc):
                    return False
            return Context()

    service = SimpleNamespace(repository=Repository())
    app = create_app(service, SimpleNamespace(auth_token=SecretStr("owner-test-token-at-least-24"), allowed_origins=["http://localhost:8000"]))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        missing = await client.post("/delegated/mcp/", json={})
        owner = await client.post("/delegated/mcp/", json={}, headers={"Authorization": "Bearer owner-test-token-at-least-24"})
        unknown = await client.post("/delegated/mcp/", json={}, headers={"Authorization": "Bearer sabre_d_unknown"})
        browser = await client.post("/delegated/mcp/", json={}, headers={"Authorization": "Bearer sabre_d_unknown", "Origin": "https://evil.example"})
    assert (missing.status_code, missing.json()["code"]) == (401, "DELEGATION_REQUIRED")
    assert (owner.status_code, owner.json()["code"]) == (401, "DELEGATION_REQUIRED")
    assert (unknown.status_code, unknown.json()["code"]) == (401, "DELEGATION_EXPIRED")
    assert (browser.status_code, browser.json()["code"]) == (403, "ORIGIN_DENIED")
    assert missing.headers["cache-control"] == "no-store"
    assert all("owner-test-token" not in str(args) for args in rows)
