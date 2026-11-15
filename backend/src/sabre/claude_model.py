"""LangChain adapter for the isolated, subscription-authenticated Claude runner."""

import asyncio
import json
from pathlib import Path
from typing import Any, Literal

import httpx
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field, ValidationError

from sabre.cli_protocol import (
    MAX_INPUT_BYTES as MAX_INPUT_BYTES,
)
from sabre.cli_protocol import (
    InvocationRequest,
    InvocationResponse,
    StrictContract,
    read_private_bridge,
    serialize_segments,
    validate_tool_calls,
)
from sabre.models import DomainError

RUNNER_URL: Literal["http://claude-runner:8092"] = "http://claude-runner:8092"
TOKEN_FILE = Path("/run/secrets/claude-bridge/token")
MAX_OUTPUT_BYTES = 262144
INVOCATION_TIMEOUT_S = 120
MAX_ERROR_BYTES = 4096
RUNNER_ERRORS = {
    "CLAUDE_BUSY": (409, "Claude is already processing another invocation"),
    "CLAUDE_INPUT_LIMIT": (413, "Claude context exceeds the limit"),
    "CLAUDE_INPUT_INVALID": (422, "The Claude request is invalid"),
    "CLAUDE_LOGIN_REQUIRED": (503, "Connect a separate Claude session for SABRE using the CLI"),
    "CLAUDE_HOME_INVALID": (503, "The private Claude directory is invalid"),
    "CLAUDE_POLICY_UNSUPPORTED": (503, "Claude CLI requires a personal session without organization policies"),
    "CLAUDE_PROCESS_UNAVAILABLE": (503, "Could not start the Claude process"),
    "CLAUDE_PROCESS_FAILED": (503, "The Claude process ended without a valid result"),
    "CLAUDE_TIMEOUT": (503, "The Claude invocation timed out"),
    "CLAUDE_OUTPUT_LIMIT": (503, "Claude output exceeds the limit"),
    "CLAUDE_PROTOCOL_INVALID": (503, "Claude returned events incompatible with the adapter"),
    "CLAUDE_NATIVE_TOOL_DENIED": (503, "Claude requested an unauthorized native tool"),
    "CLAUDE_TURN_LIMIT": (503, "Claude exhausted the internal limit without producing a structured result"),
    "CLAUDE_EXECUTION_FAILED": (503, "Claude reported an invocation failure"),
    "CLAUDE_RATE_LIMITED": (503, "Claude reported a rate or usage limit"),
    "CLAUDE_OVERLOADED": (503, "Claude reported that the service is overloaded"),
    "CLAUDE_STRUCTURED_OUTPUT_MISSING": (503, "Claude finished without the required structured result"),
    "CLAUDE_STRUCTURED_OUTPUT_INVALID": (503, "The structured Claude result violates the contract"),
    "CLAUDE_USAGE_INVALID": (503, "Claude did not return valid usage counters"),
}


async def _runner_error(response: httpx.Response) -> DomainError:
    fallback = DomainError("CLAUDE_RUNNER_FAILED", "The Claude runner could not complete the invocation", 503)
    raw = bytearray()
    async for chunk in response.aiter_bytes():
        raw.extend(chunk)
        if len(raw) > MAX_ERROR_BYTES:
            return fallback
    try:
        payload = json.loads(raw)
    except (ValueError, RecursionError):
        return fallback
    code = payload.get("code") if isinstance(payload, dict) else None
    if isinstance(code, str) and code in RUNNER_ERRORS:
        status, message = RUNNER_ERRORS[code]
        if response.status_code == status:
            return DomainError(code, message, status)
    return fallback


class RunnerStatus(StrictContract):
    authenticated: bool
    provider: Literal["claude_cli"]
    usage_kind: Literal["cli_invocation"]


class ClaudeInvocationResponse(InvocationResponse):
    cache_creation_input_tokens: int = Field(default=0, ge=0, le=1_000_000_000)
    # What the CLI says the call would cost at API rates; None when it did not say.
    reported_cost_usd: float | None = Field(default=None, ge=0, le=100_000, allow_inf_nan=False)


