"""Role-scoped tools and the small MCP-to-LangChain boundary."""

import asyncio
import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager, nullcontext
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

import jsonschema
from langchain_core.tools import StructuredTool
from referencing import Registry
from referencing.exceptions import Unresolvable

from sabre.error_boundaries import guarded_call
from sabre.models import DomainError
from sabre.security import SecretGuard
from sabre.telemetry import span, tool_call


def result_bytes(result: Any) -> int:
    """UTF-8 size of a tool result as the model receives it (strings verbatim, other values as JSON)."""
    if isinstance(result, str):
        return len(result.encode())
    try:
        return len(json.dumps(result, ensure_ascii=False, separators=(",", ":"), default=str).encode())
    except (TypeError, ValueError, RecursionError):
        return len(str(result).encode())


@dataclass(frozen=True)
class ToolPolicy:
    roles: frozenset[str]
    effect: Literal["read", "workspace_write", "external_write"] = "external_write"
    timeout_s: int = 60


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    policy: ToolPolicy
    handler: Callable[..., Awaitable[Any]]
    argument_policy: Callable[[dict, str], None] | None = None
    delegated_authorization: bool = False
    # An external tool the owner reviewed by name: only then does telemetry name it.
    reviewed: bool = False


# The tools the factory itself gives a specialist. Only these are named in telemetry and in the run
# audit; an external tool is named only when the owner reviewed it. The console's list of built-in
# tools is checked against this set, so a tool added here has to be shown there.
INTERNAL_TOOLS = frozenset({"list_files", "read_file", "read_files", "search_source", "read_file_range", "write_file", "execute", "prepare_dependencies", "resolve_dependencies", "read_context", "read_memory", "edit_source", "record_note", "propose_memory"})


class ToolCatalog:
    def __init__(self, guard: SecretGuard | None = None):
        self.guard = guard or SecretGuard()
        self.tools: dict[str, ToolDefinition] = {}
        # The run these tools belong to, for the tool span; None for a catalog outside a run.
        self.work_id: str | None = None
        self.observer: Callable[[str], AbstractAsyncContextManager] | None = None
        self.credential_check: Callable[[], Awaitable[None]] | None = None

    def register(self, definition: ToolDefinition) -> None:
        if definition.name in self.tools:
            raise DomainError("DUPLICATE_TOOL", "A tool with that name already exists")
        jsonschema.Draft202012Validator.check_schema(definition.input_schema)
        self.guard.check([definition.name, definition.description, definition.input_schema])
        self.tools[definition.name] = definition

    async def invoke(self, name: str, arguments: dict, role: str, *, allow_external_write=False):
        definition = self.tools.get(name)
        named = name in INTERNAL_TOOLS or (definition is not None and definition.reviewed and re.fullmatch(r"[A-Za-z0-9_/:.-]{1,200}", name))
        # Any other external tool is counted without its name: that name was never reviewed.
        with span("tool.call", tool=name if named else "mcp", role=role, work_id=self.work_id, tool_call_id=tool_call.get()):
            async with self.observer(name) if self.observer else nullcontext() as boundary:
                result = await guarded_call(self._invoke, self.guard, "TOOL_EXECUTION_FAILED", name, arguments, role, allow_external_write=allow_external_write)
                if boundary is not None:
                    boundary.output_bytes = result_bytes(result)
                return result

    async def _invoke(self, name: str, arguments: dict, role: str, *, allow_external_write=False):
        if self.credential_check:
            await self.credential_check()
        definition = self.tools.get(name)
        if definition is None or role not in definition.policy.roles:
            raise DomainError("TOOL_NOT_ALLOWED", "The tool is not authorized for this role", 403)
        if definition.policy.effect == "external_write" and not allow_external_write:
            raise DomainError("TOOL_APPROVAL_REQUIRED", "This tool requires external-effect authorization", 403)
        self.guard.check(arguments)
        try:
            jsonschema.Draft202012Validator(definition.input_schema, registry=Registry()).validate(arguments)
        except (jsonschema.ValidationError, Unresolvable):
            raise DomainError("INVALID_TOOL_ARGUMENTS", "Arguments violate the tool contract", 422) from None
        if definition.argument_policy:
            definition.argument_policy(arguments, role)
        try:
            async with asyncio.timeout(definition.policy.timeout_s):
                result = await definition.handler(**arguments)
        except TimeoutError:
            code = "TOOL_EFFECT_UNKNOWN" if definition.policy.effect == "external_write" else "TOOL_TIMEOUT"
            raise DomainError(code, "No result arrived within the limit; external effects require reconciliation") from None
        self.guard.check(result)
        if self.credential_check:
            await self.credential_check()
        return result

    def for_role(self, role: str) -> list[StructuredTool]:
        tools = []
        for definition in self.tools.values():
            if role not in definition.policy.roles or (definition.policy.effect == "external_write" and not definition.delegated_authorization):
                continue

            def make_handler(tool_name: str, authorized: bool):
                async def call(**arguments):
                    return await self.invoke(tool_name, arguments, role, allow_external_write=authorized)
                return call

            tools.append(StructuredTool.from_function(
                coroutine=make_handler(definition.name, definition.delegated_authorization), name=definition.name,
                description=definition.description, args_schema=definition.input_schema,
            ))
        return tools


