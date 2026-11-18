"""Private Codex process boundary. No project mounts or control credentials belong here."""

import asyncio
import hmac
import json
import os
import re
import shutil
import signal
import stat
import tempfile
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from sabre.cli_protocol import status_failure
from sabre.codex_model import (
    INVOCATION_TIMEOUT_S,
    MAX_INPUT_BYTES,
    MAX_OUTPUT_BYTES,
    TOKEN_FILE,
    AssistantEnvelope,
    InvocationRequest,
    InvocationResponse,
    read_bridge_token,
)
from sabre.framework import TELEMETRY_OFF
from sabre.logs import log
from sabre.models import DomainError
from sabre.settings import reject_secret_environment

BINARY = "/opt/codex/bin/codex"
CODEX_HOME = Path("/var/lib/sabre-codex")
STATUS_WAIT_TIMEOUT_S = 12
_PROC_ROOT = Path("/proc")
_PROCESS_CLEANUP_TIMEOUT_S = 5
_PROCESS_CLEANUP_POLL_S = 0.01
# Where every call runs. The CLI writes its working directory, and the paths its permission profile
# names, into a message that comes before the prompt. A new directory for each call changed the
# request before the conversation began, so no call started the way the one before it did.
TURN_DIRECTORY = Path(tempfile.gettempdir()) / "sabre-codex-turn"
SCHEMA_FILE = "response-schema.json"
# How the pinned CLI says that a turn failed, read from the beginning of its message only. The CLI
# writes that beginning itself: the status it met, or one of two sentences of its own. What the
# provider said comes after it and is never read, kept, logged or returned. The native check holds
# each of these against the pinned binary.
FAILED_STATUS = re.compile(r"(?:unexpected status|exceeded retry limit, last status:) ([1-5][0-9]{2}) ")
USAGE_LIMIT = "You\u2019ve hit your usage limit"
HIGH_DEMAND = "We\u2019re currently experiencing high demand"
# While it reconnects after a failure it may still recover from, the CLI writes one of these and goes on.
RECONNECTING = "Reconnecting... "
TURN_FAILURES = {
    "rate_limit": ("CODEX_RATE_LIMITED", "Codex reported a rate or usage limit"),
    "overloaded": ("CODEX_OVERLOADED", "Codex reported that the service is overloaded"),
    "authentication": ("CODEX_ACCESS_DENIED", "The provider refused the Codex session or its access"),
    "invalid_request": ("CODEX_REQUEST_REJECTED", "The provider rejected the request Codex sent"),
    "timeout": ("CODEX_TIMEOUT", "The Codex invocation timed out"),
}
POLICY = {
    "approval_policy": "never", "default_permissions": "sabre", "web_search": "disabled",
    "cli_auth_credentials_store": "file", "forced_login_method": "chatgpt", "check_for_update_on_startup": False,
    "project_doc_max_bytes": 0, "history.persistence": "none",
    "analytics.enabled": False, "feedback.enabled": False,
    "otel.exporter": "none", "otel.trace_exporter": "none", "otel.metrics_exporter": "none",
    "skills.bundled.enabled": False, "agents.enabled": False,
    **{f"features.{name}": False for name in (
        "apps", "plugins", "remote_plugin", "shell_snapshot", "unbounded_connection_retries",
        "memories", "goals", "image_generation", "browser_use", "computer_use", "in_app_browser",
        "shell_tool", "view_image",
    )},
}


def cli_arguments(command: str = "exec", *, home: Path = CODEX_HOME, workspace: Path | None = None,
                  secrets_dir: Path = Path("/run/secrets")) -> list[str]:
    args = [BINARY, command]
    if command == "exec":
        args.extend(["--ignore-user-config", "--strict-config"])
    for key, value in POLICY.items():
        args.extend(["-c", f"{key}={json.dumps(value)}"])
    paths = {":minimal": "read", str(home): "deny", str(secrets_dir): "deny"}
    if workspace is not None:
        paths[str(workspace)] = "read"
    filesystem = "{ " + ", ".join(f"{json.dumps(path)}={json.dumps(permission)}" for path, permission in paths.items()) + " }"
    args.extend(["-c", "permissions.sabre.filesystem=" + filesystem, "-c", "permissions.sabre.network.enabled=false"])
    return args


