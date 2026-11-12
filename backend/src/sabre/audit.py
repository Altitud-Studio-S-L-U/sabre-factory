"""Bounded, content-free projections of existing LangGraph and usage records."""

import hashlib
import json
import re
from datetime import datetime
from typing import Literal

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import Field

from sabre.context_receipts import ContextUsageSummary, ModelProvider, Role
from sabre.models import Contract
from sabre.project_context import source_path

ROLES = {"supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security", "designer", "devops"}
TOOLS = {"list_files", "read_file", "search_source", "read_file_range", "write_file", "execute", "prepare_dependencies", "resolve_dependencies", "read_context", "read_memory", "edit_source"}
MAX_MESSAGES = 1000
MAX_TOOLS = 500
MAX_CONTENT_BYTES = 65536


class AuditUsage(Contract):
    calls: int
    settled_calls: int
    unsettled_calls: int
    tokens: int
    measured_tokens: int
    unknown_reserved_tokens: int
    cost_usd: float


class RunUsageSnapshot(Contract):
    version: Literal[1] = 1
    work_id: str
    usage: AuditUsage
    measured_api_cost_usd: float | None = Field(ge=0)
    reserved_api_cost_usd: float = Field(ge=0)


class AuditAgent(Contract):
    id: str
    role: str
    plan_revision: int
    model_responses: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    tool_requests: int = 0
    tool_responses: int = 0
    last_checkpoint_at: datetime | None = None
    duration_ms: None = None


class AuditModelUsage(Contract):
    model_provider: ModelProvider | None = None
    model_name: str | None = Field(default=None, max_length=128, pattern=r"^[A-Za-z0-9._:/-]*$")
    role: Role | None = None
    configuration_revision: int | None = Field(default=None, ge=0)
    calls: int = Field(ge=0)
    settled_calls: int = Field(ge=0)
    measured_tokens: int = Field(ge=0)
    unknown_reserved_tokens: int = Field(ge=0)
    cost_usd: float = Field(ge=0)


class AuditTool(Contract):
    id: str
    agent_id: str
    role: str
    plan_revision: int
    name: str
    sequence: int
    response: Literal["requested", "received", "error"] = "requested"
    exit_code: int | None = None
    output_digest: str | None = None
    duration_ms: None = None


class AuditView(Contract):
    work_id: str
    plan_revision: int
    status: str
    phase: str
    usage: AuditUsage
    context: ContextUsageSummary | None = None
    models: list[AuditModelUsage] = Field(default_factory=list)
    agents: list[AuditAgent]
    tools: list[AuditTool]
    checkpoint_count: int
    checkpoint_threads: int
    truncated: bool


class MemoryCounts(Contract):
    total: int
    active: int
    pending: int
    invalidated: int


class CheckpointCounts(Contract):
    count: int
    threads: int


class ContextFile(Contract):
    path: str = Field(max_length=1024)
    content_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    lines: int | None = Field(default=None, ge=0, le=20000)
    indexable: bool