class MCPToolAdapter:
    """Explicit server and tool allowlists; remote annotations never grant access."""

    def __init__(self, endpoint: str, allowed_endpoints: list[str], guard: SecretGuard | None = None,
                 token: str | None = None, client_factory=None):
        parsed = urlsplit(endpoint)
        if endpoint not in allowed_endpoints or parsed.username or parsed.password or parsed.fragment:
            raise DomainError("MCP_SERVER_NOT_ALLOWED", "The MCP server is unauthorized", 403)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}):
            raise DomainError("MCP_SERVER_NOT_ALLOWED", "The MCP server requires HTTPS or loopback", 403)
        self.endpoint, self.token = endpoint, token
        self.guard, self.client_factory = guard or SecretGuard(), client_factory

    @asynccontextmanager
    async def _client(self):
        from mcp import Client

        if self.client_factory:
            async with self.client_factory() as client:
                yield client
        elif self.token:
            import httpx2
            from mcp.client.streamable_http import streamable_http_client

            async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {self.token}"}, timeout=httpx2.Timeout(30, read=120)) as http_client:
                async with Client(streamable_http_client(self.endpoint, http_client=http_client)) as client:
                    yield client
        else:
            async with Client(self.endpoint) as client:
                yield client

    async def discover(self, policies: dict[str, ToolPolicy]) -> list[ToolDefinition]:
        async with self._client() as client:
            result = await client.list_tools()
        definitions = []
        for tool in result.tools:
            if tool.name not in policies:
                continue
            description = tool.description or tool.name
            self.guard.check(description)
            schema = getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", None)
            if not isinstance(schema, dict):
                raise DomainError("MCP_INVALID_TOOL", "The server did not return a valid argument contract", 502)

            def make_handler(name: str):
                async def call(**arguments):
                    self.guard.check(arguments)
                    async with self._client() as active:
                        response = await active.call_tool(name, arguments)
                    is_error = getattr(response, "is_error", False) or getattr(response, "isError", False)
                    if is_error:
                        raise DomainError("MCP_TOOL_FAILED", "The MCP server reported a failure")
                    structured = getattr(response, "structured_content", None)
                    if structured is None:
                        structured = getattr(response, "structuredContent", None)
                    value = structured if structured is not None else [item.model_dump(mode="json") for item in response.content]
                    self.guard.check(value)
                    return value
                return call

            definitions.append(ToolDefinition(tool.name, description, schema, policies[tool.name], make_handler(tool.name)))
        return definitions


# Tool results return to the model on every later turn, so each one is bounded. A bounded
# result says what was omitted and how to continue; full command output stays recoverable.
MAX_READ_BYTES = 32768
MAX_LISTED_FILES = 500
MAX_OUTPUT_HEAD_BYTES = 4096
MAX_OUTPUT_TAIL_BYTES = 12288
MAX_BATCH_FILES = 8
MAX_BATCH_BYTES = 49152
# Per-file faults that should not discard the other files of a batch.
BATCH_FILE_ERRORS = frozenset({"WORKSPACE_IO_FAILED", "UNSAFE_PATH", "RESERVED_PATH", "SOURCE_NOT_FOUND"})


def prefix_at_line(text: str, limit: int) -> str:
    raw = text.encode()
    if len(raw) <= limit:
        return text
    head = raw[:limit].decode("utf-8", errors="ignore")
    cut = head.rfind("\n")
    return head[:cut + 1] if cut > 0 else head


