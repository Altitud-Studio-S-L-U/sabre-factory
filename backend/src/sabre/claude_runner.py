"""Private Claude CLI boundary; subscription state never enters the control plane."""

import asyncio
import hmac
import json
import os
import stat
import tempfile
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from sabre.claude_model import (
    INVOCATION_TIMEOUT_S,
    MAX_INPUT_BYTES,
    TOKEN_FILE,
    ClaudeInvocationResponse,
    read_bridge_token,
)
from sabre.codex_model import AssistantEnvelope, InvocationRequest
from sabre.codex_runner import capture_process as capture_bounded_process
from sabre.models import DomainError
from sabre.settings import reject_secret_environment

BINARY = "/opt/claude/bin/claude"
CLAUDE_HOME = Path("/var/lib/sabre-claude")
STATUS_WAIT_TIMEOUT_S = 12
POLICY = {"disableAllHooks": True, "disableWorkflows": True}


def cli_arguments() -> list[str]:
    # StructuredOutput may need one follow-up after prose or schema validation failure.
    return [BINARY, "--safe-mode", "--restricted", "--setting-sources", "", "--settings", json.dumps(POLICY),
        "--tools", "", "--json-schema", json.dumps(AssistantEnvelope.model_json_schema()),
        "--disable-slash-commands", "--no-session-persistence", "--permission-mode", "dontAsk",
        "--permission-prompts", "none", "--no-chrome", "--max-turns", "2", "--output-format", "json", "--print"]


async def capture_process(args, **kwargs):
    try:
        return await capture_bounded_process(args, **kwargs)
    except DomainError as error:
        raise DomainError(error.code.replace("CODEX_", "CLAUDE_"),
            error.message.replace("Codex", "Claude"), error.status_code) from None


def execution_failure(result: dict) -> DomainError:
    """Name a rate or usage limit, or an overload, when the CLI's own result says so.

    The CLI does not retry (CLAUDE_CODE_MAX_RETRIES is 0), so these reach the factory, which decides
    whether to call again. The text is only searched for a few markers and never leaves this function.
    """
    status = result.get("api_error_status")
    text = result.get("result")
    text = text[:4000].casefold() if isinstance(text, str) else ""
    if status == 429 or any(marker in text for marker in ("rate limit", "rate_limit", "usage limit", "429")):
        return DomainError("CLAUDE_RATE_LIMITED", "Claude reported a rate or usage limit", 503)
    if (type(status) is int and 500 <= status <= 599) or any(marker in text for marker in ("overloaded", "529", "internal server error")):
        return DomainError("CLAUDE_OVERLOADED", "Claude reported that the service is overloaded", 503)
    return DomainError("CLAUDE_EXECUTION_FAILED", "Claude reported an invocation failure", 503)


