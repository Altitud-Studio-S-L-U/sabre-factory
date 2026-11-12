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