def bounded_read(path: str, content: str, limit: int = MAX_READ_BYTES):
    raw = content.encode()
    if len(raw) <= limit:
        return content
    shown = prefix_at_line(content, limit)
    lines = shown.count("\n")
    return {"path": path, "content": shown, "truncated": True, "total_bytes": len(raw),
            "total_lines": content.count("\n") + (not content.endswith("\n")), "shown_lines": lines,
            "content_digest": hashlib.sha256(raw).hexdigest(),
            "next": f"Continue with read_file_range from line {lines + 1} using this content_digest, or search_source for a symbol."}


def bounded_files(files: list[str]):
    if len(files) <= MAX_LISTED_FILES:
        return files
    return {"files": files[:MAX_LISTED_FILES], "truncated": True, "total_files": len(files),
            "next": "Use search_source with path_prefix to narrow the listing."}


def bounded_execution(value: dict, artifacts=None) -> dict:
    output = value.get("output")
    if not isinstance(output, str):
        return value
    raw = output.encode()
    if len(raw) <= MAX_OUTPUT_HEAD_BYTES + MAX_OUTPUT_TAIL_BYTES:
        return value
    head = raw[:MAX_OUTPUT_HEAD_BYTES].decode("utf-8", errors="ignore")
    tail = raw[-MAX_OUTPUT_TAIL_BYTES:].decode("utf-8", errors="ignore")
    omitted = len(raw) - len(head.encode()) - len(tail.encode())
    bounded = {**value, "output": f"{head}\n[... {omitted} bytes omitted ...]\n{tail}", "output_truncated": True, "output_bytes": len(raw)}
    if artifacts is not None:
        bounded["output_digest"] = artifacts.put(raw)
    return bounded


