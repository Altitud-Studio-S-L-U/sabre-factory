"""Transient suppression of old reads, command output and write content; durable messages are never edited.

With water marks set, a result stays in the model-facing request until the request crosses the high
mark; the oldest eligible results then leave in one batch, down to the low mark. Between batches the
request only grows at its end, which is what a provider's prompt cache needs. The plan is replayed
from the durable messages on every call, so it needs no state and survives a resumed step.
"""

import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass, field

from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolCall, ToolMessage

from sabre.context_receipts import ContextReference
from sabre.models import DomainError

READ_TOOLS = frozenset({"read_file", "read_files", "read_file_range", "search_source", "list_files"})
# The recoverable archive also pages back command output and the content of earlier writes.
OUTPUT_TOOLS = frozenset({"execute"})
ARCHIVED_RESULT_TOOLS = READ_TOOLS | OUTPUT_TOOLS
ARGUMENT_TOOLS = {"write_file": "content"}
# A recovery page is a second copy of an archived original: it can always be asked for again.
RECOVERY_TOOLS = frozenset({"read_context"})
DIGEST = re.compile(r"[a-f0-9]{64}")
CALL_ID = re.compile(r"[A-Za-z0-9_.:-]{1,200}")


@dataclass(frozen=True)
class ContextPolicy:
    enabled: bool = True
    trigger_bytes: int = 65536
    min_result_bytes: int = 4096
    keep_model_turns: int = 4
    archive_unique: bool = False
    archive_min_bytes: int = 2048
    # Request sizes, in bytes, between which the recoverable archive works in batches. None archives
    # every eligible result as soon as it leaves the protected turns.
    high_water_bytes: int | None = None
    low_water_bytes: int | None = None

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


def unambiguous_calls(messages: list[AnyMessage]) -> tuple[dict[str, tuple[int, ToolCall]], set[str]]:
    calls: dict[str, tuple[int, ToolCall]] = {}
    ambiguous: set[str] = set()
    for index, message in enumerate(messages):
        if not isinstance(message, AIMessage):
            continue
        for call in message.tool_calls:
            identifier = call.get("id")
            if not isinstance(identifier, str) or not CALL_ID.fullmatch(identifier):
                continue
            if identifier in calls:
                ambiguous.add(identifier)
            calls[identifier] = (index, call)
    return calls, ambiguous


def successful_reads(messages: list[AnyMessage], tools: frozenset[str] = READ_TOOLS):
    """Associate only unambiguous successful internal results of these tools with their original calls."""
    calls, ambiguous = unambiguous_calls(messages)
    responses = Counter(message.tool_call_id for message in messages if isinstance(message, ToolMessage))
    for index, message in enumerate(messages):
        if not isinstance(message, ToolMessage) or message.status != "success" or not isinstance(message.content, str):
            continue
        origin = calls.get(message.tool_call_id)
        if origin is None or origin[0] >= index or message.tool_call_id in ambiguous or responses[message.tool_call_id] != 1:
            continue
        call = origin[1]
        if call.get("name") in tools:
            yield index, message, call


def answered_arguments(messages: list[AnyMessage]):
    """Large string arguments of unambiguous archivable calls that already have a reply."""
    calls, ambiguous = unambiguous_calls(messages)
    replied = {message.tool_call_id: index for index, message in enumerate(messages) if isinstance(message, ToolMessage)}
    for identifier, (index, call) in calls.items():
        field_name = ARGUMENT_TOOLS.get(call["name"])
        value = (call.get("args") or {}).get(field_name) if field_name else None
        if identifier in ambiguous or not isinstance(value, str) or replied.get(identifier, -1) <= index:
            continue
        yield index, call, field_name, value


def execution_output(content: str) -> dict | None:
    """The full-output artifact an execute result names, when its output was bounded."""
    try:
        value = json.loads(content)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("output_truncated") is not True:
        return None
    digest, size = value.get("output_digest"), value.get("output_bytes")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest) or type(size) is not int or size < 0:
        return None
    return {"output_digest": digest, "output_bytes": size}


