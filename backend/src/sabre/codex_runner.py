"""Private Codex process boundary. No project mounts or control credentials belong here."""

import asyncio
import hmac
import json
import os
import signal
import stat
import tempfile
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

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
from sabre.models import DomainError
from sabre.settings import reject_secret_environment

BINARY = "/opt/codex/bin/codex"
CODEX_HOME = Path("/var/lib/sabre-codex")
STATUS_WAIT_TIMEOUT_S = 12
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


async def capture_process(args: list[str], *, env: dict[str, str], cwd: str, stdin: bytes = b"", timeout: int = INVOCATION_TIMEOUT_S):
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
        readers = [asyncio.create_task(read(process.stdout, MAX_OUTPUT_BYTES)), asyncio.create_task(read(process.stderr, 32768))]
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
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()


def parse_events(raw: bytes) -> InvocationResponse:
    final = None
    usage = None
    started = False
    turn_started = False
    try:
        for line in raw.splitlines():
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError
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
                    if item.get("type") != "agent_message":
                        raise ValueError
                    final = AssistantEnvelope.model_validate_json(item["text"])
                case "turn.completed":
                    if final is None or usage is not None:
                        raise ValueError
                    usage = event["usage"]
                case _:
                    raise ValueError
        if final is None or usage is None:
            raise ValueError
        return InvocationResponse(result=final, input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"], cached_input_tokens=usage["cached_input_tokens"])
    except (ValueError, TypeError, KeyError, ValidationError):
        raise DomainError("CODEX_PROTOCOL_INVALID", "Codex returned events incompatible with the adapter", 503) from None


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
        with tempfile.TemporaryDirectory(prefix="sabre-codex-") as directory:
            schema = Path(directory) / "response-schema.json"
            schema.write_text(json.dumps(AssistantEnvelope.model_json_schema()), encoding="utf-8")
            args = [*cli_arguments(home=self.home, workspace=Path(directory)), "--ignore-rules", "--ephemeral", "--json",
                "--skip-git-repo-check", "-C", directory, "--output-schema", str(schema)]
            if request.model:
                args.extend(["-m", request.model])
            code, raw, _ = await capture_process([*args, "-"], env=self.environment(), cwd=directory, stdin=request.prompt.encode())
        if code:
            raise DomainError("CODEX_PROCESS_FAILED", "The Codex process ended without a valid result", 503)
        return parse_events(raw)


def create_app(runner: CodexRunner | None = None, token_file: Path = TOKEN_FILE):
    reject_secret_environment()
    token = read_bridge_token(token_file)
    selected = runner or CodexRunner()
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
        if len(payload.prompt.encode()) > MAX_INPUT_BYTES:
            raise DomainError("CODEX_INPUT_LIMIT", "Codex context exceeds the limit", 413)
        return await selected.invoke(payload)

    return app
