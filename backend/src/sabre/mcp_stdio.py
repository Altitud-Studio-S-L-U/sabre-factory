"""Local stdio bridge; the control credential stays inside the API container."""

import asyncio
import json
import sys

import httpx2
from mcp import Client, types
from mcp.client.streamable_http import streamable_http_client
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from sabre.security import SecretGuard
from sabre.settings import Settings


def bridge(remote, catalog, guard):
    # Native elicitation requires a direct MCP connection. The standard answer
    # tool remains available through this intentionally bounded local bridge.
    tools = [item for item in catalog.tools if item.name != "sabre_resolve_question_native"]
    by_name = {item.name: item for item in tools}

    async def list_tools(context, params):
        return types.ListToolsResult.model_validate({"tools": [item.model_dump(mode="json", by_alias=True) for item in tools]})

    async def call_tool(context, params):
        try:
            arguments = params.arguments or {}
            guard.check(arguments)
            if params.name not in by_name or len(json.dumps(arguments).encode()) > 65536:
                raise ValueError("Rejected bridge request")
            async with asyncio.timeout(60):
                result = await remote.call_tool(params.name, arguments)
            guard.check(result.model_dump(mode="json"))
            if len(result.model_dump_json().encode()) > 1048576:
                raise ValueError("Rejected bridge response")
            return types.CallToolResult(content=result.content, structuredContent=result.structured_content, isError=result.is_error)
        except Exception:
            return types.CallToolResult(content=[types.TextContent(type="text", text="MCP_BRIDGE_REQUEST_FAILED: inspect current work state before retrying an effect")], isError=True)

    return Server("sabre-factory-local", version="1", on_list_tools=list_tools, on_call_tool=call_tool,
        get_tool_input_schema=lambda name: by_name[name].input_schema if name in by_name else None)


async def main():
    token = Settings().auth_token.get_secret_value()
    guard = SecretGuard([token])
    async with httpx2.AsyncClient(headers={"Authorization": "Bearer " + token}, timeout=60, follow_redirects=False, trust_env=False) as http:
        async with Client(streamable_http_client("http://127.0.0.1:8000/mcp/", http_client=http)) as remote:
            server = bridge(remote, await remote.list_tools(), guard)
            async with stdio_server() as streams:
                await server.run(*streams, server.create_initialization_options())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        print("MCP_BRIDGE_UNAVAILABLE: start SABRE and retry the local connection", file=sys.stderr)
        sys.exit(1)
