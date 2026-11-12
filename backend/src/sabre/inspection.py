"""Owner-local inspection of recorded messages; never exports hidden reasoning."""

import json
import re
from typing import Literal

from fastapi import FastAPI, Query
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from sabre.audit import public_id, role_identity
from sabre.contracts import StrictContract
from sabre.models import DomainError


class InspectionRecord(StrictContract):
    sequence: int
    id: str
    kind: Literal["message", "tool_call", "tool_result"]
    sender: str
    recipient: str
    content: str
    tool: str | None = None
    redacted: bool = False
    truncated: bool = False


class EvaluationRecord(StrictContract):
    id: str
    kind: Literal["check", "security", "review"]
    status: Literal["passed", "failed", "recorded"]
    criterion: str
    snapshot_digest: str | None = None
    artifact_digest: str | None = None


class InspectionAgent(StrictContract):
    id: str
    role: str
    plan_revision: int


class RunInspection(StrictContract):
    version: Literal[1] = 1
    work_id: str
    plan_revision: int
    agent_id: str | None
    role: str | None
    agents: list[InspectionAgent]
    records: list[InspectionRecord]
    evaluations: list[EvaluationRecord]
    logs: list[dict]
    context: dict | None
    next_cursor: int
    has_more: bool
    truncated: bool
    checkpoint_id: str | None
    current: bool


def visible_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(item["text"] for item in content if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str))
    return ""


def safe_text(value, guard):
    try:
        guard.check(value)
    except DomainError:
        return "[Redacted by the factory secret policy]", True, False
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text[:4096], False, len(text) > 4096


def inspect_messages(messages, role, guard):
    entries: list[InspectionRecord] = []
    names: dict[str | None, str] = {}
    for position, message in enumerate(messages[:1000]):
        identifier = str(getattr(message, "id", None) or position)
        if isinstance(message, AIMessage):
            content, redacted, truncated = safe_text(visible_text(message.content), guard)
            if content:
                entries.append(InspectionRecord(sequence=len(entries), id=identifier, kind="message", sender=role, recipient="supervisor", content=content, redacted=redacted, truncated=truncated))
            for call in message.tool_calls[:128]:
                if len(entries) >= 1000:
                    return entries
                name = safe_text(str(call.get("name", "unknown")), guard)[0][:128]
                names[call.get("id")] = name
                text, redacted, truncated = safe_text(call.get("args", {}), guard)
                entries.append(InspectionRecord(sequence=len(entries), id=str(call.get("id", identifier)), kind="tool_call", sender=role, recipient="tool", tool=name, content=text, redacted=redacted, truncated=truncated))
        elif isinstance(message, ToolMessage):
            text, redacted, truncated = safe_text(visible_text(message.content) if message.content != [] else "[]", guard)
            entries.append(InspectionRecord(sequence=len(entries), id=identifier, kind="tool_result", sender="tool", recipient=role, tool=names.get(message.tool_call_id), content=text, redacted=redacted, truncated=truncated))
        elif isinstance(message, HumanMessage):
            text, redacted, truncated = safe_text(visible_text(message.content), guard)
            entries.append(InspectionRecord(sequence=len(entries), id=identifier, kind="message", sender="supervisor", recipient=role, content=text, redacted=redacted, truncated=truncated))
        if len(entries) >= 1000:
            return entries[:1000]
    return entries


