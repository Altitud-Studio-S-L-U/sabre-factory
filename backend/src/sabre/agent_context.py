"""Transient suppression of identical old reads; durable messages are never edited."""

import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass, field

from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage

from sabre.context_receipts import ContextReference
from sabre.models import DomainError

READ_TOOLS = frozenset({"read_file", "read_files", "read_file_range", "search_source", "list_files"})


@dataclass(frozen=True)
class ContextPolicy:
    enabled: bool = True
    trigger_bytes: int = 65536
    min_result_bytes: int = 4096
    keep_model_turns: int = 4
    archive_unique: bool = False
    archive_min_bytes: int = 2048

    @classmethod
    def from_settings(cls, settings):
        return cls(enabled=getattr(settings, "context_dedup_enabled", True),
                   trigger_bytes=getattr(settings, "context_dedup_trigger_bytes", 65536),
                   min_result_bytes=getattr(settings, "context_dedup_min_result_bytes", 4096),
                   keep_model_turns=getattr(settings, "context_dedup_keep_model_turns", 2),
                   archive_unique=getattr(settings, "context_archive_enabled", True))


@dataclass
class ContextProjection:
    messages: list[AnyMessage]
    original_bytes: int
    sent_bytes: int
    omitted_results: int = 0
    # Only the caller with an authorized artifact store may apply this projection.
    originals: dict[str, bytes] = field(default_factory=dict, repr=False)
    references: list[ContextReference] = field(default_factory=list)

    def stats(self) -> dict[str, int]:
        return {"context_original_bytes": self.original_bytes,
                "context_sent_bytes": self.sent_bytes,
                "context_dedup_results": sum(ref.reason == "duplicate" for ref in self.references),
                "context_compacted_results": self.omitted_results}


def successful_reads(messages: list[AnyMessage]):
    """Associate only unambiguous successful internal reads with their original calls."""
    calls, ambiguous = {}, set()
    responses = Counter(message.tool_call_id for message in messages if isinstance(message, ToolMessage))
    for index, message in enumerate(messages):
        if not isinstance(message, AIMessage):
            continue
        for call in message.tool_calls:
            identifier = call.get("id")
            if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", identifier):
                continue
            if identifier in calls:
                ambiguous.add(identifier)
            calls[identifier] = (index, call)
    for index, message in enumerate(messages):
        if not isinstance(message, ToolMessage) or message.status != "success" or not isinstance(message.content, str):
            continue
        origin = calls.get(message.tool_call_id)
        if origin is None or origin[0] >= index or message.tool_call_id in ambiguous or responses[message.tool_call_id] != 1:
            continue
        call = origin[1]
        if call.get("name") in READ_TOOLS:
            yield index, message, call


def serialized_size(messages: list[AnyMessage]) -> int:
    return len(json.dumps([message.model_dump(mode="json") for message in messages], ensure_ascii=False).encode())


def memory_references(messages: list[AnyMessage]) -> list[dict]:
    """Select original memory references whose validity is required to continue."""
    references = []
    first = next((message for message in messages if isinstance(message, HumanMessage)), None)
    if first is not None and isinstance(first.content, str):
        try:
            initial = json.loads(first.content)
        except ValueError:
            initial = None
        if isinstance(initial, dict) and "memory_data" in initial:
            if not isinstance(initial["memory_data"], list):
                raise DomainError("MEMORY_CONTEXT_CHANGED", "Saved memory requires context review before continuing")
            references.extend(initial["memory_data"])
    calls: dict[str | None, str | None] = {}
    for message in messages:
        if not isinstance(message, AIMessage):
            continue
        for call in message.tool_calls:
            identifier, name = call.get("id"), call.get("name")
            if identifier in calls and "read_memory" in {name, calls[identifier]}:
                raise DomainError("MEMORY_CONTEXT_CHANGED", "Memory read provenance is ambiguous")
            calls[identifier] = name
    for message in messages:
        if isinstance(message, ToolMessage) and message.status == "success" and calls.get(message.tool_call_id) == "read_memory":
            try:
                reference = json.loads(message.content) if isinstance(message.content, str) else None
            except ValueError:
                reference = None
            if not isinstance(reference, dict):
                raise DomainError("MEMORY_CONTEXT_CHANGED", "The saved memory read cannot be revalidated")
            references.append(reference)
    return references


def project_tool_context(messages: list[AnyMessage], policy: ContextPolicy, *, archive_recent: bool = False) -> ContextProjection:
    """Plan a model-only view without performing I/O or changing message objects.

    Legacy dedup retains a complete later copy. The recoverable archive mode can
    also replace unique older reads; callers must persist originals and provide
    the child-scoped read_context tool before applying that mode.
    archive_recent is a last resort for a measured over-limit request, with the
    same recovery requirements. Instructions, effects and recovery pages remain.
    """
    size = serialized_size(messages)
    result = ContextProjection(list(messages), size, size)
    if not policy.enabled or not policy.archive_unique and size < policy.trigger_bytes:
        return result
    turns = [index for index, message in enumerate(messages) if isinstance(message, AIMessage)]
    archive_recent = archive_recent and policy.archive_unique
    if len(turns) <= policy.keep_model_turns and not archive_recent:
        return result
    protected_start = len(messages) if archive_recent or policy.keep_model_turns == 0 else turns[-policy.keep_model_turns]
    newest: dict[tuple[str, str, str], tuple[str, int]] = {}
    for index, message, call in reversed(list(successful_reads(messages))):
        raw = message.content.encode()
        minimum = min(policy.min_result_bytes, policy.archive_min_bytes) if policy.archive_unique else policy.min_result_bytes
        if archive_recent:
            minimum = 0
        if len(raw) < minimum:
            continue
        content_digest = hashlib.sha256(raw).hexdigest()
        arguments = json.dumps(call.get("args", {}), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        key = (call["name"], arguments, content_digest)
        retained = newest.get(key)
        if retained is None:
            newest[key] = (message.tool_call_id, index)
        if index >= protected_start:
            continue
        duplicate = retained is not None and retained[0] != message.tool_call_id and messages[retained[1]].content == message.content
        if not policy.archive_unique and not duplicate:
            continue
        if policy.archive_unique:
            placeholder = json.dumps({"sabre_context_reference": 2, "historical": True, "currentness": "not_revalidated",
                "tool": call["name"], "tool_call_id": message.tool_call_id, "response_digest": content_digest,
                "original_bytes": len(raw), "original_chars": len(message.content), "content_omitted": True,
                "recover_with": "read_context(tool_call_id,response_digest,offset,limit)"}, separators=(",", ":"))
        else:
            if retained is None:
                continue
            placeholder = json.dumps({"sabre_context_reference": 1, "untrusted": True,
                "tool": call["name"], "identical_result_tool_call_id": retained[0],
                "original_content_sha256": content_digest, "original_content_bytes": len(raw),
                "content_omitted": True,
                "note": "Earlier identical read result. The later referenced tool response remains complete; original bytes remain in the checkpoint and local artifact. This is not an approval or a new action."}, ensure_ascii=False)
        if len(placeholder.encode()) >= len(raw):
            continue
        result.messages[index] = message.model_copy(update={"content": placeholder}, deep=True)
        result.originals[content_digest] = raw
        result.omitted_results += 1
        result.references.append(ContextReference(tool_call_id=message.tool_call_id, tool=call["name"],
            response_digest=content_digest, original_bytes=len(raw), reason="duplicate" if duplicate else "old_read"))
    result.sent_bytes = serialized_size(result.messages)
    return result