def _replace_argument(message: AIMessage, identifier: str, field_name: str, placeholder: str) -> AIMessage:
    """A model-only copy of the turn whose call argument, and every provider-native copy of it, is replaced."""
    def arguments(value):
        if isinstance(value, dict) and field_name in value:
            return {**value, field_name: placeholder}
        if isinstance(value, str):
            try:
                decoded = json.loads(value)
            except ValueError:
                return value
            if isinstance(decoded, dict) and field_name in decoded:
                return json.dumps({**decoded, field_name: placeholder}, ensure_ascii=False)
        return value

    calls = [{**call, "args": arguments(call.get("args"))} if call.get("id") == identifier else call for call in message.tool_calls]
    content = message.content
    if isinstance(content, list):
        content = [{**block, **{key: arguments(block[key]) for key in ("input", "args", "arguments") if key in block}}
                   if isinstance(block, dict) and identifier in {block.get("id"), block.get("call_id")} else block
                   for block in content]
    extra = dict(message.additional_kwargs)
    if isinstance(extra.get("tool_calls"), list):
        extra["tool_calls"] = [{**item, "function": {**item["function"], "arguments": arguments(item["function"].get("arguments"))}}
                               if isinstance(item, dict) and item.get("id") == identifier and isinstance(item.get("function"), dict) else item
                               for item in extra["tool_calls"]]
    return message.model_copy(update={"tool_calls": calls, "content": content, "additional_kwargs": extra}, deep=True)


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


def output_summary(content: str) -> dict:
    """What an archived command result keeps visible: its exit code and full-output reference."""
    try:
        value = json.loads(content)
    except ValueError:
        return {}
    if not isinstance(value, dict):
        return {}
    summary = {"exit_code": value["exit_code"]} if type(value.get("exit_code")) is int else {}
    full = execution_output(content)
    if full is not None:
        summary["full_output"] = {**full, "recover_with": "read_context(tool_call_id,response_digest=output_digest,offset,limit)"}
    return summary


def result_placeholder(call: ToolCall, message: ToolMessage, content_digest: str, raw: bytes) -> str:
    # Only text results are archived: successful_reads never yields another kind.
    text = message.content if isinstance(message.content, str) else ""
    return json.dumps({"sabre_context_reference": 2, "historical": True, "currentness": "not_revalidated",
        "tool": call["name"], "tool_call_id": message.tool_call_id, "response_digest": content_digest,
        "original_bytes": len(raw), "original_chars": len(text), "content_omitted": True,
        "recover_with": "read_context(tool_call_id,response_digest,offset,limit)",
        **(output_summary(text) if call["name"] in OUTPUT_TOOLS else {})}, separators=(",", ":"))


def argument_placeholder(call: ToolCall, field_name: str, value: str, content_digest: str, raw: bytes) -> str:
    return json.dumps({"sabre_context_reference": 2, "historical": True, "currentness": "not_revalidated",
        "tool": call["name"], "argument": field_name, "tool_call_id": call["id"], "response_digest": content_digest,
        "original_bytes": len(raw), "original_chars": len(value), "content_omitted": True,
        "recover_with": "read_context(tool_call_id,response_digest,offset,limit)",
        "note": "Argument of an earlier completed call, omitted from this view. Never write this reference as file content."},
        separators=(",", ":"))


def page_placeholder(page: dict, recent: bool) -> str:
    return json.dumps({"sabre_context_reference": 2, "historical": True, "currentness": "not_revalidated",
        "tool": "read_context", **page, "content_omitted": True,
        "recover_with": "read_context(tool_call_id,response_digest,offset,limit)",
        "note": ("Dropped because this request exceeded its input limit: recover fewer pages per turn." if recent
                 else "An earlier recovery page that left this view. Work from your notes; recover it again only if you must.")},
        separators=(",", ":"))