async def runner_status(config) -> dict[str, Any]:
    if config.claude_cli_url != RUNNER_URL:
        raise DomainError("CLAUDE_BRIDGE_CONFIGURATION", "The Claude destination is unauthorized", 503)
    token = read_bridge_token(config.claude_cli_token_file)
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=False, trust_env=False) as client:
            async with client.stream("GET", RUNNER_URL + "/status", headers={"Authorization": "Bearer " + token}) as response:
                if response.status_code == 409:
                    return {"available": True, "authenticated": None, "busy": True, "provider": "claude_cli"}
                if response.status_code != 200:
                    raise await _runner_error(response)
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 4096:
                        raise DomainError("CLAUDE_PROTOCOL_INVALID", "Claude state exceeds the limit", 503)
        return {"available": True, "busy": False, **RunnerStatus.model_validate_json(raw).model_dump()}
    except (httpx.HTTPError, ValidationError):
        raise DomainError("CLAUDE_RUNNER_UNAVAILABLE", "Could not inspect the Claude session", 503) from None


def read_bridge_token(path: Path = TOKEN_FILE) -> str:
    return read_private_bridge(path, "Claude")


class ClaudeChatModel(BaseChatModel):
    model_name: str = ""
    runner_url: Literal["http://claude-runner:8092"] = RUNNER_URL
    token_file: Path = Field(default=TOKEN_FILE, exclude=True, repr=False)

    @property
    def _llm_type(self) -> str:
        return "sabre-claude-cli"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        return {"model_name": self.model_name or "automatic", "usage_kind": "cli_invocation"}

    def bind_tools(self, tools, *, tool_choice=None, **kwargs):
        schemas = [convert_to_openai_tool(tool) for tool in tools]
        return self.bind(tools=schemas, tool_choice=tool_choice)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return asyncio.run(self._agenerate(messages, stop=stop, **kwargs))

    async def _agenerate(self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs) -> ChatResult:
        if stop:
            raise DomainError("CLAUDE_UNSUPPORTED_OPTION", "Claude CLI does not support provider stop sequences")
        tools = kwargs.get("tools", [])
        # Blocks that only grow with the conversation, so the provider's cache can be read back.
        segments = serialize_segments(messages, tools, kwargs.get("tool_choice"))
        request = InvocationRequest(segments=segments, model=self.model_name)
        response = await self._invoke(request)
        calls = validate_tool_calls(response.result, tools, kwargs.get("tool_choice"), "Claude")
        message = AIMessage(content=response.result.content, tool_calls=calls,
            usage_metadata={"input_tokens": response.input_tokens, "output_tokens": response.output_tokens,
                "total_tokens": response.input_tokens + response.output_tokens,
                "input_token_details": {"cache_read": response.cached_input_tokens,
                    "cache_creation": getattr(response, "cache_creation_input_tokens", 0)}},
            response_metadata={"usage_kind": "cli_invocation", "model_name": self.model_name or "automatic",
                "protocol": "claude_lines_v1",
                **({"reported_cost_usd": response.reported_cost_usd} if getattr(response, "reported_cost_usd", None) is not None else {})})
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _invoke(self, request: InvocationRequest) -> ClaudeInvocationResponse:
        token = read_bridge_token(self.token_file)
        try:
            async with httpx.AsyncClient(timeout=INVOCATION_TIMEOUT_S + 10, follow_redirects=False, trust_env=False) as client:
                async with client.stream("POST", self.runner_url + "/invoke", json=request.model_dump(),
                        headers={"Authorization": "Bearer " + token}) as response:
                    if response.status_code != 200:
                        raise await _runner_error(response)
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > MAX_OUTPUT_BYTES:
                            raise DomainError("CLAUDE_OUTPUT_LIMIT", "Claude output exceeds the limit", 503)
            return ClaudeInvocationResponse.model_validate_json(chunks)
        except (httpx.HTTPError, ValidationError):
            raise DomainError("CLAUDE_RUNNER_FAILED", "The Claude runner did not return a valid result", 503) from None
