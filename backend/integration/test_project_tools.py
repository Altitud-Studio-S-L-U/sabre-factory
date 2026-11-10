from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from psycopg import sql
from psycopg.errors import CheckViolation

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.models import DomainError, new_id
from sabre.project_tools import PROJECT_TOOLS_SCHEMA, ProjectToolsChange, ProjectToolService
from sabre.security import SecretGuard


async def setup(repository):
    repo, project, work = await fixture_work(repository)
    async with repo.connection() as conn:
        await conn.execute(PROJECT_TOOLS_SCHEMA)
    connections = SimpleNamespace(list=AsyncMock(return_value=[SimpleNamespace(name="static"), SimpleNamespace(name="dynamic")]))
    return ProjectToolService(repo, connections, SecretGuard()), repo, project, work


async def test_project_tools_update_is_scoped_preserves_other_fields_and_does_not_activate_connections(repository):
    service, repo, project, _ = await setup(repository)
    _, other, _ = await fixture_work(repository)
    before = (await repo.project(project.id)).model_dump(mode="json")
    assert (await service.get(project.id)).revision == 0
    result = await service.change(project.id, ProjectToolsChange(expected_revision=0, servers=["static", "dynamic"]))
    after = (await repo.project(project.id)).model_dump(mode="json")
    assert after == {**before, "allowed_mcp_servers": ["static", "dynamic"]}
    assert result.revision == 1 and (await service.get(project.id)) == result
    assert (await repo.project(other.id)).allowed_mcp_servers == []
    async with repo.connection() as conn:
        events = await (await conn.execute("SELECT revision,servers FROM project_tool_events WHERE project_id=%s", (project.id,))).fetchall()
        toggles = await (await conn.execute("SELECT count(*) total FROM integration_preferences WHERE id IN ('mcp.static','mcp.dynamic')")).fetchone()
    assert events == [{"revision": 1, "servers": ["static", "dynamic"]}] and toggles["total"] == 0
    restarted = ProjectToolService(repo, service.connections, service.guard)
    assert (await restarted.get(project.id)).revision == 1
    with pytest.raises(DomainError) as stale:
        await restarted.change(project.id, ProjectToolsChange(expected_revision=0, servers=[]))
    assert stale.value.code == "PROJECT_TOOLS_CHANGED"
    assert (await restarted.get(project.id)).servers == ["static", "dynamic"]


async def test_busy_unknown_server_and_missing_project_do_not_change_policy(repository):
    service, repo, project, _ = await setup(repository)
    async with repo.project_lock(project.id) as held:
        assert held
        with pytest.raises(DomainError) as busy:
            await service.change(project.id, ProjectToolsChange(expected_revision=0, servers=["static"]))
        assert busy.value.code == "PROJECT_BUSY"
    with pytest.raises(DomainError) as missing_server:
        await service.change(project.id, ProjectToolsChange(expected_revision=0, servers=["foreign"]))
    assert missing_server.value.code == "MCP_SERVER_NOT_CONFIGURED"
    with pytest.raises(DomainError) as missing_project:
        await service.get(new_id())
    assert missing_project.value.code == "PROJECT_NOT_FOUND"
    assert (await service.get(project.id)).revision == 0
    assert (await repo.project(project.id)).allowed_mcp_servers == []


async def test_audit_insert_failure_rolls_back_policy_and_revision(repository):
    service, repo, project, _ = await setup(repository)
    constraint = sql.Identifier("fixture_tool_audit_" + new_id().replace("-", ""))
    async with repo.connection() as conn:
        await conn.execute(sql.SQL("ALTER TABLE project_tool_events ADD CONSTRAINT {} CHECK(project_id <> {})").format(constraint, sql.Literal(project.id)))
    try:
        with pytest.raises(CheckViolation):
            await service.change(project.id, ProjectToolsChange(expected_revision=0, servers=["static"]))
        assert (await service.get(project.id)).revision == 0
        assert (await repo.project(project.id)).allowed_mcp_servers == []
    finally:
        async with repo.connection() as conn:
            await conn.execute(sql.SQL("ALTER TABLE project_tool_events DROP CONSTRAINT {}").format(constraint))
