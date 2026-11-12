from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
from pydantic import SecretStr

from sabre.api import create_app
from sabre.memory_contracts import MemoryApproval
from sabre.models import MemoryItem

TOKEN = "owner-test-token-at-least-24"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}
ITEM = MemoryItem(id="memory-1", project_id="project-one", kind="lesson", content="Keep empty input", source_commit="a" * 40, source_work_id="work", active=True)


def client(memory):
    application = create_app(SimpleNamespace(memory=memory), SimpleNamespace(auth_token=SecretStr(TOKEN), allowed_origins=["http://localhost:8000"]))
    return httpx.AsyncClient(transport=httpx.ASGITransport(application), base_url="http://localhost:8000")


async def test_approval_keeps_the_bodyless_call_and_accepts_owner_decisions():
    memory = SimpleNamespace(update=AsyncMock(return_value=ITEM))
    async with client(memory) as http:
        assert (await http.post("/api/v1/memory/memory-1/approve", headers=HEADERS)).status_code == 200
        assert memory.update.await_args.args == ("memory-1", True, None)
        decision = {"supersedes": "memory-0", "related": ["memory-2", "memory-2"], "scope": "project"}
        assert (await http.post("/api/v1/memory/memory-1/approve", headers=HEADERS, json=decision)).status_code == 200
        assert memory.update.await_args.args == ("memory-1", True, MemoryApproval(supersedes="memory-0", related=["memory-2"], scope="project"))
        assert (await http.post("/api/v1/memory/memory-1/approve", headers=HEADERS, json={"related": ["../x"]})).status_code == 422
        assert (await http.post("/api/v1/memory/memory-1/approve", headers=HEADERS, json={"approve_as": "factory"})).status_code == 422


async def test_graph_parameters_are_bounded_before_any_lookup():
    memory = SimpleNamespace(graph=AsyncMock())
    async with client(memory) as http:
        for query in ("depth=3", "limit=301", "limit=0", "focus=../x"):
            assert (await http.get(f"/api/v1/projects/project-one/memory/graph?{query}", headers=HEADERS)).status_code == 422
    memory.graph.assert_not_awaited()


async def test_listing_parameters_are_validated_before_any_lookup():
    memory = SimpleNamespace(items=AsyncMock(), detail=AsyncMock())
    async with client(memory) as http:
        for query in ("state=archived", "kind=rule", "limit=101", "q=" + "x" * 201):
            assert (await http.get(f"/api/v1/projects/project-one/memory/items?{query}", headers=HEADERS)).status_code == 422
        assert (await http.get("/api/v1/memory/bad%20id", headers=HEADERS)).status_code == 422
        assert (await http.get("/api/v1/projects/project-one/memory/items", headers={})).status_code == 401
    memory.items.assert_not_awaited()
    memory.detail.assert_not_awaited()


async def test_memory_read_tools_exist_for_the_owner_and_not_for_delegated_agents():
    from mcp import Client

    from sabre.mcp_delegated import build_delegated_mcp
    from sabre.mcp_server import build_mcp
    read_tools = {"sabre_memory_graph", "sabre_memory_recalls", "sabre_memory_review"}
    async with Client(build_mcp(lambda: SimpleNamespace())) as owner:
        assert read_tools <= {tool.name for tool in (await owner.list_tools()).tools}
    async with Client(build_delegated_mcp(lambda: SimpleNamespace(), delegations=lambda: SimpleNamespace())) as delegated:
        names = {tool.name for tool in (await delegated.list_tools()).tools}
    assert not names & read_tools and not any("memory" in name for name in names)


def test_cursor_round_trip_and_tampering():
    import pytest

    from sabre.memory import decode_cursor, encode_cursor
    from sabre.models import DomainError
    assert decode_cursor(encode_cursor(ITEM)) == (ITEM.created_at.isoformat(), ITEM.id)
    for cursor in ("not-base64!", "WyJ4Il0", encode_cursor(ITEM.model_copy(update={"id": "bad id"}))):
        with pytest.raises(DomainError) as error:
            decode_cursor(cursor)
        assert error.value.code == "INVALID_CURSOR"


def test_validity_explains_every_reason_a_memory_is_or_is_not_recalled():
    from sabre.memory import validity_at
    later = "c" * 40
    project = ITEM.model_copy(update={"scope": "project"})
    assert validity_at(ITEM.model_copy(update={"active": False}), later, None).reason == "not_active"
    assert validity_at(project, None, None).reason == "index_missing"
    assert validity_at(project, "a" * 40, None).state == "valid"
    assert validity_at(ITEM, later, None).reason == "commit_scope"
    assert validity_at(project, later, None).reason == "not_evaluated"
    stale = validity_at(project, later, {"state": "stale", "basis": "citations_changed", "checked_at": ITEM.created_at,
                                         "changed_paths": [{"path": "src/app.py", "change": "deleted"}]})
    assert stale.state == "stale" and stale.changed_paths[0].change == "deleted"
