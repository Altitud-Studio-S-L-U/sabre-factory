from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
from mcp import Client
from pydantic import SecretStr

from sabre.api import create_app
from sabre.mcp_server import build_mcp
from sabre.models import MemoryItem, ProposedBy

TOKEN = "owner-test-token-at-least-24"
REQUEST = {"project_id": "project-one", "kind": "lesson", "content": "Keep empty input stable", "source_commit": "a" * 40, "source_work_id": "work"}


def stored(request, *, proposed_by=None):
    return MemoryItem(**request.model_dump(), proposed_by=proposed_by)


async def test_console_proposals_are_attributed_server_side_and_reject_a_supplied_proposer():
    memory = SimpleNamespace(propose=AsyncMock(side_effect=stored))
    application = create_app(SimpleNamespace(memory=memory), SimpleNamespace(auth_token=SecretStr(TOKEN), allowed_origins=["http://localhost:8000"]))
    headers = {"Authorization": f"Bearer {TOKEN}"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application), base_url="http://localhost:8000") as client:
        forged = await client.post("/api/v1/memory", headers=headers, json=REQUEST | {"proposed_by": {"channel": "factory"}})
        assert forged.status_code == 422
        memory.propose.assert_not_awaited()
        response = await client.post("/api/v1/memory", headers=headers, json=REQUEST)
    assert response.status_code == 201
    assert response.json()["proposed_by"] == {"channel": "owner_console", "role": None, "work_id": None}
    assert memory.propose.await_args.kwargs == {"proposed_by": ProposedBy(channel="owner_console")}


async def test_owner_mcp_proposals_are_attributed_to_the_mcp_channel():
    memory = SimpleNamespace(propose=AsyncMock(side_effect=stored))
    async with Client(build_mcp(lambda: SimpleNamespace(memory=memory))) as client:
        response = await client.call_tool("sabre_propose_memory", {"request": REQUEST})
    assert not response.is_error
    assert response.structured_content["proposed_by"]["channel"] == "owner_mcp"


def test_memories_recorded_before_attribution_read_as_unknown():
    assert MemoryItem.model_validate(REQUEST | {"id": "legacy", "active": True}).proposed_by is None


async def test_supervisor_chat_proposals_are_attributed_and_accept_citations():
    from sabre.operator_contracts import OperatorContext
    from sabre.security import SecretGuard
    from sabre.slack import conversation_tools

    memory = SimpleNamespace(propose=AsyncMock(side_effect=stored))
    service = SimpleNamespace(repository=SimpleNamespace(), guard=SecretGuard(), memory=memory)
    event = OperatorContext.model_validate({"version": 1, "text": "Remember the parser lesson", "idempotency_key": "synthetic-request-001",
                                            "allowed_actions": ["propose_memory"], "id": "message-1"})
    tool = next(item for item in conversation_tools(service, None, event) if item.name == "propose_memory")
    result = await tool.ainvoke({"request": REQUEST | {"citations": ["src/app.py#L3"], "scope": "project"}})
    assert result["proposed_by"]["channel"] == "supervisor_chat" and result["citations"] == ["src/app.py#L3"]
    assert memory.propose.await_args.kwargs["proposed_by"].channel == "supervisor_chat"
