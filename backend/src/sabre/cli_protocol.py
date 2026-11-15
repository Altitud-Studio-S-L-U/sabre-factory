"""Shared text/tool envelope for subscription CLI adapters, not an agent runtime."""

import json
import os
import re
import stat
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from jsonschema import ValidationError as SchemaError
from jsonschema import validate
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from pydantic import BaseModel, ConfigDict, Field, model_validator
from referencing import Registry
from referencing.exceptions import Unresolvable

from sabre.models import DomainError

MAX_INPUT_BYTES = 131072
# The blocks of one request: a header and one per turn. The byte limit is reached long before this count.
MAX_SEGMENTS = 4096


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, strict=True)


class RequestedTool(StrictContract):
    name: str = Field(min_length=1, max_length=128)
    arguments_json: str = Field(max_length=65536)


class AssistantEnvelope(StrictContract):
    content: str = Field(max_length=65536)
    tool_calls: list[RequestedTool] = Field(max_length=32)


class InvocationRequest(StrictContract):
    """One invocation of a CLI: its prompt as one text, or as the blocks it is sent in. Exactly one is given."""

    prompt: str = Field(default="", max_length=MAX_INPUT_BYTES)
    # The prompt cut where a conversation grows, in order; their concatenation is the whole prompt.
    segments: list[str] = Field(default_factory=list, max_length=MAX_SEGMENTS)
    model: str = Field(default="", max_length=128, pattern=r"^[A-Za-z0-9._:/-]*$")

    @model_validator(mode="after")
    def one_form(self):
        if bool(self.prompt) == bool(self.segments) or any(not segment for segment in self.segments):
            raise ValueError("Give the prompt as one text or as non-empty segments")
        return self

    def size(self) -> int:
        return len(self.prompt.encode()) + sum(len(segment.encode()) for segment in self.segments)


class InvocationResponse(StrictContract):
    result: AssistantEnvelope
    input_tokens: int = Field(ge=0, le=1_000_000_000)
    output_tokens: int = Field(ge=0, le=1_000_000_000)
    cached_input_tokens: int = Field(ge=0, le=1_000_000_000)
    usage_kind: Literal["cli_invocation"] = "cli_invocation"


def read_private_bridge(path: Path, provider: Literal["Codex", "Claude"]) -> str:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or (os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.geteuid())):
                raise ValueError
            raw = stream.read(257)
        if not 32 <= len(raw) <= 256 or not re.fullmatch(rb"[A-Za-z0-9_-]+", raw):
            raise ValueError
        return raw.decode("ascii")
    except (OSError, ValueError):
        raise DomainError(f"{provider.upper()}_BRIDGE_CONFIGURATION", f"The private connection file for {provider} is invalid", 503) from None


def embedded_json(message: BaseMessage, content: str):
    """SABRE's own JSON payloads travel as JSON values instead of escaped strings.

    Only human messages qualify, and only when re-encoding reproduces the exact text, so
    nothing is reformatted. Tool results stay verbatim: edits depend on their exact bytes.
    """
    if message.type != "human" or not content.startswith("{"):
        return None
    try:
        value = json.loads(content)
    except ValueError:
        return None
    return value if isinstance(value, dict) and json.dumps(value, ensure_ascii=False) == content else None


def conversation_entry(message: BaseMessage, provider: Literal["Codex", "Claude"]) -> dict[str, Any]:
    """One message as the CLI adapters write it."""
    content = message.content
    if isinstance(message, ToolMessage) and content == []:
        # LangChain represents an empty collection as empty content blocks; keep the result observable.
        content = "[]"
    if not isinstance(content, str):
        texts = []
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str):
                raise DomainError(f"{provider.upper()}_UNSUPPORTED_CONTENT", f"This adapter for {provider} accepts text content only")
            texts.append(block["text"])
        content = "\n".join(texts)
    value = embedded_json(message, content)
    entry: dict[str, Any] = {"role": message.type, "content_json": value} if value is not None else {"role": message.type, "content": content}
    if isinstance(message, AIMessage) and message.tool_calls:
        entry["tool_calls"] = message.tool_calls
    if isinstance(message, ToolMessage):
        entry["tool_call_id"] = message.tool_call_id
    return entry


