from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from sabre.agents import AgentTeam
from sabre.credentials import Credentials
from sabre.integrations import (
    GitHubRepositoryImport,
    GitHubRepositorySearch,
    IntegrationService,
    IntegrationStateChange,
)
from sabre.models import Budget, DomainError, Project, WorkOrder
from sabre.security import SecretGuard
from sabre.settings import MCPServerSettings
from tests.test_agents import ScriptedModel
from tests.test_credentials import VaultFixture, config


def github_item(**changes):
    return {"id": 42, "full_name": "fixture/example", "private": False, "archived": False, "disabled": False, "default_branch": "main", "description": "Example repository", "language": "TypeScript", "temp_clone_token": "remote-private-value", "html_url": "https://untrusted.invalid", **changes}


def integration(handler, values=None):
    cfg, guard = config(), SecretGuard()
    credentials = Credentials(VaultFixture(values), cfg, guard)
    service = IntegrationService(None, cfg, credentials, guard, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    service.preference_revision = AsyncMock(return_value=())
    service.ensure_enabled = AsyncMock()
    credentials.integrations = service
    return service, credentials


async def test_public_user_discovery_is_read_only_and_minimizes_remote_response():
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json=[github_item()])
    service, _ = integration(respond, {"github.read": "synthetic-read-token", "github.publish": "synthetic-write-token"})
    page = await service.github_repositories(GitHubRepositorySearch(owner_type="user", owner="fixture"))
    assert page.access == "public" and page.next_page is None
    assert page.items[0].url == "https://github.com/fixture/example"
    assert "remote-private-value" not in page.model_dump_json()
    assert requests[0].method == "GET" and requests[0].url.host == "api.github.com"
    assert "authorization" not in requests[0].headers
    await service.client.aclose()


async def test_org_discovery_uses_only_read_destination_and_bounded_page():
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(200, json=[github_item() for _ in range(30)])
    service, _ = integration(respond, {"github.publish": "synthetic-write-token"})
    page = await service.github_repositories(GitHubRepositorySearch(owner_type="org", owner="fixture", page=2))
    assert page.access == "public" and page.next_page == 3
    assert "authorization" not in seen[0].headers
    assert seen[0].url.params["per_page"] == "30" and seen[0].url.params["page"] == "2"
    await service.client.aclose()


async def test_import_revalidates_selection_and_preserves_explicit_profile_and_gates():
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(200, json=github_item(default_branch="trunk"))
    service, _ = integration(respond, {"github.read": "synthetic-read-token"})
    project = await service.github_import(GitHubRepositoryImport(owner="fixture", repository="example", name="Example", profile="node", gate_commands=[["npm", "run", "check"]]))
    assert project.repository == "https://github.com/fixture/example" and project.default_branch == "trunk"
    assert project.profile == "node" and project.gate_commands == [["npm", "run", "check"]]
    assert seen[0].url.path == "/repos/fixture/example"
    assert seen[0].headers["authorization"] == "Bearer synthetic-read-token"
    await service.client.aclose()


@pytest.mark.parametrize("changes,code", [({"full_name": "other/example"}, "GITHUB_RESPONSE_INVALID"), ({"full_name": "fixture/other"}, "GITHUB_RESPONSE_INVALID"), ({"archived": True}, "GITHUB_REPOSITORY_INACTIVE"), ({"default_branch": None}, "GITHUB_REPOSITORY_INACTIVE")])
async def test_import_rejects_changed_or_inactive_repository(changes, code):
    service, _ = integration(lambda _: httpx.Response(200, json=github_item(**changes)))
    with pytest.raises(DomainError) as error:
        await service.github_import(GitHubRepositoryImport(owner="fixture", repository="example", name="Example", profile="node", gate_commands=[["npm", "test"]]))
    assert error.value.code == code
    await service.client.aclose()