def parse_result(raw: bytes, *, exit_code: int = 0) -> ClaudeInvocationResponse:
    try:
        result = json.loads(raw)
        if not isinstance(result, dict) or result.get("type") != "result":
            raise ValueError
    except (ValueError, TypeError, RecursionError):
        if exit_code:
            raise DomainError("CLAUDE_PROCESS_FAILED", "The Claude process ended without a valid result", 503) from None
        raise DomainError("CLAUDE_PROTOCOL_INVALID", "Claude returned a result incompatible with the adapter", 503) from None
    if result.get("permission_denials"):
        raise DomainError("CLAUDE_NATIVE_TOOL_DENIED", "Claude requested an unauthorized native tool", 503)
    if result.get("subtype") == "error_max_turns":
        raise DomainError("CLAUDE_TURN_LIMIT", "Claude exhausted the internal limit without producing a structured result", 503)
    if result.get("is_error") is True:
        raise execution_failure(result)
    if exit_code:
        raise DomainError("CLAUDE_PROCESS_FAILED", "The Claude process ended without a valid result", 503)
    if result.get("subtype") != "success" or result.get("is_error") is not False:
        raise DomainError("CLAUDE_PROTOCOL_INVALID", "Claude returned a result incompatible with the adapter", 503)
    if result.get("structured_output") is None:
        raise DomainError("CLAUDE_STRUCTURED_OUTPUT_MISSING", "Claude finished without the required structured result", 503)
    try:
        envelope = AssistantEnvelope.model_validate(result["structured_output"])
    except ValidationError:
        raise DomainError("CLAUDE_STRUCTURED_OUTPUT_INVALID", "The structured Claude result violates the contract", 503) from None
    try:
        usage = result["usage"]
        counts = [usage[key] for key in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")]
        if any(type(value) is not int or not 0 <= value <= 1_000_000_000 for value in counts):
            raise ValueError
        return ClaudeInvocationResponse(result=envelope, input_tokens=counts[0] + counts[2] + counts[3],
            output_tokens=counts[1], cached_input_tokens=counts[2], cache_creation_input_tokens=counts[3])
    except (ValueError, TypeError, KeyError, ValidationError, RecursionError):
        raise DomainError("CLAUDE_USAGE_INVALID", "Claude did not return valid usage counters", 503) from None


class ClaudeRunner:
    def __init__(self, home: Path = CLAUDE_HOME):
        self.home = home
        self.lock = asyncio.Lock()
        self.invocation_lock = asyncio.Lock()

    def environment(self):
        try:
            info = self.home.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
                raise ValueError
        except (OSError, ValueError):
            raise DomainError("CLAUDE_HOME_INVALID", "Claude requires its own private authentication directory", 503) from None
        # A prior organizational login can cache a policy that overrides the image's
        # hook restrictions. Its contents are neither read nor silently removed.
        if (self.home / "remote-settings.json").exists() or (self.home / "remote-settings.json").is_symlink():
            raise DomainError("CLAUDE_POLICY_UNSUPPORTED", "This session contains an unsupported organization policy", 503)
        return {"HOME": str(self.home), "CLAUDE_CONFIG_DIR": str(self.home), "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8", "TERM": "dumb", "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1", "CLAUDE_CODE_DISABLE_WORKFLOWS": "1",
            "CLAUDE_CODE_MAX_RETRIES": "0"}

    async def _login_status(self):
        code, output, _ = await capture_process([BINARY, "auth", "status"], env=self.environment(), cwd=str(self.home), timeout=10)
        try:
            status = json.loads(output)
            if not isinstance(status, dict) or type(status.get("loggedIn")) is not bool:
                raise ValueError
            authenticated = code == 0 and status["loggedIn"] and status.get("authMethod") == "claude.ai" and status.get("apiProvider") == "firstParty"
            if authenticated and status.get("subscriptionType") not in {"pro", "max", "ultra"}:
                raise DomainError("CLAUDE_POLICY_UNSUPPORTED", "The adapter requires a personal Claude Pro, Max or Ultra subscription", 503)
        except (ValueError, RecursionError):
            raise DomainError("CLAUDE_PROTOCOL_INVALID", "Could not verify Claude session status", 503) from None
        return {"authenticated": authenticated, "provider": "claude_cli", "usage_kind": "cli_invocation"}

    async def status(self):
        if self.invocation_lock.locked() or self.lock.locked():
            raise DomainError("CLAUDE_BUSY", "Claude is already processing another invocation", 409)
        async with self.lock:
            return await self._login_status()

    async def invoke(self, request: InvocationRequest):
        if self.invocation_lock.locked():
            raise DomainError("CLAUDE_BUSY", "Claude is already processing another invocation", 409)
        async with self.invocation_lock:
            try:
                async with asyncio.timeout(INVOCATION_TIMEOUT_S):
                    try:
                        await asyncio.wait_for(self.lock.acquire(), STATUS_WAIT_TIMEOUT_S)
                    except TimeoutError:
                        raise DomainError("CLAUDE_BUSY", "The Claude status check timed out", 409) from None
                    try:
                        return await self._invoke_locked(request)
                    finally:
                        self.lock.release()
            except TimeoutError:
                raise DomainError("CLAUDE_TIMEOUT", "The Claude invocation timed out", 503) from None

    async def _invoke_locked(self, request: InvocationRequest):
        if not (await self._login_status())["authenticated"]:
            raise DomainError("CLAUDE_LOGIN_REQUIRED", "Connect a separate Claude session for SABRE using the CLI", 503)
        with tempfile.TemporaryDirectory(prefix="sabre-claude-") as directory:
            args = cli_arguments()
            if request.model:
                args.extend(["--model", request.model])
            code, raw, _ = await capture_process(args, env=self.environment(), cwd=directory, stdin=request.prompt.encode())
        return parse_result(raw, exit_code=code)


def create_app(runner: ClaudeRunner | None = None, token_file: Path = TOKEN_FILE):
    reject_secret_environment()
    token = read_bridge_token(token_file)
    selected = runner or ClaudeRunner()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(DomainError)
    async def domain_error(request, error):
        return JSONResponse({"code": error.code, "message": error.message}, status_code=error.status_code)

    @app.middleware("http")
    async def authorize(request: Request, call_next):
        if request.url.path != "/health" and not hmac.compare_digest(request.headers.get("authorization", "").encode(), ("Bearer " + token).encode()):
            return JSONResponse({"code": "UNAUTHORIZED"}, status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    async def health():
        return {"status": "ok", "provider": "claude_cli"}

    @app.get("/status")
    async def status():
        return await selected.status()

    @app.post("/invoke")
    async def invoke(request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_INPUT_BYTES * 2:
                raise DomainError("CLAUDE_INPUT_LIMIT", "The Claude request exceeds the limit", 413)
        try:
            payload = InvocationRequest.model_validate_json(raw)
        except ValidationError:
            raise DomainError("CLAUDE_INPUT_INVALID", "The Claude request is invalid", 422) from None
        if len(payload.prompt.encode()) > MAX_INPUT_BYTES:
            raise DomainError("CLAUDE_INPUT_LIMIT", "Claude context exceeds the limit", 413)
        return await selected.invoke(payload)

    return app