def compact_json(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    # C1/DEL can hide source syntax. JSON escapes expose them without changing decoded content.
    return re.sub(r"[\x7f-\x9f]", lambda match: f"\\u{ord(match[0]):04x}", text)


CLAUDE_INSTRUCTION = (
    "Produce exactly one assistant turn for the conversation that follows this header, one JSON message per line, oldest first. "
    "A message's content_json is its content as a JSON value. "
    "Request only listed SABRE tools in the output tool_calls array with JSON-encoded object arguments; SABRE executes them after authorization. "
    "The enclosed tool_choice governs that array, not the formatting tool. "
    "Submit content and tool_calls through the native StructuredOutput tool using the required schema. "
    "Do not invoke any other native Claude tool."
)


def serialize_segments(messages: list[BaseMessage], tools: list, choice: Any, *, output_schema: dict | None = None) -> list[str]:
    """The Claude prompt as the blocks it is sent in: JSON Lines, cut where a conversation grows.

    The first block is a header that stays the same for a whole conversation: the instruction, the
    tools and the tool choice. Each block after it is one turn: a message on its own line and, for an
    assistant message, the tool results that answer it on the lines below. Nothing closes the
    document, so a conversation that grew by a turn is the same blocks followed by one more.

    That is what lets the provider's cache be read. The CLI marks the last block of a request as a
    cache point, and the provider reads back a request up to a block that was the last one of an
    earlier call. One block that changes on every call, or a document that has to be closed after
    its last message, never matches an earlier call: everything is written to the cache and nothing
    is read from it.
    """
    header: dict[str, Any] = {"instruction": CLAUDE_INSTRUCTION}
    if output_schema is not None:
        header["output_schema"] = output_schema
    header.update(tools=tools, tool_choice=choice or "auto")
    segments = [compact_json(header) + "\n"]
    for message in messages:
        line = compact_json(conversation_entry(message, "Claude")) + "\n"
        if isinstance(message, ToolMessage) and len(segments) > 1:
            # A turn is one block: more than twenty new blocks in one call fall outside what the provider looks back over.
            segments[-1] += line
        else:
            segments.append(line)
    if sum(len(segment.encode()) for segment in segments) > MAX_INPUT_BYTES or len(segments) > MAX_SEGMENTS:
        raise DomainError("CLAUDE_INPUT_LIMIT", "Context exceeds the invocation limit for Claude")
    return segments


def read_lines(prompt: str) -> dict[str, Any]:
    """A Claude prompt read back as one value: its header, with the conversation its lines carry."""
    header, *lines = [json.loads(line) for line in prompt.split("\n") if line]
    return {**header, "conversation": lines}


def serialize_turn(messages: list[BaseMessage], tools: list, choice: Any, provider: Literal["Codex", "Claude"],
                   *, output_schema: dict | None = None) -> str:
    """The whole prompt of one invocation as text. For Claude it is the blocks of `serialize_segments` joined."""
    if provider == "Claude":
        return "".join(serialize_segments(messages, tools, choice, output_schema=output_schema))
    conversation = [conversation_entry(message, provider) for message in messages]
    payload: dict[str, Any] = {"instruction": f"Produce exactly one assistant turn for the enclosed conversation. A message's content_json is its content as a JSON value. Request only listed tools using the output tool_calls array and JSON-encoded object arguments. SABRE executes these requests after authorization. Do not invoke native {provider} tools. Follow the specified tool_choice. Return content and tool_calls in the required output schema."}
    if output_schema is not None:
        payload["output_schema"] = output_schema
    payload.update(tools=tools, tool_choice=choice or "auto", conversation=conversation)
    prompt = compact_json(payload)
    if len(prompt.encode()) > MAX_INPUT_BYTES:
        raise DomainError(f"{provider.upper()}_INPUT_LIMIT", f"Context exceeds the invocation limit for {provider}")
    return prompt


def validate_tool_calls(result: AssistantEnvelope, tools: list, choice: Any, provider: Literal["Codex", "Claude"]) -> list:
    available = {tool["function"]["name"]: tool["function"]["parameters"] for tool in tools}
    calls = []
    try:
        for call in result.tool_calls:
            arguments = json.loads(call.arguments_json)
            if call.name not in available or not isinstance(arguments, dict):
                raise ValueError
            validate(arguments, available[call.name], registry=Registry())
            calls.append({"name": call.name, "args": arguments, "id": f"call_{uuid4().hex}", "type": "tool_call"})
        if choice == "none" and calls or choice in ("any", "required", True) and not calls:
            raise ValueError
        if isinstance(choice, dict):
            name = choice.get("function", {}).get("name")
            if not calls or any(call["name"] != name for call in calls):
                raise ValueError
        if isinstance(choice, str) and choice not in {"auto", "none", "any", "required"}:
            if not calls or any(call["name"] != choice for call in calls):
                raise ValueError
    except (ValueError, SchemaError, Unresolvable):
        raise DomainError(f"{provider.upper()}_INVALID_TOOL_REQUEST", f"{provider} returned a request outside the tool contract") from None
    return calls