@pytest.mark.parametrize("response", [httpx.Response(302, headers={"Location": "https://untrusted.invalid"}), httpx.Response(401, text="private-remote-error"), httpx.Response(200, content=b"x" * 2_000_001), httpx.Response(200, json=[github_item(private="false")]), httpx.Response(200, content=b"[[invalid")])
async def test_remote_failures_are_sanitized_without_redirect_or_partial_success(response):
    calls = []
    def respond(request):
        calls.append(request)
        return response
    service, _ = integration(respond)
    with pytest.raises(DomainError) as error:
        await service.github_repositories(GitHubRepositorySearch(owner_type="user", owner="fixture"))
    assert "private-remote-error" not in str(error.value)
    assert len(calls) == 1
    await service.client.aclose()


async def test_disabled_read_and_publish_block_resolution_without_revealing_secret():
    service, credentials = integration(lambda _: pytest.fail("No request expected"), {"github.read": "synthetic-read-token"})
    service.ensure_enabled.side_effect = DomainError("INTEGRATION_DISABLED", "Desactivada")
    for identifier in ("github.read", "github.publish"):
        with pytest.raises(DomainError, match="Desactivada"):
            await credentials.resolve(identifier)
    assert credentials.values == {}
    await service.client.aclose()


async def test_anonymous_mcp_preference_change_invalidates_existing_credential_revision():
    service, credentials = integration(lambda _: pytest.fail("No request expected"))
    revision = await credentials.refresh()
    service.preference_revision.return_value = (("mcp.example", False, 1),)
    with pytest.raises(DomainError) as error:
        await credentials.assert_current(revision)
    assert error.value.code == "CREDENTIALS_CHANGED"
    await service.client.aclose()


async def test_disabled_anonymous_mcp_blocks_discovery_before_any_model_call(monkeypatch):
    cfg = config(mcp_servers={"example": MCPServerSettings(endpoint="https://example.org/mcp", tools={})})
    guard, model = SecretGuard(), ScriptedModel()
    credentials = Credentials(VaultFixture(), cfg, guard)
    service = IntegrationService(None, cfg, credentials, guard)
    service.preference_revision = AsyncMock(return_value=(("mcp.example", False, 1),))
    service.ensure_enabled = AsyncMock(side_effect=DomainError("INTEGRATION_DISABLED", "Desactivada"))
    credentials.integrations = service
    discovery = AsyncMock()
    monkeypatch.setattr("sabre.agents.MCPToolAdapter.discover", discovery)
    project = Project(name="Example", repository="https://github.com/fixture/example", profile="node", gate_commands=[["npm", "test"]], allowed_mcp_servers=["example"])
    work = WorkOrder(project_id=project.id, mode="patch", objective="Fix example behavior", acceptance=["Regression passes"], budget=Budget(), idempotency_key="disabled-mcp-fixture")
    team = AgentTeam(cfg, None, None, guard, model_factory=lambda: model, credentials=credentials)
    with pytest.raises(DomainError) as error:
        await team.run("developer", work, project, "Fix example")
    assert error.value.code == "INTEGRATION_DISABLED"
    discovery.assert_not_awaited()
    assert model._calls == 0


async def test_catalog_distinguishes_permission_from_stored_credential_and_has_no_fake_toggles():
    service, _ = integration(lambda _: pytest.fail("No request expected"))
    catalog = await service.list()
    assert next(item for item in catalog if item.id == "github.read").enabled
    assert not next(item for item in catalog if item.id == "github.read").credential_configured
    assert all(not item.toggleable for item in catalog if item.kind in {"model", "slack"})
    assert all("remote-private-value" not in item.model_dump_json() for item in catalog)
    await service.client.aclose()


@pytest.mark.parametrize("value", [{"enabled": "false", "expected_revision": 0}, {"enabled": False, "expected_revision": -1}, {"enabled": False, "expected_revision": True}])
def test_connection_changes_are_strict(value):
    with pytest.raises(ValidationError):
        IntegrationStateChange.model_validate(value)


@pytest.mark.parametrize("owner", ["../owner", "owner/path", "user@host", "https://github.com/owner"])
def test_repository_discovery_rejects_urls_and_path_injection(owner):
    with pytest.raises(ValidationError):
        GitHubRepositorySearch(owner_type="user", owner=owner)