class RecordedContext(Contract):
    work_id: str
    plan_revision: int
    role: str
    captured_at: datetime | None = None
    source_commit: str = Field(pattern=r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
    snapshot_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    total_files: int = Field(ge=0)
    text_files: int = Field(ge=0)
    omitted_files: int = Field(ge=0)
    files: list[ContextFile] = Field(max_length=40)
    currentness: Literal["unknown"] = "unknown"
    source: Literal["recorded_checkpoint"] = "recorded_checkpoint"


class ProjectKnowledgeReport(Contract):
    project_id: str
    profile: Literal["node", "python"]
    gate_count: int
    memories: MemoryCounts
    checkpoints: CheckpointCounts
    context: RecordedContext | None
    semantic_search: bool
    truncated: bool


def public_id(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def role_identity(thread_id: str, work_id: str) -> tuple[int, str] | None:
    match = re.fullmatch(re.escape(work_id) + r"/r([1-9][0-9]{0,8})/([a-z]+)/[a-f0-9]{64}", thread_id)
    return (int(match[1]), match[2]) if match and match[2] in ROLES else None


def number(value) -> int:
    return value if type(value) is int and 0 <= value <= 10**15 else 0


def timestamp(value) -> datetime | None:
    try:
        return datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def object_content(content) -> dict:
    if not isinstance(content, str) or len(content.encode()) > MAX_CONTENT_BYTES:
        return {}
    try:
        value = json.loads(content)
        return value if isinstance(value, dict) else {}
    except (ValueError, RecursionError):
        return {}


def messages(checkpoint) -> tuple[list, bool]:
    values = checkpoint.checkpoint.get("channel_values", {}).get("messages", [])
    values = list(values) if isinstance(values, list) else []
    # Successful sibling tool replies can be durable pending writes after another tool failed.
    for _, channel, value in checkpoint.pending_writes or []:
        if channel == "messages":
            values.extend(value if isinstance(value, list) else [value])
    return values[-MAX_MESSAGES:], len(values) > MAX_MESSAGES


def project_agent(thread_id: str, identity: tuple[int, str], checkpoint) -> tuple[AuditAgent, list[AuditTool], bool]:
    revision, role = identity
    agent = AuditAgent(id=public_id(thread_id), role=role, plan_revision=revision,
                       last_checkpoint_at=timestamp(checkpoint.checkpoint.get("ts")))
    history, truncated = messages(checkpoint)
    seen_messages: set[tuple[str, str | int]] = set()
    requests: dict[str, AuditTool] = {}
    replies: dict[str, ToolMessage] = {}
    for position, message in enumerate(history):
        key = (type(message).__name__, message.id or position) if isinstance(message, AIMessage | ToolMessage) else None
        if key is None or key in seen_messages:
            continue
        seen_messages.add(key)
        if isinstance(message, AIMessage):
            agent.model_responses += 1
            usage: dict = dict(message.usage_metadata or {})
            agent.input_tokens += number(usage.get("input_tokens"))
            agent.output_tokens += number(usage.get("output_tokens"))
            details = usage.get("input_token_details") or {}
            agent.cache_read_tokens += number(details.get("cache_read"))
            for call in message.tool_calls:
                call_id = call.get("id")
                if call.get("name") == "AgentResult" or not isinstance(call_id, str) or call_id in requests:
                    continue
                name = call.get("name") if call.get("name") in TOOLS else "external_tool"
                requests[call_id] = AuditTool(id=public_id(thread_id + "/" + call_id), agent_id=agent.id,
                    role=role, plan_revision=revision, name=name, sequence=len(requests) + 1)
        elif isinstance(message, ToolMessage):
            replies[message.tool_call_id] = message
    for call_id, entry in requests.items():
        reply = replies.get(call_id)
        if reply is None:
            continue
        entry.response = "error" if reply.status == "error" else "received"
        data = object_content(reply.content)
        # A successful tool transport does not imply a successful subprocess or a passed gate.
        if entry.name == "execute" and type(data.get("exit_code")) is int and -2147483648 <= data["exit_code"] <= 2147483647:
            entry.exit_code = data["exit_code"]
        if entry.name == "execute" and isinstance(data.get("output_digest"), str) and re.fullmatch(r"[a-f0-9]{64}", data["output_digest"]):
            entry.output_digest = data["output_digest"]
    agent.tool_requests = len(requests)
    agent.tool_responses = sum(item.response != "requested" for item in requests.values())
    return agent, list(requests.values()), truncated


def project_context(checkpoint, work, identity: tuple[int, str]) -> tuple[RecordedContext | None, bool]:
    revision, role = identity
    if revision != work.plan_revision:
        return None, False
    history, truncated = messages(checkpoint)
    for message in history:
        if not isinstance(message, HumanMessage):
            continue
        if isinstance(message.content, str) and len(message.content.encode()) > MAX_CONTENT_BYTES:
            truncated = True
            continue
        raw = object_content(message.content).get("source_context")
        if not isinstance(raw, dict) or raw.get("project_id") != work.project_id or raw.get("work_id") != work.id or raw.get("role") != role or raw.get("source") != "current_workspace_snapshot" or raw.get("untrusted") is not True:
            continue
        files = raw.get("files")
        if not isinstance(files, list):
            continue
        if len(files) > 40:
            truncated = True
            continue
        try:
            selected = [ContextFile(path=source_path(f["path"]), content_digest=f["content_digest"], lines=f.get("lines"), indexable=f["indexable"]) for f in files]
            context = RecordedContext(work_id=work.id, plan_revision=revision, role=role,
                source_commit=raw["source_commit"], snapshot_digest=raw["snapshot_digest"],
                total_files=raw["total_files"], text_files=raw["text_files"], omitted_files=raw["omitted_files"], files=selected)
        except (KeyError, TypeError, ValueError):
            continue
        if context.text_files > context.total_files or context.omitted_files + len(context.files) != context.total_files or len({f.path for f in context.files}) != len(context.files):
            continue
        return context, truncated
    return None, truncated


class AuditService:
    def __init__(self, repository, checkpointer, guard, *, semantic_search: bool = False):
        self.repository, self.checkpointer, self.guard = repository, checkpointer, guard
        self.semantic_search = semantic_search

    async def _children(self, work_id: str, thread_ids: list[str]):
        for thread_id in thread_ids:
            identity = role_identity(thread_id, work_id)
            if identity is None:
                continue
            saved = await self.checkpointer.aget_tuple({"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}})
            if saved is not None:
                yield thread_id, identity, saved

    async def audit(self, work_id: str) -> AuditView:
        work = await self.repository.work(work_id)
        inventory = await self.repository.audit_checkpoints(work.id)
        agents: list[AuditAgent] = []
        tools: list[AuditTool] = []
        truncated = inventory["truncated"]
        async for thread_id, identity, saved in self._children(work.id, inventory["child_threads"]):
            agent, entries, partial = project_agent(thread_id, identity, saved)
            agents.append(agent)
            tools.extend(entries[:max(0, MAX_TOOLS - len(tools))])
            truncated = truncated or partial or sum(a.tool_requests for a in agents) > MAX_TOOLS
        result = AuditView(work_id=work.id, plan_revision=work.plan_revision, status=work.status, phase=work.phase,
            usage=AuditUsage(**await self.repository.audit_usage(work.id)), agents=agents, tools=tools,
            context=await self.repository.audit_context_usage(work.id),
            models=[AuditModelUsage(**entry) for entry in await self.repository.audit_model_usage(work.id)],
            checkpoint_count=inventory["count"], checkpoint_threads=inventory["threads"], truncated=truncated)
        self.guard.check(result.model_dump(mode="json"))
        return result

    async def knowledge(self, project_id: str) -> ProjectKnowledgeReport:
        project = await self.repository.project(project_id)
        inventory = await self.repository.knowledge_inventory(project.id)
        context = None
        truncated = inventory["truncated"]
        for work_id in inventory["work_ids"]:
            work = await self.repository.work(work_id)
            checkpoints = await self.repository.audit_checkpoints(work.id, limit=30)
            truncated = truncated or checkpoints["truncated"]
            async for _, identity, saved in self._children(work.id, checkpoints["child_threads"]):
                context, partial = project_context(saved, work, identity)
                truncated = truncated or partial
                if context is not None:
                    break
            if context is not None:
                break
        result = ProjectKnowledgeReport(project_id=project.id, profile=project.profile, gate_count=len(project.gate_commands),
            memories=MemoryCounts(**inventory["memories"]), checkpoints=CheckpointCounts(**inventory["checkpoints"]),
            context=context, semantic_search=self.semantic_search, truncated=truncated)
        self.guard.check(result.model_dump(mode="json"))
        return result
