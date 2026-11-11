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
from pydantic import BaseModel, ConfigDict, Field
from referencing import Registry
from referencing.exceptions import Unresolvable

from sabre.models import DomainError

MAX_INPUT_BYTES = 131072


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, strict=True)


class RequestedTool(StrictContract):
    name: str = Field(min_length=1, max_length=128)
    arguments_json: str = Field(max_length=65536)


class AssistantEnvelope(StrictContract):
    content: str = Field(max_length=65536)
    tool_calls: list[RequestedTool] = Field(max_length=32)


class InvocationRequest(StrictContract):
    prompt: str = Field(min_length=1, max_length=MAX_INPUT_BYTES)
    model: str = Field(default="", max_length=128, pattern=r"^[A-Za-z0-9._:/-]*$")


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


def serialize_turn(messages: list[BaseMessage], tools: list, choice: Any, provider: Literal["Codex", "Claude"],
                   *, output_schema: dict | None = None) -> str:
    conversation = []
    for message in messages:
        content = message.content
        if isinstance(message, ToolMessage) and content == []:
            # LangChain represents an empty collection as empty content blocks; keep the result observable.
            content = "[]"
        if not isinstance(content, str):
            texts = []
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str):
                    raise DomainError(f"{provider.upper()}_UNSUPPORTED_CONTENT", f"This adapter for {provider} solo admite contenido textual")
                texts.append(block["text"])
            content = "\n".join(texts)
        entry: dict[str, Any] = {"role": message.type, "content": content}
        if isinstance(message, AIMessage) and message.tool_calls:
            entry["tool_calls"] = message.tool_calls
        if isinstance(message, ToolMessage):
            entry["tool_call_id"] = message.tool_call_id
        conversation.append(entry)
    payload: dict[str, Any] = {"instruction": f"Produce exactly one assistant turn for the enclosed conversation. Request only listed tools using the output tool_calls array and JSON-encoded object arguments. SABRE executes these requests after authorization. Do not invoke native {provider} tools. Follow the specified tool_choice. Return content and tool_calls in the required output schema."}
    if provider == "Claude":
        payload["instruction"] = (
            "Produce exactly one assistant turn for the enclosed conversation. "
            "Request only listed SABRE tools in the output tool_calls array with JSON-encoded object arguments; SABRE executes them after authorization. "
            "The enclosed tool_choice governs that array, not the formatting tool. "
            "Submit content and tool_calls through the native StructuredOutput tool using the required schema. "
            "Do not invoke any other native Claude tool."
        )
    if output_schema is not None:
        payload["output_schema"] = output_schema
    payload.update(tools=tools, tool_choice=choice or "auto", conversation=conversation)
    prompt = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    # C1/DEL can hide source syntax. JSON escapes expose them without changing decoded content.
    prompt = re.sub(r"[\x7f-\x9f]", lambda match: f"\\u{ord(match[0]):04x}", prompt)
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
