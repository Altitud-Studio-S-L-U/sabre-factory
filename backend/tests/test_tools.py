import asyncio

import pytest
from mcp import Client
from mcp.server import MCPServer

from sabre.models import DomainError
from sabre.security import SecretGuard
from sabre.tools import MCPToolAdapter, ToolCatalog, ToolDefinition, ToolPolicy, workspace_tools


async def test_catalog_checks_role_schema_and_external_effect_before_dispatch():
    called = []

    async def handler(value: int):
        called.append(value)
        return {"value": value}

    catalog = ToolCatalog()
    catalog.register(ToolDefinition("action", "A controlled action.", {
        "type": "object", "properties": {"value": {"type": "integer"}}, "required": ["value"], "additionalProperties": False,
    }, ToolPolicy(frozenset({"developer"}), "external_write"), handler))
    for arguments, role, allowed, code in [
        ({"value": 1}, "reviewer", True, "TOOL_NOT_ALLOWED"),
        ({"value": 1}, "developer", False, "TOOL_APPROVAL_REQUIRED"),
        ({"value": "wrong"}, "developer", True, "INVALID_TOOL_ARGUMENTS"),
    ]:
        with pytest.raises(DomainError) as error:
            await catalog.invoke("action", arguments, role, allow_external_write=allowed)
        assert error.value.code == code
    assert called == []
    assert await catalog.invoke("action", {"value": 3}, "developer", allow_external_write=True) == {"value": 3}
    assert catalog.for_role("developer") == []


async def test_external_timeout_is_unknown_and_is_not_retried():
    called = []

    async def slow():
        called.append(True)
        await asyncio.sleep(1)

    catalog = ToolCatalog()
    catalog.register(ToolDefinition("slow", "Potentially mutating.", {"type": "object"}, ToolPolicy(frozenset({"supervisor"}), "external_write", 0.01), slow))
    with pytest.raises(DomainError) as error:
        await catalog.invoke("slow", {}, "supervisor", allow_external_write=True)
    assert error.value.code == "TOOL_EFFECT_UNKNOWN"
    assert called == [True]


@pytest.mark.parametrize("field", ["name", "description", "schema"])
def test_tool_metadata_is_checked_before_it_can_be_sent_to_a_model(field):
    secret = "synthetic-private-metadata-value"
    name, description, schema = "lookup", "Read an approved record.", {"type": "object"}
    if field == "name":
        name = secret
    elif field == "description":
        description = secret
    else:
        schema["properties"] = {"token": {"type": "string", "default": secret}}

    async def handler():
        return None

    catalog = ToolCatalog(SecretGuard([secret]))
    with pytest.raises(DomainError) as error:
        catalog.register(ToolDefinition(name, description, schema, ToolPolicy(frozenset({"analyst"}), "read"), handler))
    assert error.value.code == "SECRET_DETECTED"
    assert catalog.tools == {}


async def test_mcp_sdk2_in_memory_discovery_and_langchain_invocation():
    server = MCPServer("test-tools")

    @server.tool()
    def add(left: int, right: int) -> dict[str, int]:
        """Add integers."""
        return {"total": left + right}

    @server.tool()
    def unapproved() -> str:
        return "must not be offered"

    adapter = MCPToolAdapter("http://localhost:9999/mcp", ["http://localhost:9999/mcp"], client_factory=lambda: Client(server))
    definitions = await adapter.discover({"add": ToolPolicy(frozenset({"analyst"}), "read")})
    assert [definition.name for definition in definitions] == ["add"]
    catalog = ToolCatalog()
    catalog.register(definitions[0])
    assert await catalog.invoke("add", {"left": 2, "right": 4}, "analyst") == {"total": 6}
    assert await catalog.for_role("analyst")[0].ainvoke({"left": 4, "right": 5}) == {"total": 9}


def test_external_server_must_be_explicit_and_transport_safe():
    with pytest.raises(DomainError):
        MCPToolAdapter("https://other.example/mcp", ["https://approved.example/mcp"])
    with pytest.raises(DomainError):
        MCPToolAdapter("http://public.example/mcp", ["http://public.example/mcp"])


async def test_qa_cannot_edit_or_execute_an_unapproved_command():
    executed = []

    class Executor:
        async def execute(self, work_id, argv):
            pytest.fail("QA must not execute against the source workspace")

        async def snapshot(self, work_id):
            executed.append("snapshot")
            return {"digest": "a" * 64}

        async def execute_gate(self, work_id, argv, digest):
            from sabre.executor import ExecutionResult
            executed.append((argv, digest))
            return ExecutionResult(exit_code=0, output="passed")

        async def list_files(self, work_id):
            return ["src/app.py"]

    catalog = workspace_tools(Executor(), "work", gate_commands=[["python", "-m", "unittest"]], role="qa")
    assert "write_file" not in {tool.name for tool in catalog.for_role("qa")}
    with pytest.raises(DomainError):
        await catalog.invoke("write_file", {"path": "test.py", "content": "weakened"}, "qa")
    with pytest.raises(DomainError):
        await catalog.invoke("execute", {"argv": ["python", "-c", "mutate()"]}, "qa")
    with pytest.raises(DomainError):
        await catalog.invoke("execute", {"argv": ["python", "-m", "unittest"]}, "developer")
    developer_catalog = workspace_tools(Executor(), "work", gate_commands=[["python", "-m", "unittest"]], role="developer")
    with pytest.raises(DomainError):
        await developer_catalog.invoke("execute", {"argv": ["python", "-m", "unittest"]}, "qa")
    assert executed == []
    assert await catalog.invoke("execute", {"argv": ["python", "-m", "unittest"]}, "qa") == {"exit_code": 0, "output": "passed"}
    assert executed == ["snapshot", (["python", "-m", "unittest"], "a" * 64)]
    assert await catalog.invoke("list_files", {}, "supervisor") == ["src/app.py"]
