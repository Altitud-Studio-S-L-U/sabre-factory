"""Owner-managed MCP connections and a public-network-only HTTP transport."""

import asyncio
import hashlib
import ipaddress
import json
import re
import socket
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

import httpx2
import jsonschema
from psycopg.types.json import Jsonb
from pydantic import Field, field_validator, model_validator

from sabre.credentials import endpoint_digest
from sabre.models import Contract, DomainError
from sabre.settings import MCPServerSettings, MCPToolSettings

MCP_CONNECTIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS mcp_connections (
 name text PRIMARY KEY, endpoint text NOT NULL, revision integer NOT NULL,
 tools jsonb NOT NULL, tool_digests jsonb NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE mcp_connections ADD COLUMN IF NOT EXISTS tool_digests jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS mcp_connection_events (
 id bigserial PRIMARY KEY, name text NOT NULL, revision integer NOT NULL,
 endpoint_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
"""
NAME_PATTERN = r"^[A-Za-z0-9_-]{1,40}$"
TOOL_PATTERN = r"^[A-Za-z0-9_.-]{1,100}$"
MAX_RESPONSE = 1_048_576
MAX_SCHEMA = 16_384
MAX_TOOLS = 100


def normalized_endpoint(value: str) -> str:
    try:
        if not isinstance(value, str) or len(value) > 2048 or any(ord(char) <= 32 or ord(char) >= 127 for char in value) or "\\" in value or "%" in value:
            raise ValueError
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError
        host = parsed.hostname.lower()
        if host.endswith(".") or len(host) > 253 or host in {"localhost", "metadata.google.internal", "host.docker.internal"} or host.endswith((".localhost", ".local", ".internal")):
            raise ValueError
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")) or "." not in host:
                raise ValueError from None
        else:
            if not public_address(address):
                raise ValueError
        port = parsed.port
        if port not in {None, 443}:
            raise ValueError
        if any(part in {".", ".."} for part in parsed.path.split("/")) or "//" in parsed.path:
            raise ValueError
        authority = f"[{host}]" if ":" in host else host
        return urlunsplit(("https", authority, parsed.path or "/", "", ""))
    except ValueError:
        raise DomainError("MCP_ENDPOINT_NOT_ALLOWED", "Use a public HTTPS endpoint on port 443 without credentials, query or fragment; local servers require explicit instance configuration", 422) from None


def public_address(address) -> bool:
    if not address.is_global or address.is_multicast:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.is_site_local or address.ipv4_mapped or address.sixtofour or address.teredo or address in ipaddress.ip_network("64:ff9b::/96") or address in ipaddress.ip_network("64:ff9b:1::/48"):
            return False
    return True


async def resolve_public(host: str) -> str:
    try:
        async with asyncio.timeout(5):
            records = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        addresses = {ipaddress.ip_address(item[4][0]) for item in records}
        if not addresses or len(addresses) > 16 or any(not public_address(address) for address in addresses):
            raise ValueError
        return str(sorted(addresses, key=lambda value: (value.version, int(value)))[0])
    except (OSError, ValueError, TimeoutError):
        raise DomainError("MCP_ENDPOINT_NOT_ALLOWED", "Could not verify a public destination for this MCP server", 422) from None


class BoundedStream(httpx2.AsyncByteStream):
    def __init__(self, source):
        self.source = source

    async def __aiter__(self):
        size = 0
        async for chunk in self.source:
            size += len(chunk)
            if size > MAX_RESPONSE:
                raise DomainError("MCP_RESPONSE_TOO_LARGE", "The MCP server exceeded the response size limit", 502)
            yield chunk

    async def aclose(self):
        await self.source.aclose()


class PublicMCPTransport(httpx2.AsyncBaseTransport):
    def __init__(self, endpoint: str, *, transport=None, resolver=resolve_public, credential_check: Callable[[], Awaitable[None]] | None = None, allowed_statuses=None):
        self.allowed_statuses = allowed_statuses
        self.endpoint = normalized_endpoint(endpoint)
        self.resolver = resolver
        self.credential_check = credential_check
        self.transport = transport or httpx2.AsyncHTTPTransport(trust_env=False, retries=0)

    async def handle_async_request(self, request):
        # The SDK follows same-origin redirects itself; reject them at the transport boundary.
        if str(request.url) != self.endpoint or request.method not in {"GET", "POST", "DELETE"}:
            raise DomainError("MCP_DESTINATION_CHANGED", "The MCP server attempted to use another destination", 502)
        address = await self.resolver(request.url.host)
        if not public_address(ipaddress.ip_address(address)):
            raise DomainError("MCP_ENDPOINT_NOT_ALLOWED", "The MCP destination is not public", 422)
        headers = request.headers.copy()
        headers["Host"] = request.url.netloc.decode("ascii")
        headers["Accept-Encoding"] = "identity"
        pinned = httpx2.Request(request.method, request.url.copy_with(host=address), headers=headers, stream=request.stream,
            extensions={**request.extensions, "sni_hostname": request.url.host})
        # Initialization and manifest reads can outlive a revocation; authorize every send.
        if self.credential_check:
            await self.credential_check()
        response = await self.transport.handle_async_request(pinned)
        if response.headers.get("content-encoding", "identity").lower() != "identity":
            await response.aclose()
            raise DomainError("MCP_RESPONSE_INVALID", "The MCP server returned an unsupported response encoding", 502)
        allowed = self.allowed_statuses or {"GET": {200, 405}, "POST": {200, 202}, "DELETE": {200, 202, 204, 405}}
        if response.status_code not in allowed[request.method]:
            await response.aclose()
            raise DomainError("MCP_REMOTE_REJECTED", "The MCP server rejected or redirected the request; check the exact endpoint and credentials", 502)
        response.stream = BoundedStream(response.stream)
        return response

    async def aclose(self):
        await self.transport.aclose()


class MCPConnectionSave(Contract):
    expected_revision: int = Field(ge=0, strict=True)
    endpoint: str = Field(min_length=1, max_length=2048)
    tools: dict[str, MCPToolSettings] = Field(default_factory=dict, max_length=MAX_TOOLS)
    tool_digests: dict[str, str] = Field(default_factory=dict, max_length=MAX_TOOLS)

    @field_validator("tools")
    @classmethod
    def validate_tools(cls, tools):
        if any(not re.fullmatch(TOOL_PATTERN, name) or not policy.roles for name, policy in tools.items()):
            raise ValueError("Select a valid tool name and at least one role")
        return tools

    @model_validator(mode="after")
    def reviewed_tools(self):
        if self.tools.keys() != self.tool_digests.keys() or any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in self.tool_digests.values()):
            raise ValueError("Every selected tool requires its reviewed contract digest")
        return self


class MCPConnectionInfo(Contract):
    name: str
    endpoint: str
    revision: int
    credential_id: str
    tools: dict[str, MCPToolSettings]
    tool_digests: dict[str, str]
    source: Literal["static", "dynamic"]


class MCPDiscoveredTool(Contract):
    name: str
    description: str
    input_schema: dict
    manifest_digest: str


class MCPDiscovery(Contract):
    connection_revision: int
    tools: list[MCPDiscoveredTool]
    truncated: bool = False


def manifest_digest(name, description, schema):
    value = {"name": name, "description": description, "input_schema": schema}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


async def read_manifest(client, guard) -> list[MCPDiscoveredTool]:
    tools: list[MCPDiscoveredTool] = []
    cursors: set[str] = set()
    cursor = None
    for _ in range(5):
        response = await client.list_tools(cursor=cursor)
        for tool in response.tools:
            schema = getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", None)
            description = tool.description or tool.name
            if not re.fullmatch(TOOL_PATTERN, tool.name) or len(description) > 2048 or not isinstance(schema, dict) or len(json.dumps(schema).encode()) > MAX_SCHEMA or len(tools) >= MAX_TOOLS:
                raise DomainError("MCP_MANIFEST_INVALID", "The MCP catalog exceeds limits or contains an invalid contract", 502)
            jsonschema.Draft202012Validator.check_schema(schema)
            item = MCPDiscoveredTool(name=tool.name, description=description, input_schema=schema,
                manifest_digest=manifest_digest(tool.name, description, schema))
            guard.check(item.model_dump())
            tools.append(item)
        cursor = getattr(response, "next_cursor", None) or getattr(response, "nextCursor", None)
        if not cursor:
            break
        if not isinstance(cursor, str) or len(cursor) > 1024 or cursor in cursors:
            raise DomainError("MCP_MANIFEST_INVALID", "The MCP catalog contains repeated pages", 502)
        cursors.add(cursor)
    else:
        raise DomainError("MCP_MANIFEST_INVALID", "The MCP catalog exceeds the page limit", 502)
    if len({tool.name for tool in tools}) != len(tools):
        raise DomainError("MCP_MANIFEST_INVALID", "The MCP catalog contains duplicate tools", 502)
    return tools


class ReviewedMCPClient:
    def __init__(self, client, digests, guard):
        self.client, self.digests, self.guard = client, digests, guard

    async def list_tools(self):
        tools = await read_manifest(self.client, self.guard)
        actual = {tool.name: tool.manifest_digest for tool in tools}
        if any(actual.get(name) != digest for name, digest in self.digests.items()):
            raise DomainError("MCP_TOOL_CONTRACT_CHANGED", "An MCP tool differs from the reviewed contract; discover and review the connection again", 409)
        return SimpleNamespace(tools=tools)

    async def call_tool(self, name, arguments):
        if name not in self.digests:
            raise DomainError("MCP_TOOL_NOT_REVIEWED", "The MCP tool has no reviewed contract", 403)
        await self.list_tools()
        return await self.client.call_tool(name, arguments)


class MCPConnectionStore:
    def __init__(self, repository, config, guard):
        self.repository, self.guard = repository, guard
        self.static_servers = {name: server.model_copy(deep=True) for name, server in config.mcp_servers.items()}

    async def revision(self):
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT name,revision FROM mcp_connections ORDER BY name")).fetchall()
        return tuple((row["name"], row["revision"]) for row in rows)

    async def snapshot(self):
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT name,endpoint,revision,tools,tool_digests FROM mcp_connections ORDER BY name")).fetchall()
        if len(rows) > 50 or any(row["name"] in self.static_servers for row in rows):
            raise DomainError("MCP_REGISTRY_CONFLICT", "The MCP registry requires review; duplicate names or too many connections were found")
        values = {}
        for row in rows:
            if not re.fullmatch(NAME_PATTERN, row["name"]):
                raise DomainError("MCP_REGISTRY_CONFLICT", "The MCP registry contains an invalid name")
            request = MCPConnectionSave(expected_revision=row["revision"], endpoint=row["endpoint"], tools=row["tools"], tool_digests=row["tool_digests"])
            endpoint = normalized_endpoint(request.endpoint)
            self.guard.check(request.model_dump(mode="json"))
            values[row["name"]] = MCPServerSettings(endpoint=endpoint, tools=request.tools, tool_digests=request.tool_digests)
        return values, tuple((row["name"], row["revision"]) for row in rows)

    @staticmethod
    def _info(name, endpoint, revision, tools, source, tool_digests):
        return MCPConnectionInfo(name=name, endpoint=endpoint, revision=revision, tools=tools, tool_digests=tool_digests,
            credential_id=f"mcp.{name}.{endpoint_digest(endpoint)}.token", source=source)

    async def list(self) -> list[MCPConnectionInfo]:
        dynamic, revision = await self.snapshot()
        revisions = dict(revision)
        values = [self._info(name, server.endpoint, 0, server.tools, "static", server.tool_digests) for name, server in sorted(self.static_servers.items())]
        values += [self._info(name, server.endpoint, revisions[name], server.tools, "dynamic", server.tool_digests) for name, server in dynamic.items()]
        self.guard.check([value.model_dump(mode="json") for value in values])
        return values

    async def save(self, name: str, request: MCPConnectionSave) -> MCPConnectionInfo:
        if not re.fullmatch(NAME_PATTERN, name) or name in self.static_servers:
            raise DomainError("MCP_NAME_RESERVED", "Choose a valid MCP name that is not reserved by instance configuration", 422)
        self.guard.check(request.model_dump(mode="json"))
        endpoint = normalized_endpoint(request.endpoint)
        self.guard.check({"name": name, "endpoint": endpoint, "tools": request.model_dump(mode="json")["tools"]})
        async with self.repository.connection() as conn:
            # Serializes creation limits, edits and the corresponding activation switch together.
            await conn.execute("SELECT pg_advisory_xact_lock(813785)")
            row = await (await conn.execute("SELECT revision FROM mcp_connections WHERE name=%s FOR UPDATE", (name,))).fetchone()
            revision = row["revision"] if row else 0
            if revision != request.expected_revision:
                raise DomainError("MCP_CONNECTION_CHANGED", "The MCP connection changed; refresh before saving", 409)
            if row is None:
                count = await (await conn.execute("SELECT count(*) n FROM mcp_connections")).fetchone()
                if count["n"] >= 50:
                    raise DomainError("MCP_CONNECTION_LIMIT", "The MCP connection limit was reached", 409)
            revision += 1
            await conn.execute("INSERT INTO mcp_connections(name,endpoint,revision,tools,tool_digests) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(name) DO UPDATE SET endpoint=excluded.endpoint,revision=excluded.revision,tools=excluded.tools,tool_digests=excluded.tool_digests,updated_at=clock_timestamp()", (name, endpoint, revision, Jsonb(request.model_dump(mode="json")["tools"]), Jsonb(request.tool_digests)))
            preference = await (await conn.execute("INSERT INTO integration_preferences(id,enabled,revision) VALUES(%s,false,1) ON CONFLICT(id) DO UPDATE SET enabled=false,revision=integration_preferences.revision+1,updated_at=clock_timestamp() RETURNING revision", (f"mcp.{name}",))).fetchone()
            await conn.execute("INSERT INTO integration_events(integration_id,revision,enabled) VALUES(%s,%s,false)", (f"mcp.{name}", preference["revision"]))
            await conn.execute("INSERT INTO mcp_connection_events(name,revision,endpoint_digest) VALUES(%s,%s,%s)", (name, revision, endpoint_digest(endpoint)))
        return self._info(name, endpoint, revision, request.tools, "dynamic", request.tool_digests)

    def client_factory(self, name: str, endpoint: str, token: str | None, *, credential_check: Callable[[], Awaitable[None]], verify_manifest=True):
        @asynccontextmanager
        async def connect():
            from mcp import Client
            from mcp.client.streamable_http import streamable_http_client

            dynamic, _ = await self.snapshot()
            if name not in dynamic or dynamic[name].endpoint != endpoint:
                raise DomainError("MCP_CONNECTION_CHANGED", "The MCP destination changed; reload the connection", 409)
            async def discard_log(*args, **kwargs):
                return None
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            async with httpx2.AsyncClient(transport=PublicMCPTransport(endpoint, credential_check=credential_check), headers=headers, timeout=httpx2.Timeout(10, read=30), trust_env=False, follow_redirects=False) as http_client:
                transport = streamable_http_client(endpoint, http_client=http_client, max_sse_event_size=MAX_RESPONSE)
                async with Client(transport, read_timeout_seconds=30, logging_callback=discard_log, cache=None) as client:
                    yield ReviewedMCPClient(client, dynamic[name].tool_digests, self.guard) if verify_manifest else client
        return connect

    async def discover(self, name: str, expected_revision: int, credentials) -> MCPDiscovery:
        credential_revision = await credentials.refresh()
        dynamic, revision = await self.snapshot()
        if name not in dynamic or dict(revision).get(name) != expected_revision:
            raise DomainError("MCP_CONNECTION_CHANGED", "Select a dynamic MCP connection and its current revision", 409)
        server = dynamic[name]
        identifier = f"mcp.{name}.{endpoint_digest(server.endpoint)}.token"
        token = (await credentials.resolve(identifier)).get_secret_value() or None
        async def check_current():
            # Owner discovery is allowed while disabled, but never with a stale destination/key.
            await credentials.assert_current(credential_revision)
        try:
            async with asyncio.timeout(30):
                async with self.client_factory(name, server.endpoint, token, credential_check=check_current, verify_manifest=False)() as client:
                    tools = await read_manifest(client, self.guard)
        except DomainError:
            raise
        except Exception:
            raise DomainError("MCP_DISCOVERY_FAILED", "Could not verify the MCP catalog within limits; check the exact endpoint and credentials", 502) from None
        if revision != await self.revision():
            raise DomainError("MCP_CONNECTION_CHANGED", "The MCP connection changed during the query; refresh the catalog", 409)
        return MCPDiscovery(connection_revision=expected_revision, tools=tools)