def turn_arguments(directory: str, *, home: Path = CODEX_HOME, model: str = "", effort: str = "",
                   secrets_dir: Path = Path("/run/secrets")) -> list[str]:
    """The command line of one call run in ``directory``, which also holds the schema of the answer."""
    args = [*cli_arguments(home=home, workspace=Path(directory), secrets_dir=secrets_dir), "--ignore-rules", "--ephemeral", "--json",
        "--skip-git-repo-check", "-C", directory, "--output-schema", str(Path(directory) / SCHEMA_FILE)]
    if model:
        args.extend(["-m", model])
    if effort:
        # The CLI passes the level to the provider as it is; without one it asks for its own default for the model.
        args.extend(["-c", f"model_reasoning_effort={json.dumps(effort)}"])
    return args


@contextmanager
def turn_directory():
    """An empty working directory for one call, at a path that never changes. Calls are serialized by the invocation lock."""
    shutil.rmtree(TURN_DIRECTORY, ignore_errors=True)
    try:
        TURN_DIRECTORY.mkdir(mode=0o700)
    except OSError:
        raise DomainError("CODEX_PROCESS_UNAVAILABLE", "Could not start the configured Codex runner", 503) from None
    try:
        yield str(TURN_DIRECTORY)
    finally:
        shutil.rmtree(TURN_DIRECTORY, ignore_errors=True)


def _group_running(group: int) -> bool:
    for entry in _PROC_ROOT.iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = (entry / "stat").read_text(encoding="utf-8", errors="replace").rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        # comm can contain spaces and parentheses; numeric fields begin after
        # its final ')'. Zombies have exited even if init has not reaped them.
        if int(fields[2]) == group and int(fields[3]) == group and fields[0] not in {"Z", "X", "x"}:
            return True
    return False


async def _terminate_process_group(process):
    try:
        async with asyncio.timeout(_PROCESS_CLEANUP_TIMEOUT_S):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()
            while True:
                if not _group_running(process.pid):
                    # Confirm after a scheduling boundary so a fork completing
                    # during the previous /proc scan cannot escape observation.
                    await asyncio.sleep(0)
                    if not _group_running(process.pid):
                        break
                # A child can finish forking while the first group signal is
                # delivered. Keep the owned group stopped until no member runs.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await asyncio.sleep(_PROCESS_CLEANUP_POLL_S)
    except (TimeoutError, OSError, ValueError, IndexError):
        raise DomainError("CODEX_CLEANUP_FAILED", "Could not confirm that the invocation's process group stopped", 503) from None


async def capture_process(args: list[str], *, env: dict[str, str], cwd: str, stdin: bytes = b"", timeout: int = INVOCATION_TIMEOUT_S,
                          maximum_output: int = MAX_OUTPUT_BYTES):
    try:
        process = await asyncio.create_subprocess_exec(*args, cwd=cwd, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True)
    except OSError:
        raise DomainError("CODEX_PROCESS_UNAVAILABLE", "Could not start the configured Codex runner", 503) from None

    async def read(stream, maximum):
        output = bytearray()
        while chunk := await stream.read(8192):
            output.extend(chunk)
            if len(output) > maximum:
                raise DomainError("CODEX_OUTPUT_LIMIT", "Codex process output exceeds the limit", 503)
        return bytes(output)

    async def exchange():
        if process.stdin is None:
            raise DomainError("CODEX_PROCESS_UNAVAILABLE", "Codex did not open its input channel", 503)
        process.stdin.write(stdin)
        await process.stdin.drain()
        process.stdin.close()
        readers = [asyncio.create_task(read(process.stdout, maximum_output)), asyncio.create_task(read(process.stderr, 32768))]
        try:
            stdout, stderr = await asyncio.gather(*readers)
        finally:
            for reader in readers:
                reader.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
        await process.wait()
        return process.returncode, stdout, stderr

    try:
        async with asyncio.timeout(timeout):
            return await exchange()
    except (BrokenPipeError, ConnectionResetError):
        raise DomainError("CODEX_PROCESS_FAILED", "The Codex process closed its input channel", 503) from None
    except TimeoutError:
        raise DomainError("CODEX_TIMEOUT", "The Codex invocation timed out", 503) from None
    finally:
        # Each invocation owns a new process group; cancellation never kills another job.
        cleanup = asyncio.create_task(_terminate_process_group(process))
        interrupted = False
        while True:
            try:
                await asyncio.shield(cleanup)
                break
            except asyncio.CancelledError:
                interrupted = True
                if cleanup.done():
                    cleanup.result()
        if interrupted:
            raise asyncio.CancelledError


