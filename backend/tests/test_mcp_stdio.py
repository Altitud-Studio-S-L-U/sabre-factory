from types import SimpleNamespace

from mcp import Client

from sabre.mcp_server import build_mcp
from sabre.mcp_stdio import bridge
from sabre.models import Project
from sabre.security import SecretGuard


async def test_stdio_bridge_retains_typed_results_without_exporting_authentication():
    project = Project(name="Synthetic bridge fixture", repository="https://github.com/example/fixture",
        profile="python", gate_commands=[["python", "-m", "unittest"]])

    async def projects():
        return [project]

    service = SimpleNamespace(repository=SimpleNamespace(projects=projects))
    async with Client(build_mcp(lambda: service)) as remote:
        async with Client(bridge(remote, await remote.list_tools(), SecretGuard(["synthetic-private-control-key"]))) as local:
            catalog = await local.list_tools()
            assert "sabre_command" in {tool.name for tool in catalog.tools}
            assert "sabre_resolve_question_native" not in {tool.name for tool in catalog.tools}
            result = await local.call_tool("sabre_list_projects", {})
            assert not result.is_error
            assert project.name in result.model_dump_json()
            assert "synthetic-private-control-key" not in result.model_dump_json()