def message_bytes(message: AnyMessage) -> int:
    """The size of one message as the request carries it, with its separator."""
    return len(json.dumps(message.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")).encode()) + 1


def batch_plan(messages: list[AnyMessage], policy: ContextPolicy, overhead_bytes: int) -> set[tuple[str, str]]:
    """What has left the view so far, as (kind, tool call id), replaying every request of this conversation.

    Each model turn in the history was produced by a request that saw the messages before it. For each of
    those requests in order, and for the one being built: when the request is over the high mark, the oldest
    results outside its protected turns leave until it is at the low mark or nothing eligible is left. A
    request that saw the same history makes the same choices, so between two batches no earlier message of
    the view changes.
    """
    high, low = policy.high_water_bytes, policy.low_water_bytes
    if high is None or low is None:
        return set()
    minimum = min(policy.min_result_bytes, policy.archive_min_bytes)
    candidates: list[tuple[int, int, tuple[str, str], int]] = []  # position, visible from, key, bytes saved
    for index, message, call in successful_reads(messages, ARCHIVED_RESULT_TOOLS):
        raw = message.content.encode()
        if len(raw) < minimum:
            continue
        placeholder = result_placeholder(call, message, hashlib.sha256(raw).hexdigest(), raw)
        saved = message_bytes(message) - message_bytes(message.model_copy(update={"content": placeholder}))
        if saved > 0:
            candidates.append((index, index, ("result", message.tool_call_id), saved))
    replied = {message.tool_call_id: index for index, message in enumerate(messages) if isinstance(message, ToolMessage)}
    for index, call, field_name, value in answered_arguments(messages):
        raw = value.encode()
        if len(raw) < minimum:
            continue
        placeholder = argument_placeholder(call, field_name, value, hashlib.sha256(raw).hexdigest(), raw)
        saved = message_bytes(messages[index]) - message_bytes(_replace_argument(messages[index], call["id"], field_name, placeholder))
        if saved > 0:
            # An argument can leave only once its call has an answer in the request.
            candidates.append((index, replied[call["id"]], ("argument", call["id"]), saved))
    for index, message, _call in successful_reads(messages, RECOVERY_TOOLS):
        page = recovery_page(message.content)
        if page is None or len(message.content.encode()) < minimum:
            continue
        saved = message_bytes(message) - message_bytes(message.model_copy(update={"content": page_placeholder(page, False)}))
        if saved > 0:
            candidates.append((index, index, ("page", message.tool_call_id), saved))
    candidates.sort()
    sizes = [message_bytes(message) for message in messages]
    turns = [index for index, message in enumerate(messages) if isinstance(message, AIMessage)]
    archived: dict[tuple[str, str], int] = {}
    for point in [*turns, len(messages)]:
        earlier = [index for index in turns if index < point]
        if len(earlier) <= policy.keep_model_turns:
            continue
        protected_start = point if policy.keep_model_turns == 0 else earlier[-policy.keep_model_turns]
        view = overhead_bytes + sum(sizes[:point]) - sum(archived.values())
        if view <= high:
            continue
        for position, visible, key, saved in candidates:
            if view <= low:
                break
            if position < protected_start and visible < point and key not in archived:
                archived[key] = saved
                view -= saved
    return set(archived)


def archive_arguments(result: ContextProjection, messages: list[AnyMessage], protected_start: int, minimum: int,
                      allowed: set[tuple[str, str]] | None = None) -> None:
    for index, call, field_name, value in answered_arguments(messages):
        raw = value.encode()
        if index >= protected_start or len(raw) < minimum or (allowed is not None and ("argument", call["id"]) not in allowed):
            continue
        content_digest = hashlib.sha256(raw).hexdigest()
        placeholder = argument_placeholder(call, field_name, value, content_digest, raw)
        if len(placeholder.encode()) >= len(raw):
            continue
        result.messages[index] = _replace_argument(result.messages[index], call["id"], field_name, placeholder)
        result.originals[content_digest] = raw
        result.omitted_results += 1
        result.references.append(ContextReference(tool_call_id=call["id"], tool=call["name"],
            response_digest=content_digest, original_bytes=len(raw), reason="old_argument"))


def recovery_page(content: str) -> dict | None:
    """The coordinates of a read_context result, when it is one."""
    try:
        page = json.loads(content)
    except ValueError:
        return None
    if not isinstance(page, dict) or page.get("historical") is not True or not isinstance(page.get("content"), str):
        return None
    identifier, source, offset, size = page.get("tool_call_id"), page.get("response_digest"), page.get("offset"), page.get("original_bytes")
    if not isinstance(identifier, str) or not CALL_ID.fullmatch(identifier) or not isinstance(source, str) or not DIGEST.fullmatch(source):
        return None
    if type(offset) is not int or offset < 0 or type(size) is not int or size < 0:
        return None
    return {"tool_call_id": identifier, "response_digest": source, "original_bytes": size, "offset": offset,
            "chars": len(page["content"]), "eof": page.get("eof") is True}


def archive_pages(result: ContextProjection, messages: list[AnyMessage], protected_start: int, minimum: int, shed_bytes: int,
                  allowed: set[tuple[str, str]] | None = None) -> None:
    """Replace older recovery pages by their coordinates. Nothing is stored: the original they copy is already archived.

    Pages inside the protected window stay, because the agent has just asked for them. When the
    request is still over its limit, shed_bytes drops the oldest of those too, never the newest.
    """
    pages = [(index, message, page) for index, message, _call in successful_reads(messages, RECOVERY_TOOLS)
             if (page := recovery_page(message.content)) is not None]
    for position, (index, message, page) in enumerate(pages):
        raw = message.content.encode()
        recent = index >= protected_start
        if recent and (shed_bytes <= 0 or position == len(pages) - 1):
            continue
        if not recent and (len(raw) < minimum or (allowed is not None and ("page", message.tool_call_id) not in allowed)):
            continue
        placeholder = page_placeholder(page, recent)
        saved = len(raw) - len(placeholder.encode())
        if saved <= 0:
            continue
        result.messages[index] = message.model_copy(update={"content": placeholder}, deep=True)
        result.omitted_results += 1
        result.references.append(ContextReference(tool_call_id=message.tool_call_id, tool="read_context",
            response_digest=page["response_digest"], original_bytes=len(raw), reason="old_page"))
        if recent:
            shed_bytes -= saved


def read_only_turns(messages: list[AnyMessage], before: int) -> list[tuple[int, int]]:
    """Model turns that only read: every call is a read or a recovery, and each has exactly one successful reply.

    A turn that wrote, ran a command, recorded a note, read memory or met an error is never one of these.
    """
    _calls, ambiguous = unambiguous_calls(messages)
    turns, index = [], 0
    while index < before:
        message = messages[index]
        if not isinstance(message, AIMessage) or not message.tool_calls:
            index += 1
            continue
        end = index + 1
        while end < len(messages) and isinstance(messages[end], ToolMessage):
            end += 1
        replies = [reply for reply in messages[index + 1:end] if isinstance(reply, ToolMessage)]
        wanted = [identifier for call in message.tool_calls if isinstance(identifier := call.get("id"), str)]
        if (end <= before and len(wanted) == len(message.tool_calls)
                and all(call.get("name") in READ_TOOLS | RECOVERY_TOOLS for call in message.tool_calls)
                and all(CALL_ID.fullmatch(identifier) and identifier not in ambiguous for identifier in wanted)
                and sorted(reply.tool_call_id for reply in replies) == sorted(wanted)
                and all(reply.status == "success" and isinstance(reply.content, str) for reply in replies)):
            turns.append((index, end))
        index = end
    return turns


def drop_old_turns(result: ContextProjection, messages: list[AnyMessage], before: int, drop_bytes: int) -> None:
    """Take the oldest read-only turns out of the view until drop_bytes are saved.

    Every call leaves a residue in the request (its arguments and a reference), so a long
    conversation reaches its input limit with nothing left to archive. Reads can be made
    again, so those turns may leave; the first one stays and says how many left.
    """
    turns = read_only_turns(messages, before)
    if len(turns) < 2 or drop_bytes <= 0:
        return
    (first, _end), dropped, saved = turns[0], [], 0
    for start, end in turns[1:]:
        if saved >= drop_bytes:
            break
        dropped.append((start, end))
        # Measured as the request is: compact separators, so the saving is never overstated.
        saved += sum(len(json.dumps(result.messages[index].model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")).encode()) + 1
                     for index in range(start, end))
    replies = [index for start, end in dropped for index in range(start + 1, end)]
    carrier = first + 1
    marker = json.dumps({"sabre_context_reference": 2, "historical": True, "content_omitted": True,
        "turns_omitted": len(dropped), "tool_calls_omitted": len(replies),
        "note": "Earlier read-only turns left this view so the request fits its input limit. "
                "Rely on your notes; read a current file again only when one specific fact is missing."}, separators=(",", ":"))
    result.messages[carrier] = messages[carrier].model_copy(update={"content": marker}, deep=True)
    referenced = {reference.tool_call_id for reference in result.references}
    names = {call.get("id"): call.get("name") for turn in messages if isinstance(turn, AIMessage) for call in turn.tool_calls}
    for index in [carrier, *replies]:
        message = messages[index]
        # read_only_turns only returns turns whose replies are successful text results.
        if not isinstance(message, ToolMessage) or not isinstance(message.content, str) or message.tool_call_id in referenced:
            continue
        raw = message.content.encode()
        result.omitted_results += 1
        result.references.append(ContextReference(tool_call_id=message.tool_call_id, tool=names[message.tool_call_id],
            response_digest=hashlib.sha256(raw).hexdigest(), original_bytes=len(raw), reason="old_turn"))
    gone = {index for start, end in dropped for index in range(start, end)}
    result.messages = [message for index, message in enumerate(result.messages) if index not in gone]


def project_tool_context(messages: list[AnyMessage], policy: ContextPolicy, *, archive_recent: bool = False,
                         shed_page_bytes: int = 0, drop_turn_bytes: int = 0, overhead_bytes: int = 0) -> ContextProjection:
    """Plan a model-only view without performing I/O or changing message objects.

    Legacy dedup retains a complete later copy. The recoverable archive mode can
    also replace unique older reads; callers must persist originals and provide
    the child-scoped read_context tool before applying that mode. That mode also
    archives older command output and the content argument of answered writes; the
    call itself (tool, id, path, argv) and any exit code stay visible.
    archive_recent is a last resort for a measured over-limit request, with the
    same recovery requirements. Instructions and effects remain. Recovery pages
    older than the protected turns collapse to their coordinates, so restoring
    history cannot grow the request without bound; shed_page_bytes drops the
    oldest pages still held when the request is over its limit. drop_turn_bytes
    is the last resort: the oldest read-only turns leave the view, which is the
    only step that removes messages instead of replacing their content.

    With the policy's water marks set, the archive works in batches (see batch_plan);
    overhead_bytes is what the request carries besides its messages. The last
    resorts ignore the marks: they answer a request that is over its limit.
    """
    size = serialized_size(messages)
    result = ContextProjection(list(messages), size, size)
    if not policy.enabled or not policy.archive_unique and size < policy.trigger_bytes:
        return result
    turns = [index for index, message in enumerate(messages) if isinstance(message, AIMessage)]
    archive_recent = archive_recent and policy.archive_unique
    if len(turns) <= policy.keep_model_turns and not archive_recent:
        return result
    recent_start = len(messages) if policy.keep_model_turns == 0 else turns[-policy.keep_model_turns] if len(turns) > policy.keep_model_turns else 0
    protected_start = len(messages) if archive_recent else recent_start
    batch = (batch_plan(messages, policy, overhead_bytes)
             if policy.archive_unique and not archive_recent and policy.high_water_bytes is not None and policy.low_water_bytes is not None else None)
    newest: dict[tuple[str, str, str], tuple[str, int]] = {}
    archived_tools = ARCHIVED_RESULT_TOOLS if policy.archive_unique else READ_TOOLS
    minimum = 0 if archive_recent else min(policy.min_result_bytes, policy.archive_min_bytes) if policy.archive_unique else policy.min_result_bytes
    for index, message, call in reversed(list(successful_reads(messages, archived_tools))):
        raw = message.content.encode()
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
        if batch is not None and ("result", message.tool_call_id) not in batch:
            continue
        if policy.archive_unique:
            placeholder = result_placeholder(call, message, content_digest, raw)
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
            response_digest=content_digest, original_bytes=len(raw),
            reason="duplicate" if duplicate else "old_output" if call["name"] in OUTPUT_TOOLS else "old_read"))
    if policy.archive_unique:
        archive_arguments(result, messages, protected_start, minimum, batch)
        archive_pages(result, messages, recent_start, min(policy.min_result_bytes, policy.archive_min_bytes), shed_page_bytes, batch)
        if drop_turn_bytes > 0:
            drop_old_turns(result, messages, recent_start, drop_turn_bytes)
    result.sent_bytes = serialized_size(result.messages)
    return result
