from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from sabre.api import create_app
from sabre.models import DomainError, Project, ProjectStateChange, ProjectUpdate

HEADERS = {"Authorization": "Bearer owner-test-token-at-least-24"}
EDIT = {"expected_revision": 2, "name": "Renamed", "profile": "node", "default_branch": "main", "gate_commands": [["npm", "test"]], "browser_preview": None}


def project(**fields):
    return Project(**{"name": "Fixture", "repository": "https://github.com/example/fixture", "profile": "node", "gate_commands": [["npm", "test"]], **fields})


def application(service):
    return create_app(service, SimpleNamespace(auth_token=SecretStr("owner-test-token-at-least-24"), allowed_origins=["http://localhost:8000"]))


def client(service):
    return httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url="http://localhost:8000")


def test_an_edit_follows_the_registration_rules_and_names_every_editable_field():
    assert ProjectUpdate(**EDIT).gate_commands == [["npm", "test"]]
    for invalid in ({"default_branch": "../main"}, {"default_branch": "release.lock"}, {"gate_commands": [[]]}, {"gate_commands": []},
                    {"gate_commands": [["npm", ""]]}, {"name": ""}, {"profile": "ruby"}, {"expected_revision": -1}):
        with pytest.raises(ValidationError):
            ProjectUpdate(**{**EDIT, **invalid})
    # The repository address, the MCP grant and the accepted findings are not part of an edit.
    for foreign in ("repository", "allowed_mcp_servers", "approved_baseline", "archived_at", "revision"):
        with pytest.raises(ValidationError):
            ProjectUpdate(**{**EDIT, foreign: []})
    # Leaving a field out is not "keep it": the edit states the whole editable part.
    for required in ("name", "profile", "default_branch", "gate_commands", "browser_preview"):
        with pytest.raises(ValidationError):
            ProjectUpdate(**{key: value for key, value in EDIT.items() if key != required})
    with pytest.raises(ValidationError):
        ProjectStateChange(expected_revision=1, archived_at=None)


def test_a_project_stored_without_the_new_fields_is_active_at_revision_zero():
    stored = project().model_dump(mode="json")
    del stored["revision"], stored["archived_at"]
    loaded = Project.model_validate(stored)
    assert (loaded.revision, loaded.archived_at) == (0, None)


async def test_the_list_is_active_projects_unless_archived_ones_are_asked_for():
    repository = SimpleNamespace(projects=AsyncMock(return_value=[project()]))
    async with client(SimpleNamespace(repository=repository)) as http:
        assert (await http.get("/api/v1/projects")).status_code == 401
        repository.projects.assert_not_awaited()
        listed = await http.get("/api/v1/projects", headers=HEADERS)
        assert listed.status_code == 200 and listed.json()[0]["revision"] == 0 and listed.json()[0]["archived_at"] is None
        repository.projects.assert_awaited_with(archived=False)
        assert (await http.get("/api/v1/projects?include=archived", headers=HEADERS)).status_code == 200
        repository.projects.assert_awaited_with(archived=True)
        assert (await http.get("/api/v1/projects?include=everything", headers=HEADERS)).status_code == 422


async def test_edit_archive_and_restore_reach_the_service_with_their_revision():
    saved = project(name="Renamed", revision=3)
    service = SimpleNamespace(update_project=AsyncMock(return_value=saved), archive_project=AsyncMock(return_value=saved),
                              restore_project=AsyncMock(return_value=saved))
    async with client(service) as http:
        assert (await http.put("/api/v1/projects/p1", json=EDIT)).status_code == 401
        edited = await http.put("/api/v1/projects/p1", headers=HEADERS, json=EDIT)
        assert edited.status_code == 200 and edited.json()["revision"] == 3
        service.update_project.assert_awaited_once_with("p1", ProjectUpdate(**EDIT))
        assert (await http.post("/api/v1/projects/p1/archive", headers=HEADERS, json={"expected_revision": 3})).status_code == 200
        service.archive_project.assert_awaited_once_with("p1", ProjectStateChange(expected_revision=3))
        assert (await http.post("/api/v1/projects/p1/restore", headers=HEADERS, json={"expected_revision": 4})).status_code == 200
        service.restore_project.assert_awaited_once_with("p1", ProjectStateChange(expected_revision=4))
        # A request without its revision, or with a field that is not editable, never reaches the service.
        assert (await http.post("/api/v1/projects/p1/archive", headers=HEADERS, json={})).status_code == 422
        assert (await http.put("/api/v1/projects/p1", headers=HEADERS, json={**EDIT, "repository": "https://github.com/other/one"})).status_code == 422
        assert service.archive_project.await_count == 1 and service.update_project.await_count == 1


async def test_a_refused_change_reports_its_code_and_status():
    service = SimpleNamespace(
        update_project=AsyncMock(side_effect=DomainError("PROJECT_CHANGED", "The project changed; refresh it before continuing", 409)),
        archive_project=AsyncMock(side_effect=DomainError("PROJECT_HAS_OPEN_RUNS", "Run 12345678 is not finished; cancel it or let it finish before archiving", 409)),
        restore_project=AsyncMock(side_effect=DomainError("PROJECT_NOT_FOUND", "Project not found", 404)))
    async with client(service) as http:
        stale = await http.put("/api/v1/projects/p1", headers=HEADERS, json=EDIT)
        assert (stale.status_code, stale.json()["code"]) == (409, "PROJECT_CHANGED")
        busy = await http.post("/api/v1/projects/p1/archive", headers=HEADERS, json={"expected_revision": 0})
        assert (busy.status_code, busy.json()["code"]) == (409, "PROJECT_HAS_OPEN_RUNS") and "12345678" in busy.json()["message"]
        assert (await http.post("/api/v1/projects/missing/restore", headers=HEADERS, json={"expected_revision": 0})).status_code == 404
