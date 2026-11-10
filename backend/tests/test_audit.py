import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from sabre.audit import AuditService
from sabre.context_receipts import aggregate_receipts
from sabre.models import Budget, DomainError, Project, WorkOrder
from sabre.security import SecretGuard
from tests.test_context_receipts import receipt

SECRET = "synthetic-private-source-never-display"


def fixture():
    project = Project(name="Example", repository="https://github.com/example/project", profile="node", gate_commands=[["npm", "test"]])
    work = WorkOrder(project_id=project.id, objective="Fix behavior", mode="patch", acceptance=["Regression passes"], budget=Budget(max_cost_usd=0), idempotency_key="audit-fixture", plan_revision=2)
    thread = f"{work.id}/r2/developer/" + "a" * 64
    repository = SimpleNamespace(work=AsyncMock(return_value=work), project=AsyncMock(return_value=project),
        audit_checkpoints=AsyncMock(return_value={"count": 9, "threads": 2, "child_threads": [thread], "truncated": False}),
        audit_usage=AsyncMock(return_value={"calls": 2, "settled_calls": 1, "unsettled_calls": 1, "tokens": 150, "measured_tokens": 30, "unknown_reserved_tokens": 120, "cost_usd": 0}),
        audit_context_usage=AsyncMock(return_value=None),
        audit_model_usage=AsyncMock(return_value=[]),
        knowledge_inventory=AsyncMock(return_value={"memories": {"total": 0, "active": 0, "pending": 0, "invalidated": 0}, "checkpoints": {"count": 9, "threads": 2}, "work_ids": [work.id], "truncated": False}))
    saver = SimpleNamespace(aget_tuple=AsyncMock())
    return AuditService(repository, saver, SecretGuard([SECRET])), repository, saver, work, thread


def checkpoint(history, pending=None):
    return SimpleNamespace(checkpoint={"ts": "2026-11-07T10:00:00+00:00", "channel_values": {"messages": history}}, pending_writes=pending or [])


def answer():
    return AIMessage(id="response-1", content=SECRET, usage_metadata={"input_tokens": 25, "output_tokens": 5, "total_tokens": 30, "input_token_details": {"cache_read": 8}}, tool_calls=[
        {"name": "execute", "id": "command", "args": {"argv": [SECRET]}},
        {"name": "read_file", "id": "unanswered", "args": {"path": SECRET}},
        {"name": "AgentResult", "id": "result", "args": {"summary": SECRET}},
    ])


async def test_audit_deduplicates_durable_messages_and_keeps_unknown_usage_without_content():
    service, repository, saver, work, thread = fixture()
    ai = answer()
    reply = ToolMessage(id="reply", tool_call_id="command", content=json.dumps({"exit_code": 1, "output": SECRET, "output_digest": "b" * 64}))
    saver.aget_tuple.return_value = checkpoint([HumanMessage(content=SECRET), ai, ai], [("task", "messages", [reply, reply])])
    report = await service.audit(work.id)
    assert report.usage.tokens == 150 and report.usage.unknown_reserved_tokens == 120
    assert report.context is None
    assert report.agents[0].model_responses == 1
    assert (report.agents[0].input_tokens, report.agents[0].output_tokens, report.agents[0].cache_read_tokens) == (25, 5, 8)
    assert (report.agents[0].tool_requests, report.agents[0].tool_responses) == (2, 1)
    assert [(t.name, t.response, t.exit_code) for t in report.tools] == [("execute", "received", 1), ("read_file", "requested", None)]
    assert report.tools[0].output_digest == "b" * 64
    assert all(t.duration_ms is None for t in report.tools)
    encoded = report.model_dump_json()
    assert SECRET not in encoded and "AgentResult" not in encoded and "argv" not in encoded
    saver.aget_tuple.assert_awaited_once_with({"configurable": {"thread_id": thread, "checkpoint_ns": ""}})
    repository.audit_usage.assert_awaited_once_with(work.id)


async def test_model_audit_retains_legacy_unknown_and_measured_vs_reserved_usage():
    service, repository, saver, work, _ = fixture()
    saver.aget_tuple.return_value = checkpoint([])
    repository.audit_model_usage.return_value = [
        {"model_provider": None, "model_name": None, "role": None, "configuration_revision": None,
         "calls": 1, "settled_calls": 0, "measured_tokens": 0, "unknown_reserved_tokens": 120, "cost_usd": 0},
        {"model_provider": "claude_cli", "model_name": "sonnet", "role": "reviewer", "configuration_revision": 3,
         "calls": 1, "settled_calls": 1, "measured_tokens": 30, "unknown_reserved_tokens": 0, "cost_usd": 0},
    ]
    report = await service.audit(work.id)
    assert report.models[0].model_provider is None
    assert report.models[1].model_provider == "claude_cli" and report.models[1].configuration_revision == 3
    assert sum(value.measured_tokens + value.unknown_reserved_tokens for value in report.models) == report.usage.tokens
    repository.audit_model_usage.assert_awaited_once_with(work.id)


