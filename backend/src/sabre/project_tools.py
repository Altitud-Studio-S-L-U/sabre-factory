"""Versioned MCP assignments; the project's allowed server list remains authoritative."""

from typing import Annotated

from psycopg.types.json import Jsonb
from pydantic import Field, field_validator

from sabre.models import Contract, DomainError

PROJECT_TOOLS_SCHEMA = """
CREATE TABLE IF NOT EXISTS project_tool_revisions (
    project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE IF NOT EXISTS project_tool_events (
    id bigserial PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision integer NOT NULL,
    servers jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
"""

ServerName = Annotated[str, Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$", strict=True)]


class ProjectToolsPolicy(Contract):
    project_id: str
    revision: int = Field(ge=0)
    servers: list[ServerName] = Field(max_length=64)


class ProjectToolsChange(Contract):
    expected_revision: int = Field(ge=0, strict=True)
    servers: list[ServerName] = Field(max_length=64)

    @field_validator("servers")
    @classmethod
    def unique_servers(cls, values):
        if len(values) != len(set(values)):
            raise ValueError("MCP server names must be unique")
        return values


class ProjectToolService:
    def __init__(self, repository, connections, guard):
        self.repository, self.connections, self.guard = repository, connections, guard

    async def get(self, project_id: str) -> ProjectToolsPolicy:
        async with self.repository.connection() as conn:
            row = await (await conn.execute("""SELECT p.id,p.data->'allowed_mcp_servers' AS servers,
                coalesce(r.revision,0) AS revision FROM projects p
                LEFT JOIN project_tool_revisions r ON r.project_id=p.id WHERE p.id=%s""", (project_id,))).fetchone()
        if row is None:
            raise DomainError("PROJECT_NOT_FOUND", "Project not found", 404)
        result = ProjectToolsPolicy(project_id=row["id"], revision=row["revision"], servers=row["servers"] or [])
        self.guard.check(result.model_dump())
        return result

    async def change(self, project_id: str, change: ProjectToolsChange) -> ProjectToolsPolicy:
        self.guard.check(change.model_dump())
        await self.repository.project(project_id)
        async with self.repository.project_lock(project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Pause the work order and wait for the project to become idle before changing tools", 409)
            async with self.repository.connection() as conn:
                project = await (await conn.execute("SELECT id FROM projects WHERE id=%s FOR UPDATE", (project_id,))).fetchone()
                if project is None:
                    raise DomainError("PROJECT_NOT_FOUND", "Project not found", 404)
                known = {connection.name for connection in await self.connections.list()}
                if any(name not in known for name in change.servers):
                    raise DomainError("MCP_SERVER_NOT_CONFIGURED", "Select only registered MCP connections", 422)
                await conn.execute("INSERT INTO project_tool_revisions(project_id) VALUES(%s) ON CONFLICT DO NOTHING", (project_id,))
                row = await (await conn.execute("SELECT revision FROM project_tool_revisions WHERE project_id=%s FOR UPDATE", (project_id,))).fetchone()
                if row["revision"] != change.expected_revision:
                    raise DomainError("PROJECT_TOOLS_CHANGED", "Project tools changed; refresh before saving", 409)
                revision = row["revision"] + 1
                await conn.execute("UPDATE projects SET data=jsonb_set(data,'{allowed_mcp_servers}',%s,true) WHERE id=%s", (Jsonb(change.servers), project_id))
                await conn.execute("UPDATE project_tool_revisions SET revision=%s WHERE project_id=%s", (revision, project_id))
                await conn.execute("INSERT INTO project_tool_events(project_id,revision,servers) VALUES(%s,%s,%s)", (project_id, revision, Jsonb(change.servers)))
                result = ProjectToolsPolicy(project_id=project_id, revision=revision, servers=change.servers)
                self.guard.check(result.model_dump())
                return result
