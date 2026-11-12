"""MCP for remote agents with a delegated grant, never the owner's credential.

Every tool call authenticates its bearer again, so revocation and expiry apply to the next
call. The grant bounds projects, operations, run count and cumulative limits; delegated
runs cannot publish, change dependencies, approve architecture or answer owner decisions,
and budget, exception and policy commands do not exist on this surface.
"""

from collections.abc import Callable
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver import Context

from sabre import __version__
from sabre.commands import CommandEnvelope, CommandResult
from sabre.contracts import StrictContract
from sabre.delegation import Delegations, GrantLimits
from sabre.models import Project, WorkOrder


class GrantSummary(StrictContract):
    version: int = 1
    id: str
    principal: str
    limits: GrantLimits


def bearer(ctx: Context) -> str:
    headers: Any = getattr(ctx, "headers", None) or {}
    for name, value in dict(headers).items():
        if str(name).lower() == "authorization":
            return str(value)
    return ""


def build_delegated_mcp(service: Callable[[], Any], *, delegations: Callable[[], Any] | None = None,
                        credential: Callable[[Context], str] = bearer):
    grants = delegations or (lambda: Delegations(service()))
    server = MCPServer("SABRE delegated", version=__version__, instructions=(
        "Delegated access to a SABRE software factory. Submit work only for the projects and limits of your grant, "
        "follow the runs you submitted, answer their clarification questions and cancel them. "
        "Owner decisions, publication, budgets and security exceptions stay with the owner in the SABRE console. "
        "Never send passwords, API keys or tokens as tool arguments."
    ))

    async def grant(ctx: Context) -> dict:
        return await grants().authenticate(credential(ctx))

    @server.tool(structured_output=True)
    async def sabre_grant(ctx: Context) -> GrantSummary:
        """Describe this credential's principal, projects, operations, expiry and cumulative limits."""
        current = await grant(ctx)
        return GrantSummary(id=current["id"], principal=current["principal"], limits=GrantLimits.model_validate(current["data"]))

    @server.tool(structured_output=True)
    async def sabre_list_projects(ctx: Context) -> list[Project]:
        """List the projects this grant may submit work to."""
        allowed = set((await grant(ctx))["data"]["projects"])
        return [project for project in await service().repository.projects() if project.id in allowed]

    @server.tool(structured_output=True)
    async def sabre_command(command: CommandEnvelope, ctx: Context) -> CommandResult:
        """Submit work, answer a clarification question or cancel a run you submitted. Reuse the idempotency key on retry."""
        current = await grant(ctx)
        return await grants().execute(current["id"], command.idempotency_key, command)

    @server.tool(structured_output=True)
    async def sabre_get_work(work_id: str, ctx: Context) -> WorkOrder:
        """Read a run this grant submitted: status, phase, tasks, pending questions and evidence."""
        current = await grant(ctx)
        return await grants().query(current["id"], work_id)

    return server

