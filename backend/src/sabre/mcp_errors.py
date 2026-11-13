"""MCP servers that tell the client why the factory refused a call."""

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError

from sabre.models import DomainError


class DomainMCPServer(MCPServer):
    """A DomainError is a refusal the factory anticipated.

    The client reads its code and message, the same pair the HTTP API returns, and can
    tell a stale plan from a busy project. Any other exception stays an opaque crash.
    """

    async def call_tool(self, name, arguments, context=None):
        try:
            return await super().call_tool(name, arguments, context)
        except UnexpectedToolError as error:
            refusal = error.__cause__
            if isinstance(refusal, DomainError):
                raise ToolError(f"{refusal.code}: {refusal.message}") from None
            raise
