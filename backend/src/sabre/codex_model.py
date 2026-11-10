"""LangChain adapter for the isolated, subscription-authenticated Codex runner."""

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
    AssistantEnvelope as AssistantEnvelope,
)
from sabre.cli_protocol import (
    InvocationRequest as InvocationRequest,
)
from sabre.cli_protocol import (
    InvocationResponse as InvocationResponse,
)
from sabre.cli_protocol import (
    RequestedTool as RequestedTool,
)
from sabre.cli_protocol import (
    StrictContract as StrictContract,
)
from sabre.cli_protocol import (
    read_private_bridge,
    serialize_turn,
    validate_tool_calls,
)
from sabre.models import DomainError

RUNNER_URL: Literal["http://codex-runner:8091"] = "http://codex-runner:8091"
TOKEN_FILE = Path("/run/secrets/codex-bridge/token")
MAX_OUTPUT_BYTES = 262144
INVOCATION_TIMEOUT_S = 120
MAX_ERROR_BYTES = 4096
RUNNER_ERRORS = {
    "CODEX_BUSY": (409, "Codex is already processing another invocation"),
    "CODEX_INPUT_LIMIT": (413, "Codex context exceeds the limit"),
    "CODEX_INPUT_INVALID": (422, "The Codex request is invalid"),
    "CODEX_LOGIN_REQUIRED": (503, "Connect a separate ChatGPT session for SABRE using the CLI"),
    "CODEX_HOME_INVALID": (503, "The private Codex directory is invalid"),
    "CODEX_PROCESS_UNAVAILABLE": (503, "Could not start the Codex process"),
    "CODEX_PROCESS_FAILED": (503, "The Codex process ended without a valid result"),
    "CODEX_TIMEOUT": (503, "The Codex invocation timed out"),
    "CODEX_OUTPUT_LIMIT": (503, "Codex output exceeds the limit"),
    "CODEX_PROTOCOL_INVALID": (503, "Codex returned events incompatible with the adapter"),
}


async def _runner_error(response: httpx.Response) -> DomainError:
    fallback = DomainError("CODEX_RUNNER_FAILED", "The Codex runner could not complete the invocation", 503)
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
    provider: Literal["codex_cli"]
    usage_kind: Literal["cli_invocation"]


async def runner_status(config) -> dict[str, Any]:
    if config.codex_cli_url != RUNNER_URL:
        raise DomainError("CODEX_BRIDGE_CONFIGURATION", "The Codex destination is unauthorized", 503)
    token = read_bridge_token(config.codex_cli_token_file)
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=False, trust_env=False) as client:
            async with client.stream("GET", RUNNER_URL + "/status", headers={"Authorization": "Bearer " + token}) as response:
                if response.status_code == 409:
                    return {"available": True, "authenticated": None, "busy": True, "provider": "codex_cli"}
                if response.status_code != 200:
                    raise DomainError("CODEX_RUNNER_UNAVAILABLE", "Could not inspect the Codex session", 503)
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 4096:
                        raise DomainError("CODEX_PROTOCOL_INVALID", "Codex state exceeds the limit", 503)
        return {"available": True, "busy": False, **RunnerStatus.model_validate_json(raw).model_dump()}
    except (httpx.HTTPError, ValidationError):
        raise DomainError("CODEX_RUNNER_UNAVAILABLE", "Could not inspect the Codex session", 503) from None


def read_bridge_token(path: Path = TOKEN_FILE) -> str:
    return read_private_bridge(path, "Codex")


class CodexChatModel(BaseChatModel):
    model_name: str = ""
    runner_url: Literal["http://codex-runner:8091"] = RUNNER_URL
    token_file: Path = Field(default=TOKEN_FILE, exclude=True, repr=False)

    @property
    def _llm_type(self) -> str:
        return "sabre-codex-cli"

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
            raise DomainError("CODEX_UNSUPPORTED_OPTION", "Codex CLI does not support provider stop sequences")
        tools = kwargs.get("tools", [])
        prompt = serialize_turn(messages, tools, kwargs.get("tool_choice"), "Codex")
        request = InvocationRequest(prompt=prompt, model=self.model_name)
        response = await self._invoke(request)
        calls = validate_tool_calls(response.result, tools, kwargs.get("tool_choice"), "Codex")
        message = AIMessage(content=response.result.content, tool_calls=calls,
            usage_metadata={"input_tokens": response.input_tokens, "output_tokens": response.output_tokens,
                "total_tokens": response.input_tokens + response.output_tokens,
                "input_token_details": {"cache_read": response.cached_input_tokens}},
            response_metadata={"usage_kind": "cli_invocation", "model_name": self.model_name or "automatic"})
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _invoke(self, request: InvocationRequest) -> InvocationResponse:
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
                            raise DomainError("CODEX_OUTPUT_LIMIT", "Codex output exceeds the limit", 503)
            return InvocationResponse.model_validate_json(chunks)
        except (httpx.HTTPError, ValidationError):
            raise DomainError("CODEX_RUNNER_FAILED", "The Codex runner did not return a valid result", 503) from None