def workspace_tools(executor, work_id: str, guard: SecretGuard | None = None,
                    gate_commands: list[list[str]] | None = None, *, source_context=None, role: str = "developer",
                    artifacts=None) -> ToolCatalog:
    catalog = ToolCatalog(guard)
    readers = frozenset({"supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security"})

    async def list_files():
        return bounded_files(await executor.list_files(work_id))

    async def read_file(path: str):
        return bounded_read(path, await executor.read_file(work_id, path))

    async def read_files(paths: list[str]):
        remaining, results = MAX_BATCH_BYTES, []
        for path in paths:
            if remaining <= 0:
                results.append({"path": path, "omitted": True, "reason": "batch_limit"})
                continue
            try:
                content = await executor.read_file(work_id, path)
            except DomainError as error:
                if error.code not in BATCH_FILE_ERRORS or (error.code == "WORKSPACE_IO_FAILED" and error.status_code != 422):
                    raise
                results.append({"path": path, "error": {"code": error.code, "message": error.message}})
                continue
            value = bounded_read(path, content, min(MAX_READ_BYTES, remaining))
            shown = value if isinstance(value, str) else value["content"]
            remaining -= len(shown.encode())
            results.append({"path": path, "content": value} if isinstance(value, str) else value)
        return {"files": results}

    async def write_file(path: str, content: str):
        if content.lstrip().startswith('{"sabre_context_reference"'):
            # Earlier write content may be shown as a reference; copying one would destroy the file.
            raise DomainError("CONTEXT_REFERENCE_CONTENT", "This content is a historical context reference, not file content. "
                              "Recover the original with read_context or write the intended content", 422)
        await executor.write_file(work_id, path, content)
        return {"written": True}

    async def execute(argv: list[str]):
        if role == "qa":
            snapshot = await executor.snapshot(work_id)
            result = await executor.execute_gate(work_id, argv, snapshot["digest"])
        else:
            result = await executor.execute(work_id, argv)
        return bounded_execution(result.model_dump(mode="json"), artifacts)

    async def prepare_dependencies():
        await executor.prepare_dependencies(work_id)
        return {"prepared": True}

    async def resolve_dependencies():
        return await executor.resolve_dependencies(work_id)

    def authorize_execution(arguments: dict, role: str):
        if role == "qa" and arguments["argv"] not in (gate_commands or []):
            raise DomainError("TOOL_NOT_ALLOWED", "QA may only execute authorized verification commands", 403)

    path_schema = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}
    catalog.register(ToolDefinition("list_files", "List the files in the assigned workspace.", {"type": "object", "properties": {}, "additionalProperties": False}, ToolPolicy(readers, "read"), list_files))
    catalog.register(ToolDefinition("read_file", "Read one UTF-8 source file from the assigned workspace.", path_schema, ToolPolicy(readers, "read"), read_file))
    catalog.register(ToolDefinition("read_files", f"Read up to {MAX_BATCH_FILES} UTF-8 source files in one call ({MAX_BATCH_BYTES // 1024} KiB in total). Prefer this to several read_file calls. A missing file reports an error entry without discarding the others.", {
        "type": "object", "properties": {"paths": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 1024},
            "minItems": 1, "maxItems": MAX_BATCH_FILES, "uniqueItems": True}},
        "required": ["paths"], "additionalProperties": False,
    }, ToolPolicy(readers, "read"), read_files))
    if source_context is not None:
        catalog.register(ToolDefinition("search_source", "Find literal, case-sensitive source text in the current snapshot. Returns bounded line previews and file digests; skipped files are not searched. Use snapshot_digest with next_offset to continue the same snapshot.", {
            "type": "object", "properties": {"query": {"type": "string", "minLength": 1, "maxLength": 200}, "path_prefix": {"type": "string", "maxLength": 1024},
                "offset": {"type": "integer", "minimum": 0, "maximum": 2147483647}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}, "snapshot_digest": {"type": "string", "pattern": "^[a-f0-9]{64}$"}},
            "required": ["query"], "additionalProperties": False,
        }, ToolPolicy(readers, "read"), source_context.search_source))
        catalog.register(ToolDefinition("read_file_range", "Read up to 120 lines and 12 KiB from the current snapshot. Supply the content_digest from navigation/search; changed files are rejected. Follow next_line for an output truncated at a line boundary.", {
            "type": "object", "properties": {"path": {"type": "string", "minLength": 1, "maxLength": 1024}, "content_digest": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                "start_line": {"type": "integer", "minimum": 1}, "end_line": {"type": "integer", "minimum": 1}},
            "required": ["path", "content_digest", "start_line", "end_line"], "additionalProperties": False,
        }, ToolPolicy(readers, "read"), source_context.read_file_range))
    catalog.register(ToolDefinition("write_file", "Write a source file in the assigned workspace. Preserve valid tests and requirements.", {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string", "maxLength": 2_000_000}}, "required": ["path", "content"], "additionalProperties": False}, ToolPolicy(frozenset({"developer"}), "workspace_write"), write_file))
    if source_context is not None and role == "developer":
        catalog.register(ToolDefinition("edit_source", "Replace an exact source fragment atomically in the current file. Supply its current content_digest and exact expected occurrence count. Prefer this over inline editing commands; stale digests or mismatched counts leave the file unchanged.", {
            "type": "object", "properties": {"path": {"type": "string", "minLength": 1, "maxLength": 1024},
                "content_digest": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                "old_text": {"type": "string", "minLength": 1, "maxLength": 12288},
                "new_text": {"type": "string", "maxLength": 12288}, "expected_count": {"type": "integer", "minimum": 1, "maximum": 20}},
            "required": ["path", "content_digest", "old_text", "new_text"], "additionalProperties": False,
        }, ToolPolicy(frozenset({role}), "workspace_write"), source_context.edit_source))
    if role in {"developer", "qa"}:
        execution_description = "Run an approved check in a disposable copy of the current snapshot, without network. Only exact project.gate_commands argv is allowed. Outputs are discarded; this is not an authoritative gate." if role == "qa" else "Run an argv command in the isolated workspace with no network. This is not an authoritative gate."
        catalog.register(ToolDefinition("execute", execution_description, {"type": "object", "properties": {"argv": {"type": "array", "items": {"type": "string"}, "minItems": 1}}, "required": ["argv"], "additionalProperties": False}, ToolPolicy(frozenset({role}), "workspace_write", 310), execute, authorize_execution))
    catalog.register(ToolDefinition("prepare_dependencies", "Install the project's existing locked dependencies through the restricted registry proxy. Lifecycle scripts and source builds are disabled.", {"type": "object", "properties": {}, "additionalProperties": False}, ToolPolicy(frozenset({"developer"}), "workspace_write", 900), prepare_dependencies))
    catalog.register(ToolDefinition("resolve_dependencies", "Resolve exact pinned dependencies from a static approved manifest into a lockfile using only the registry proxy. Local paths, Git, URL dependencies and install hooks are rejected. Changes to dependencies must remain within the approved plan.", {"type": "object", "properties": {}, "additionalProperties": False}, ToolPolicy(frozenset({"developer"}), "workspace_write", 900), resolve_dependencies))
    return catalog