def context(work):
    return {"project_id": work.project_id, "work_id": work.id, "role": "developer", "source": "current_workspace_snapshot", "untrusted": True,
        "source_commit": "a" * 40, "snapshot_digest": "b" * 64, "total_files": 62, "text_files": 62, "omitted_files": 61,
        "files": [{"path": "src/main.ts", "content_digest": "c" * 64, "lines": 30, "indexable": True, "content": SECRET}]}


async def test_audit_exposes_only_aggregate_context_and_marks_legacy_coverage():
    service, repository, saver, work, _ = fixture()
    saver.aget_tuple.return_value = checkpoint([])
    aggregate = aggregate_receipts([None, receipt(work.id, work.project_id, revision=work.plan_revision)], work.id)
    repository.audit_context_usage.return_value = aggregate
    report = await service.audit(work.id)
    assert report.context == aggregate
    assert report.context.requests_without_context == 1 and report.context.restored_pages is None
    encoded = report.context.model_dump_json()
    assert "tool_call_id" not in encoded and "child_id" not in encoded and "references\"" not in encoded
    repository.audit_context_usage.assert_awaited_once_with(work.id)


async def test_knowledge_separates_recorded_source_and_checkpoints_from_empty_memories():
    service, _, saver, work, _ = fixture()
    raw = context(work)
    saver.aget_tuple.return_value = checkpoint([HumanMessage(content=json.dumps({"source_context": raw, "objective": SECRET}))])
    report = await service.knowledge(work.project_id)
    assert report.memories.total == 0 and report.checkpoints.count == 9
    assert report.context.currentness == "unknown" and report.context.source == "recorded_checkpoint"
    assert report.context.captured_at is None
    assert report.context.source_commit == "a" * 40 and report.context.files[0].path == "src/main.ts"
    assert report.context.omitted_files == 61 and not report.semantic_search
    assert SECRET not in report.model_dump_json()
    raw["project_id"] = "another-project"
    saver.aget_tuple.return_value = checkpoint([HumanMessage(content=json.dumps({"source_context": raw}))])
    assert (await service.knowledge(work.project_id)).context is None


async def test_knowledge_ignores_obsolete_revisions_and_still_checks_selected_metadata_for_secrets():
    service, repository, saver, work, thread = fixture()
    raw = context(work)
    raw["files"][0]["path"] = SECRET
    saver.aget_tuple.return_value = checkpoint([HumanMessage(content=json.dumps({"source_context": raw}))])
    repository.audit_checkpoints.return_value["child_threads"] = [thread.replace("/r2/", "/r1/")]
    assert (await service.knowledge(work.project_id)).context is None
    repository.audit_checkpoints.return_value["child_threads"] = [thread]
    with pytest.raises(DomainError) as error:
        await service.knowledge(work.project_id)
    assert error.value.code == "SECRET_DETECTED"


async def test_audit_bounds_output_and_never_labels_transport_success_as_a_pass(monkeypatch):
    service, _, saver, work, _ = fixture()
    monkeypatch.setattr("sabre.audit.MAX_TOOLS", 1)
    ai = answer()
    saver.aget_tuple.return_value = checkpoint([ai, ToolMessage(tool_call_id="command", status="error", content=SECRET)])
    report = await service.audit(work.id)
    assert report.truncated and len(report.tools) == 1
    assert report.tools[0].response == "error" and report.tools[0].exit_code is None
    assert report.agents[0].tool_requests == 2


@pytest.mark.parametrize("limit", ["messages", "content"])
async def test_knowledge_reports_an_unavailable_bounded_context_without_claiming_absence(monkeypatch, limit):
    service, _, saver, work, _ = fixture()
    human = HumanMessage(content=json.dumps({"source_context": context(work)}))
    if limit == "messages":
        monkeypatch.setattr("sabre.audit.MAX_MESSAGES", 1)
    else:
        monkeypatch.setattr("sabre.audit.MAX_CONTENT_BYTES", 1)
    saver.aget_tuple.return_value = checkpoint([human, answer()])
    report = await service.knowledge(work.project_id)
    assert report.context is None and report.truncated