def turn_failure(raw: bytes) -> DomainError | None:
    """The failure the CLI reported for its turn, as an error of the bridge; None when it named none this bridge knows."""
    message = None
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, RecursionError):
            return None
        if isinstance(event, dict) and event.get("type") == "turn.failed":
            error = event.get("error")
            message = error.get("message") if isinstance(error, dict) else None
    if not isinstance(message, str):
        return None
    failure = None
    status = FAILED_STATUS.match(message)
    if status:
        failure = status_failure(int(status.group(1)))
    elif message.startswith(USAGE_LIMIT):
        failure = "rate_limit"
    elif message.startswith(HIGH_DEMAND):
        failure = "overloaded"
    elif message.startswith("{"):
        # A request the provider refuses outright reaches the CLI's output as the provider's own error document.
        try:
            document = json.loads(message)
        except (ValueError, RecursionError):
            document = None
        if isinstance(document, dict) and isinstance(document.get("error"), dict):
            failure = "invalid_request"
    if failure not in TURN_FAILURES:
        return None
    code, text = TURN_FAILURES[failure]
    return DomainError(code, text, 503)


def parse_events(raw: bytes) -> InvocationResponse:
    final = None
    usage = None
    started = False
    turn_started = False
    reason = "event_json"
    event = None
    envelope_error: ValidationError | None = None
    try:
        for line in raw.splitlines():
            reason = "event_json"
            event = None
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError
            reason = "event_sequence"
            match event.get("type"):
                case "thread.started":
                    if started or turn_started:
                        raise ValueError
                    started = True
                case "turn.started":
                    if not started or turn_started:
                        raise ValueError
                    turn_started = True
                case "item.completed":
                    item = event.get("item", {})
                    if not isinstance(item, dict):
                        raise ValueError
                    if not turn_started or usage is not None or final is not None:
                        raise ValueError
                    if item.get("type") == "reasoning" and isinstance(item.get("text"), str):
                        continue
                    reason = "item_type"
                    if item.get("type") != "agent_message":
                        raise ValueError
                    reason = "assistant_envelope"
                    if not isinstance(item.get("text"), str):
                        raise ValueError
                    # The pinned CLI emits commentary and the structured final answer with the
                    # same item type. Commentary grants nothing; exactly one final envelope is required.
                    try:
                        final = AssistantEnvelope.model_validate_json(item["text"])
                        envelope_error = None
                    except ValidationError as failure:
                        envelope_error = failure
                case "turn.completed":
                    if final is None and envelope_error is not None:
                        reason = "assistant_envelope"
                        raise envelope_error
                    if final is None or usage is not None:
                        raise ValueError
                    usage = event["usage"]
                case "error":
                    # A note that the CLI is reconnecting, written before a turn it then completes. Any other error is not an answer.
                    message = event.get("message")
                    if not turn_started or usage is not None or not isinstance(message, str) or not message.startswith(RECONNECTING):
                        raise ValueError
                case _:
                    reason = "event_type"
                    raise ValueError
        reason = "incomplete_turn"
        if final is None or usage is None:
            raise ValueError
        reason = "usage_schema"
        return InvocationResponse(result=final, input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"], cached_input_tokens=usage["cached_input_tokens"])
    except (ValueError, TypeError, KeyError, ValidationError) as error:
        # Only a closed vocabulary leaves the runner; event bodies and validation inputs never do.
        event_type = event.get("type") if isinstance(event, dict) else None
        if not isinstance(event_type, str) or event_type not in {
            "thread.started", "turn.started", "item.started", "item.updated", "item.completed", "turn.completed", "turn.failed", "error",
        }:
            event_type = "unknown"
        item = event.get("item") if isinstance(event, dict) else None
        item_type = item.get("type") if isinstance(item, dict) else None
        if not isinstance(item_type, str) or item_type not in {
            "agent_message", "reasoning", "command_execution", "mcp_tool_call", "web_search", "file_change", "todo_list", "error", "code_tool_call", "code_execution",
        }:
            item_type = "unknown"
        if isinstance(error, ValidationError):
            errors = error.errors(include_input=False, include_context=False, include_url=False)
            kind = errors[0]["type"] if errors else "validation"
            if kind in {"json_invalid", "extra_forbidden", "missing", "string_type", "list_type", "too_long", "int_type", "greater_than_equal"}:
                reason += "." + kind
        log("model.failed", error_code="CODEX_PROTOCOL_INVALID", kind=f"{reason}.{event_type}.{item_type}")
        raise DomainError("CODEX_PROTOCOL_INVALID", "Codex returned events incompatible with the adapter", 503) from None


def turn_result(code: int, raw: bytes) -> InvocationResponse:
    """What a finished process means: the failure the CLI named for its turn, a process that failed, or its answer."""
    failure = turn_failure(raw)
    if failure is not None:
        raise failure
    if code:
        raise DomainError("CODEX_PROCESS_FAILED", "The Codex process ended without a valid result", 503)
    return parse_events(raw)


class CodexRunner:
    def __init__(self, home: Path = CODEX_HOME):
        self.home = home
        self.lock = asyncio.Lock()
        self.invocation_lock = asyncio.Lock()

    def environment(self):
        try:
            info = self.home.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
                raise ValueError
        except (OSError, ValueError):
            raise DomainError("CODEX_HOME_INVALID", "Codex requires its own private authentication directory", 503) from None
        return {"HOME": str(self.home), "CODEX_HOME": str(self.home), "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8", "TERM": "dumb"}

    async def _login_status(self):
        code, output, stderr = await capture_process([*cli_arguments("login", home=self.home), "status"],
            env=self.environment(), cwd=str(self.home), timeout=10)
        lines = (output + b"\n" + stderr).splitlines()
        authenticated = code == 0 and b"Logged in using ChatGPT" in lines and not any(b"API key" in line for line in lines)
        return {"authenticated": authenticated, "provider": "codex_cli", "usage_kind": "cli_invocation"}

    async def status(self):
        if self.invocation_lock.locked() or self.lock.locked():
            raise DomainError("CODEX_BUSY", "Codex is already processing another invocation", 409)
        async with self.lock:
            return await self._login_status()

    async def invoke(self, request: InvocationRequest):
        if self.invocation_lock.locked():
            raise DomainError("CODEX_BUSY", "Codex is already processing another invocation", 409)
        async with self.invocation_lock:
            try:
                # Admission excludes other invocations and new status probes. Only
                # an already-running status probe may delay this single invocation.
                async with asyncio.timeout(INVOCATION_TIMEOUT_S):
                    try:
                        await asyncio.wait_for(self.lock.acquire(), STATUS_WAIT_TIMEOUT_S)
                    except TimeoutError:
                        raise DomainError("CODEX_BUSY", "The Codex status check timed out", 409) from None
                    try:
                        return await self._invoke_locked(request)
                    finally:
                        self.lock.release()
            except TimeoutError:
                raise DomainError("CODEX_TIMEOUT", "The Codex invocation timed out", 503) from None

    async def _invoke_locked(self, request: InvocationRequest):
        if not (await self._login_status())["authenticated"]:
            raise DomainError("CODEX_LOGIN_REQUIRED", "Connect a separate ChatGPT session for SABRE using the CLI", 503)
        with turn_directory() as directory:
            (Path(directory) / SCHEMA_FILE).write_text(json.dumps(AssistantEnvelope.model_json_schema()), encoding="utf-8")
            args = turn_arguments(directory, home=self.home, model=request.model, effort=request.effort)
            code, raw, _ = await capture_process([*args, "-"], env=self.environment(), cwd=directory, stdin=request.prompt.encode())
        return turn_result(code, raw)


def create_app(runner: CodexRunner | None = None, token_file: Path = TOKEN_FILE):
    reject_secret_environment()
    token = read_bridge_token(token_file)
    selected = runner or CodexRunner()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, telemetry=TELEMETRY_OFF)

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
        return {"status": "ok", "provider": "codex_cli"}

    @app.get("/status")
    async def status():
        return await selected.status()

    @app.post("/invoke")
    async def invoke(request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_INPUT_BYTES * 2:
                raise DomainError("CODEX_INPUT_LIMIT", "The Codex request exceeds the limit", 413)
        try:
            payload = InvocationRequest.model_validate_json(raw)
        except ValidationError:
            raise DomainError("CODEX_INPUT_INVALID", "The Codex request is invalid", 422) from None
        if payload.segments:
            # Codex takes its prompt as one text; blocks are the Claude runner's form.
            raise DomainError("CODEX_INPUT_INVALID", "The Codex request is invalid", 422)
        if len(payload.prompt.encode()) > MAX_INPUT_BYTES:
            raise DomainError("CODEX_INPUT_LIMIT", "Codex context exceeds the limit", 413)
        return await selected.invoke(payload)

    return app
