from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from sabre.audit import public_id
from sabre.inspection import inspect_messages, inspect_run
from sabre.models import Budget, DomainError, WorkOrder
from sabre.security import SecretGuard


def owner_service(messages=None, threads=None, logs=None):
    work = WorkOrder(id="run-one", project_id="project", mode="patch", objective="Inspect behavior", acceptance=["Correct output"], budget=Budget(), idempotency_key="inspection-request")
    thread = f"{work.id}/r1/developer/" + "a" * 64
    saver = SimpleNamespace(aget_tuple=AsyncMock(return_value=SimpleNamespace(checkpoint={"id": "checkpoint", "channel_values": {"messages": messages or []}})))

    @asynccontextmanager
    async def connection():
        yield SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(fetchall=AsyncMock(return_value=logs or []))))

    repository = SimpleNamespace(work=AsyncMock(return_value=work), audit_checkpoints=AsyncMock(return_value={"child_threads": threads or [thread], "truncated": False}),
        audit_context_usage=AsyncMock(return_value=None), connection=connection)
    return SimpleNamespace(repository=repository, factory=SimpleNamespace(team=SimpleNamespace(checkpointer=saver)), guard=SecretGuard(["synthetic-private-value"])), work, thread, saver


def test_visible_content_excludes_system_and_hidden_reasoning_and_redacts_tool_arguments():
    messages = [SystemMessage(content="Internal system instructions"),
        AIMessage(content=[{"type": "reasoning", "reasoning": "Never export this hidden reasoning"}, {"type": "text", "text": "Visible response"}],
                  additional_kwargs={"reasoning_content": "Never export this either"},
                  tool_calls=[{"name": "read_file", "args": {"credential": "synthetic-private-value"}, "id": "tool-call", "type": "tool_call"}]),
        ToolMessage(content="Tool evidence", tool_call_id="tool-call")]
    records = inspect_messages(messages, "developer", SecretGuard(["synthetic-private-value"]))
    serialized = str([record.model_dump() for record in records])
    assert "Visible response" in serialized and "Tool evidence" in serialized
    assert "Internal system" not in serialized and "Never export" not in serialized
    assert "synthetic-private-value" not in serialized
    assert records[1].kind == "tool_call" and records[1].redacted


async def test_cross_run_invocation_is_denied_before_checkpoint_or_log_access():
    service, work, _, saver = owner_service()
    foreign_id = public_id("run-other/r1/developer/" + "b" * 64)
    with pytest.raises(DomainError) as error:
        await inspect_run(service, work.id, agent_id=foreign_id)
    assert error.value.code == "INSPECTION_AGENT_NOT_FOUND"
    saver.aget_tuple.assert_not_awaited()


async def test_inspection_selects_latest_invocation_pages_records_and_redacts_logs():
    messages = [HumanMessage(content=f"Visible instruction {index}") for index in range(6)]
    new = "run-one/r1/developer/" + "a" * 64
    old = "run-one/r1/developer/" + "b" * 64
    service, work, _, saver = owner_service(messages, [new, old], [{"id": "event", "kind": "phase", "message": "synthetic-private-value", "created_at": datetime.now(UTC)}])
    result = await inspect_run(service, work.id, after=2, limit=2)
    assert [record.content for record in result.records] == ["Visible instruction 2", "Visible instruction 3"]
    assert result.has_more and result.next_cursor == 4
    assert saver.aget_tuple.await_args.args[0]["configurable"]["thread_id"] == new
    assert result.logs[0]["redacted"] and "synthetic-private-value" not in result.model_dump_json()


@pytest.mark.parametrize("after,limit", [(-1, 50), (0, 0), (0, 101), (True, 50)])
async def test_paging_is_bounded_at_the_shared_service_boundary(after, limit):
    service, work, _, _ = owner_service()
    with pytest.raises(DomainError) as error:
        await inspect_run(service, work.id, after=after, limit=limit)
    assert error.value.code == "INVALID_CURSOR"
    service.repository.work.assert_not_awaited()


async def test_large_checkpoints_are_explicitly_truncated():
    service, work, _, _ = owner_service([HumanMessage(content="x" * 5000) for _ in range(1001)])
    result = await inspect_run(service, work.id, limit=100)
    assert result.truncated and len(result.records) == 100 and result.has_more
    assert all(record.truncated and len(record.content) == 4096 for record in result.records)


async def test_log_projection_labels_omitted_history_without_returning_more_than_one_hundred_events():
    logs = [{"id": f"event-{index}", "kind": "phase", "message": "Recorded event", "created_at": datetime.now(UTC)} for index in range(101)]
    service, work, _, _ = owner_service(logs=logs)
    result = await inspect_run(service, work.id)
    assert result.truncated and len(result.logs) == 100


async def test_checkpoint_pages_pin_the_authorized_invocation_instead_of_reading_live_compacted_messages():
    service, work, thread, saver = owner_service([HumanMessage(content="Original instruction"), HumanMessage(content="Original next page")])
    result = await inspect_run(service, work.id, agent_id=public_id(thread), checkpoint_id="checkpoint", after=1, limit=1)
    assert [record.content for record in result.records] == ["Original next page"]
    assert saver.aget_tuple.await_args.args[0]["configurable"] == {"thread_id": thread, "checkpoint_ns": "", "checkpoint_id": "checkpoint"}
    assert result.checkpoint_id == "checkpoint"


async def test_foreign_or_deleted_checkpoint_never_falls_back_to_the_latest_invocation():
    service, work, thread, saver = owner_service()
    saver.aget_tuple.return_value = None
    with pytest.raises(DomainError) as error:
        await inspect_run(service, work.id, agent_id=public_id(thread), checkpoint_id="foreign-checkpoint")
    assert error.value.code == "INSPECTION_CHECKPOINT_NOT_FOUND"
    assert saver.aget_tuple.await_count == 1


async def test_checkpoint_cursor_without_explicit_invocation_is_rejected_before_access():
    service, work, _, saver = owner_service()
    with pytest.raises(DomainError) as error:
        await inspect_run(service, work.id, checkpoint_id="checkpoint")
    assert error.value.code == "INVALID_CHECKPOINT_CURSOR"
    saver.aget_tuple.assert_not_awaited()
    service.repository.work.assert_not_awaited()