async def inspect_run(service, work_id, *, agent_id=None, role=None, after=0, limit=50, checkpoint_id=None):
    if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 100:
        raise DomainError("INVALID_CURSOR", "Use a non-negative cursor and a page size between one and one hundred", 422)
    if checkpoint_id is not None and (not agent_id or not isinstance(checkpoint_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", checkpoint_id) is None):
        raise DomainError("INVALID_CHECKPOINT_CURSOR", "A checkpoint cursor requires an authorized invocation identifier", 422)
    requested_checkpoint = checkpoint_id
    work = await service.repository.work(work_id)
    inventory = await service.repository.audit_checkpoints(work.id)
    agents = []
    chosen = None
    for thread in inventory["child_threads"]:
        identity = role_identity(thread, work.id)
        if identity is None:
            continue
        entry = InspectionAgent(id=public_id(thread), role=identity[1], plan_revision=identity[0])
        agents.append(entry)
        if chosen is None and (agent_id == entry.id or (agent_id is None and (role is None or role == entry.role) and entry.plan_revision == work.plan_revision)):
            chosen = (thread, entry)
    if agent_id is not None and chosen is None:
        raise DomainError("INSPECTION_AGENT_NOT_FOUND", "That invocation does not belong to this run", 404)
    records = []
    checkpoint_id = None
    current = True
    records_truncated = False
    if chosen:
        if service.factory.team.checkpointer is None:
            raise DomainError("INSPECTION_UNAVAILABLE", "Recorded agent checkpoints are unavailable", 503)
        cursor = {"thread_id": chosen[0], "checkpoint_ns": ""}
        if requested_checkpoint:
            cursor["checkpoint_id"] = requested_checkpoint
        saved = await service.factory.team.checkpointer.aget_tuple({"configurable": cursor})
        if requested_checkpoint and (not saved or saved.checkpoint.get("id") != requested_checkpoint):
            raise DomainError("INSPECTION_CHECKPOINT_NOT_FOUND", "The recorded checkpoint does not belong to this invocation", 404)
        if saved:
            messages = saved.checkpoint.get("channel_values", {}).get("messages", [])
            records = inspect_messages(messages, chosen[1].role, service.guard)
            records_truncated = len(messages) > 1000 or len(records) >= 1000 or any(len(message.tool_calls) > 128 for message in messages[:1000] if isinstance(message, AIMessage))
            checkpoint_id = str(saved.checkpoint.get("id", ""))
            current = chosen[1].plan_revision == work.plan_revision
    evaluations = []
    if work.evidence:
        for index, gate in enumerate(work.evidence.gates):
            evaluations.append(EvaluationRecord(id=f"gate-{index}", kind="check", status="passed" if gate.exit_code == 0 else "failed", criterion=" ".join(gate.command), snapshot_digest=gate.snapshot_digest, artifact_digest=gate.output_digest))
        evaluations.append(EvaluationRecord(id="delivery-review", kind="review", status="recorded", criterion=safe_text(work.evidence.review, service.guard)[0], snapshot_digest=work.evidence.snapshot_digest))
    for finding in work.findings[:100]:
        evaluations.append(EvaluationRecord(id=finding.fingerprint, kind="security", status="recorded", criterion=safe_text(finding.title, service.guard)[0], snapshot_digest=work.security_snapshot_digest))
    async with service.repository.connection() as conn:
        logs = await (await conn.execute("SELECT id,kind,message,created_at FROM work_events WHERE work_id=%s ORDER BY seq DESC LIMIT 101", (work.id,))).fetchall()
    safe_logs = []
    for log in reversed(logs[:100]):
        text, redacted, truncated = safe_text(log["message"], service.guard)
        safe_logs.append({"id": log["id"], "kind": log["kind"], "message": text, "timestamp": log["created_at"].isoformat(), "redacted": redacted, "truncated": truncated})
    context = await service.repository.audit_context_usage(work.id)
    result = RunInspection(work_id=work.id, plan_revision=work.plan_revision, agents=agents, agent_id=chosen[1].id if chosen else None,
        role=chosen[1].role if chosen else None, records=records[after:after+limit], evaluations=evaluations, logs=safe_logs,
        context=context.model_dump(mode="json") if context else None, next_cursor=min(after+limit, len(records)), has_more=after+limit < len(records),
        truncated=inventory["truncated"] or records_truncated or len(work.findings) > 100 or len(logs) > 100,
        checkpoint_id=checkpoint_id, current=current)
    service.guard.check(result)
    return result


def install_inspection_routes(app: FastAPI, service):
    @app.get("/api/v1/work/{work_id}/inspection", response_model=RunInspection)
    async def inspection(work_id: str, agent_id: str | None = Query(default=None, max_length=64), role: str | None = Query(default=None, max_length=30),
                         after: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=100),
                         checkpoint_id: str | None = Query(default=None, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")):
        return await inspect_run(service(), work_id, agent_id=agent_id, role=role, after=after, limit=limit, checkpoint_id=checkpoint_id)
