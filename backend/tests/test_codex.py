import asyncio
import json
import sys
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from pydantic import BaseModel

from sabre import codex_model, codex_runner
from sabre.cli_protocol import serialize_turn
from sabre.codex_model import (
    AssistantEnvelope,
    CodexChatModel,
    InvocationRequest,
    InvocationResponse,
    RequestedTool,
    read_bridge_token,
)
from sabre.credentials import Credentials
from sabre.model_providers import chat_model
from sabre.models import DomainError
from sabre.security import SecretGuard
from sabre.service import FactoryService
from sabre.settings import Settings
from sabre.tools import ToolCatalog, ToolDefinition, ToolPolicy


def settings(**changes):
    return Settings(database_url="postgresql://synthetic", auth_token="synthetic-owner-token-long-enough",
        executor_token="synthetic-executor-token-long-enough", model_provider="codex_cli", **changes)


def response(content="", calls=None):
    return InvocationResponse(result=AssistantEnvelope(content=content, tool_calls=calls or []),
        input_tokens=200, output_tokens=40, cached_input_tokens=30)


def events(final=None):
    return b"\n".join(json.dumps(event).encode() for event in [
        {"type": "thread.started", "thread_id": "synthetic"}, {"type": "turn.started"},
        {"type": "item.completed", "item": {"type": "agent_message", "text": (final or AssistantEnvelope(content="done", tool_calls=[])).model_dump_json()}},
        {"type": "turn.completed", "usage": {"input_tokens": 200, "output_tokens": 40, "cached_input_tokens": 30}},
    ])


@pytest.fixture
def token_file(tmp_path):
    file = tmp_path / "token"
    file.write_text("synthetic-bridge-token-long-enough-for-testing")
    file.chmod(0o400)
    return file


def test_cli_provider_requires_neither_api_key_model_override_nor_paid_budget():
    config = settings()
    assert config.model_ready()
    model = chat_model(config)
    assert isinstance(model, CodexChatModel)
    assert model.model_name == ""
    assert model.with_structured_output(AssistantEnvelope) is not None
    with pytest.raises(DomainError):
        chat_model(settings(model_base_url="https://foreign.example"))


def test_codex_wire_bytes_are_unchanged_by_claude_formatting_instructions():
    expected = ('{"instruction":"Produce exactly one assistant turn for the enclosed conversation. '
        'Request only listed tools using the output tool_calls array and JSON-encoded object arguments. '
        'SABRE executes these requests after authorization. Do not invoke native Codex tools. '
        'Follow the specified tool_choice. Return content and tool_calls in the required output schema.",'
        '"tools":[],"tool_choice":"none","conversation":[{"role":"human","content":"fixture"}]}')
    assert serialize_turn([HumanMessage(content="fixture")], [], "none", "Codex").encode() == expected.encode()


async def test_cli_credentials_do_not_offer_unused_api_keys_or_inherit_them():
    cfg = settings(role_models={"qa": {"model_provider": "openai", "model_name": "fixture"}})
    vault = SimpleNamespace(list_metadata=AsyncMock(return_value=[]))
    credentials = Credentials(vault, cfg, SecretGuard())
    assert {target.id for target in credentials.target_list() if target.id.startswith("model.")} == {"model.openai.qa"}
    await credentials.refresh()
    assert cfg.model_api_key.get_secret_value() == ""
    assert cfg.for_role("developer").model_api_key.get_secret_value() == ""
    with pytest.raises(DomainError):
        Credentials(vault, settings(model_secret_ref="model.openai.default"), SecretGuard())


async def test_langchain_tool_loop_and_structured_result_use_only_declared_tools(monkeypatch):
    calls = []

    @tool
    def fixture_status() -> str:
        """Read a synthetic status."""
        calls.append("executed")
        return "ready"

    class Result(BaseModel):
        status: str

    prompts = []

    async def invoke(self, request):
        prompt = json.loads(request.prompt)
        prompts.append(prompt)
        if len(prompts) == 1:
            return response(calls=[RequestedTool(name="fixture_status", arguments_json="{}")])
        assert any(message["role"] == "tool" and message["content"] == "ready" for message in prompt["conversation"])
        return response(calls=[RequestedTool(name="Result", arguments_json='{"status":"ready"}')])

    monkeypatch.setattr(CodexChatModel, "_invoke", invoke)
    graph = create_agent(model=CodexChatModel(), tools=[fixture_status], response_format=Result)
    output = await graph.ainvoke({"messages": [{"role": "user", "content": "Read status"}]})
    assert output["structured_response"] == Result(status="ready")
    assert calls == ["executed"]
    assert output["messages"][-2].usage_metadata["input_tokens"] == 200
    assert output["messages"][-2].response_metadata["usage_kind"] == "cli_invocation"


@pytest.mark.parametrize("name, arguments", [("undeclared", "{}"), ("AssistantEnvelope", "[]"), ("AssistantEnvelope", '{"content":42}')])
async def test_invalid_tool_request_fails_before_execution(monkeypatch, name, arguments):
    monkeypatch.setattr(CodexChatModel, "_invoke", AsyncMock(return_value=response(calls=[RequestedTool(name=name, arguments_json=arguments)])))
    with pytest.raises(DomainError) as error:
        await CodexChatModel().bind_tools([AssistantEnvelope]).ainvoke("fixture")
    assert error.value.code == "CODEX_INVALID_TOOL_REQUEST"


def test_bridge_token_rejects_public_permissions_symlinks_and_oversize(token_file, tmp_path):
    assert read_bridge_token(token_file).startswith("synthetic-")
    token_file.chmod(0o644)
    with pytest.raises(DomainError):
        read_bridge_token(token_file)
    token_file.chmod(0o400)
    link = tmp_path / "link"
    link.symlink_to(token_file)
    with pytest.raises(DomainError):
        read_bridge_token(link)
    token_file.chmod(0o600)
    token_file.write_text("a" * 257)
    with pytest.raises(DomainError):
        read_bridge_token(token_file)


@pytest.mark.parametrize("mutator", [
    lambda raw: raw + b'\n{"type":"error","message":"sensitive"}',
    lambda raw: raw.replace(b'"agent_message"', b'"command_execution"'),
    lambda raw: raw.rsplit(b"\n", 1)[0],
    lambda raw: raw + b"\n" + raw.splitlines()[-1],
    lambda raw: raw.replace(b'"output_tokens": 40', b'"output_tokens": -1'),
    lambda raw: b"[]\n" + raw,
    lambda raw: raw.replace(b'"item": {', b'"item": null, "discarded": {'),
])
def test_protocol_rejects_unsupported_incomplete_or_invalid_events(mutator):
    valid = events()
    assert codex_runner.parse_events(valid).input_tokens == 200
    with pytest.raises(DomainError) as error:
        codex_runner.parse_events(mutator(valid))
    assert error.value.code == "CODEX_PROTOCOL_INVALID"
    assert "sensitive" not in str(error.value)


async def test_runner_auth_input_limits_and_error_redaction(token_file):
    runner = SimpleNamespace(invoke=AsyncMock(return_value=response()), status=AsyncMock(return_value={"authenticated": False}))
    app = codex_runner.create_app(runner, token_file)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        assert (await client.get("/health")).status_code == 200
        assert (await client.get("/status")).status_code == 401
        assert (await client.post("/invoke", json={"prompt": "test"})).status_code == 401
        headers = {"Authorization": "Bearer " + read_bridge_token(token_file)}
        bad = await client.post("/invoke", headers=headers, json={"prompt": "synthetic-private-value", "unknown": "synthetic-private-value"})
        assert bad.status_code == 422 and "synthetic-private-value" not in bad.text
        too_large = await client.post("/invoke", headers=headers, content=b"a" * (codex_model.MAX_INPUT_BYTES * 2 + 1))
        assert too_large.status_code == 413
        good = await client.post("/invoke", headers=headers, json={"prompt": "test"})
        assert good.status_code == 200 and good.headers["cache-control"] == "no-store"
        runner.invoke.assert_awaited_once()


@pytest.mark.parametrize("status, expected", [(b"Logged in using ChatGPT\n", True), (b"Logged in using an API key\n", False), (b"Not logged in\n", False)])
async def test_only_chatgpt_login_status_is_accepted(monkeypatch, tmp_path, status, expected):
    tmp_path.chmod(0o700)
    monkeypatch.setattr(codex_runner, "capture_process", AsyncMock(return_value=(0, b"", status)))
    result = await codex_runner.CodexRunner(tmp_path).status()
    assert result["authenticated"] is expected
    assert "Logged" not in json.dumps(result)


async def test_runner_passes_prompt_only_on_stdin(monkeypatch, tmp_path):
    tmp_path.chmod(0o700)
    runner = codex_runner.CodexRunner(tmp_path)
    monkeypatch.setattr(runner, "_login_status", AsyncMock(return_value={"authenticated": True}))
    capture = AsyncMock(return_value=(0, events(), b"synthetic-private-error"))
    monkeypatch.setattr(codex_runner, "capture_process", capture)
    await runner.invoke(InvocationRequest(prompt="synthetic-private-prompt"))
    args = capture.call_args.args[0]
    assert "synthetic-private-prompt" not in str(args)
    assert capture.call_args.kwargs["stdin"] == b"synthetic-private-prompt"
    assert "-m" not in args
    assert "--ignore-user-config" in args and "--strict-config" in args and "--ephemeral" in args


async def test_process_timeout_kills_child_and_does_not_leak_stderr(tmp_path):
    pid_file = tmp_path / "child"
    script = "import os,sys,time; from pathlib import Path; child=os.fork(); Path(sys.argv[1]).write_text(str(child)) if child else None; print('synthetic-sensitive-stderr',file=sys.stderr,flush=True); time.sleep(60)"
    with pytest.raises(DomainError) as error:
        await codex_runner.capture_process([sys.executable, "-c", script, str(pid_file)], env={"PATH": "/usr/bin"}, cwd=str(tmp_path), timeout=1)
    assert error.value.code == "CODEX_TIMEOUT" and "synthetic-sensitive" not in str(error.value)
    child_pid = int(pid_file.read_text())
    stat_file = Path(f"/proc/{child_pid}/stat")
    if stat_file.exists():
        assert stat_file.read_text().split()[2] == "Z"


@pytest.mark.parametrize("cancelled", [False, True])
async def test_capture_waits_for_child_exit_after_group_leader_has_exited(monkeypatch, tmp_path, cancelled):
    group = 412345
    proc = tmp_path / "proc"
    child = proc / str(group + 1)
    child.mkdir(parents=True)
    stat_file = child / "stat"
    stat_file.write_text(f"{group + 1} (child (nested) name) R 1 {group} {group} 0 0\n")
    monkeypatch.setattr(codex_runner, "_PROC_ROOT", proc, raising=False)
    leader_exited = asyncio.Event()

    async def wait():
        leader_exited.set()
        return -9

    stdout, stderr = asyncio.StreamReader(), asyncio.StreamReader()
    stderr.feed_data(b"synthetic-sensitive-stderr")
    process = SimpleNamespace(pid=group, returncode=-9, wait=wait, stdout=stdout, stderr=stderr,
        stdin=SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock()))
    started = asyncio.Event()

    async def spawn(*args, **kwargs):
        started.set()
        return process

    monkeypatch.setattr(codex_runner.asyncio, "create_subprocess_exec", AsyncMock(side_effect=spawn))
    kill = Mock()
    monkeypatch.setattr(codex_runner.os, "killpg", kill)
    capture = asyncio.create_task(codex_runner.capture_process(["synthetic-process"], env={}, cwd=str(tmp_path), timeout=60 if cancelled else 0))
    try:
        await started.wait()
        if cancelled:
            capture.cancel()
        await leader_exited.wait()
        if cancelled:
            capture.cancel()  # Repeated cancellation must not interrupt cleanup.
        assert not capture.done(), "A reaped leader is not proof that its child has stopped"
        stat_file.write_text(f"{group + 1} (child (nested) name) Z 1 {group} {group} 0 0\n")
        if cancelled:
            with pytest.raises(asyncio.CancelledError):
                await capture
        else:
            with pytest.raises(DomainError) as error:
                await capture
            assert error.value.code == "CODEX_TIMEOUT"
            assert "synthetic-sensitive" not in str(error.value)
        assert all(call.args == (group, codex_runner.signal.SIGKILL) for call in kill.call_args_list)
    finally:
        stat_file.write_text(f"{group + 1} (child) Z 1 {group} {group} 0 0\n")
        await asyncio.gather(capture, return_exceptions=True)


async def test_unconfirmed_process_group_cleanup_is_bounded_and_fails_closed(monkeypatch, tmp_path):
    child = tmp_path / "42"
    child.mkdir()
    (child / "stat").write_text("42 (synthetic-private-process) D 1 41 41 0 0\n")
    monkeypatch.setattr(codex_runner, "_PROC_ROOT", tmp_path)
    monkeypatch.setattr(codex_runner, "_PROCESS_CLEANUP_TIMEOUT_S", 0)
    monkeypatch.setattr(codex_runner.os, "killpg", Mock())
    with pytest.raises(DomainError) as error:
        await codex_runner._terminate_process_group(SimpleNamespace(pid=41, wait=AsyncMock()))
    assert error.value.code == "CODEX_CLEANUP_FAILED"
    assert "synthetic-private" not in str(error.value)


@pytest.mark.parametrize("state,running", [("R", True), ("D", True), ("T", True), ("Z", False), ("X", False)])
def test_process_group_observation_distinguishes_terminal_state_and_other_sessions(monkeypatch, tmp_path, state, running):
    child = tmp_path / "42"
    child.mkdir()
    (child / "stat").write_text(f"42 (worker (name) with spaces) {state} 1 41 41 0 0\n")
    foreign = tmp_path / "43"
    foreign.mkdir()
    (foreign / "stat").write_text("43 (another job) R 1 41 99 0 0\n")
    monkeypatch.setattr(codex_runner, "_PROC_ROOT", tmp_path)
    assert codex_runner._group_running(41) is running


async def test_nonzero_and_output_limit_do_not_become_success(monkeypatch, tmp_path):
    tmp_path.chmod(0o700)
    runner = codex_runner.CodexRunner(tmp_path)
    monkeypatch.setattr(runner, "_login_status", AsyncMock(return_value={"authenticated": True}))
    monkeypatch.setattr(codex_runner, "capture_process", AsyncMock(return_value=(1, events(), b"synthetic-sensitive")))
    with pytest.raises(DomainError) as error:
        await runner.invoke(InvocationRequest(prompt="fixture"))
    assert error.value.code == "CODEX_PROCESS_FAILED"


async def test_private_http_client_rejects_redirect_without_leaking_response(monkeypatch, token_file):
    original = httpx.AsyncClient
    monkeypatch.setattr(codex_model.httpx, "AsyncClient", lambda **kwargs: original(**kwargs,
        transport=httpx.MockTransport(lambda request: httpx.Response(302, headers={"Location": "https://foreign.example/sensitive"}))))
    with pytest.raises(DomainError) as error:
        await CodexChatModel(token_file=token_file).ainvoke("fixture")
    assert "sensitive" not in str(error.value)
    assert error.value.code == "CODEX_RUNNER_FAILED"


async def test_status_probe_does_not_reject_or_overlap_an_invocation(monkeypatch, tmp_path):
    tmp_path.chmod(0o700)
    runner = codex_runner.CodexRunner(tmp_path)
    status_entered, release_status = asyncio.Event(), asyncio.Event()
    inference_entered, release_inference = asyncio.Event(), asyncio.Event()
    probes = 0

    async def login_status():
        nonlocal probes
        probes += 1
        if probes == 1:
            status_entered.set()
            await release_status.wait()
        return {"authenticated": True}

    async def capture(*args, **kwargs):
        assert release_status.is_set()
        inference_entered.set()
        await release_inference.wait()
        return 0, events(), b""

    monkeypatch.setattr(runner, "_login_status", login_status)
    process = AsyncMock(side_effect=capture)
    monkeypatch.setattr(codex_runner, "capture_process", process)
    status_task = asyncio.create_task(runner.status())
    await status_entered.wait()
    invocation = asyncio.create_task(runner.invoke(InvocationRequest(prompt="fixture")))
    try:
        await asyncio.sleep(0)
        assert not invocation.done(), "An admitted invocation must wait for the status probe"
        with pytest.raises(DomainError) as error:
            await runner.invoke(InvocationRequest(prompt="competing"))
        assert error.value.code == "CODEX_BUSY"
        release_status.set()
        await asyncio.wait_for(inference_entered.wait(), 1)
        with pytest.raises(DomainError) as error:
            await runner.status()
        assert error.value.code == "CODEX_BUSY"
        with pytest.raises(DomainError) as error:
            await runner.invoke(InvocationRequest(prompt="competing"))
        assert error.value.code == "CODEX_BUSY"
        release_inference.set()
        assert (await invocation).result.content == "done"
        process.assert_awaited_once()
    finally:
        release_status.set()
        release_inference.set()
        await asyncio.gather(status_task, invocation, return_exceptions=True)


@pytest.mark.parametrize("status, code", [(409, "CODEX_BUSY"), (503, "CODEX_TIMEOUT"),
    (503, "CODEX_PROTOCOL_INVALID"), (503, "CODEX_PROCESS_FAILED"), (503, "CODEX_LOGIN_REQUIRED")])
async def test_http_errors_preserve_only_allowlisted_runner_codes(monkeypatch, token_file, status, code):
    original = httpx.AsyncClient
    monkeypatch.setattr(codex_model.httpx, "AsyncClient", lambda **kwargs: original(**kwargs,
        transport=httpx.MockTransport(lambda request: httpx.Response(status,
            json={"code": code, "message": "synthetic-private-response", "extra": "synthetic-private-response"}))))
    with pytest.raises(DomainError) as error:
        await CodexChatModel(token_file=token_file).ainvoke("fixture")
    assert error.value.code == code
    assert error.value.status_code == status
    assert "synthetic-private-response" not in str(error.value)


@pytest.mark.parametrize("mode", ["cancel", "wait_timeout"])
async def test_interrupted_status_wait_does_not_start_a_model_or_leak_admission(monkeypatch, tmp_path, mode):
    tmp_path.chmod(0o700)
    runner = codex_runner.CodexRunner(tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()

    async def login_status():
        entered.set()
        await release.wait()
        return {"authenticated": True}

    monkeypatch.setattr(runner, "_login_status", login_status)
    capture = AsyncMock(return_value=(0, events(), b""))
    monkeypatch.setattr(codex_runner, "capture_process", capture)
    if mode == "wait_timeout":
        monkeypatch.setattr(codex_runner, "STATUS_WAIT_TIMEOUT_S", 0.01)
    status_task = asyncio.create_task(runner.status())
    await entered.wait()
    invocation = asyncio.create_task(runner.invoke(InvocationRequest(prompt="fixture")))
    try:
        await asyncio.sleep(0)
        if mode == "cancel":
            invocation.cancel()
            with pytest.raises(asyncio.CancelledError):
                await invocation
        else:
            with pytest.raises(DomainError) as error:
                await invocation
            assert error.value.code == "CODEX_BUSY"
        capture.assert_not_awaited()
    finally:
        release.set()
        await asyncio.gather(status_task, invocation, return_exceptions=True)
    assert (await runner.invoke(InvocationRequest(prompt="after interruption"))).result.content == "done"
    capture.assert_awaited_once()


async def test_global_invocation_deadline_cleans_its_process_and_releases_admission(monkeypatch, tmp_path):
    tmp_path.chmod(0o700)
    runner = codex_runner.CodexRunner(tmp_path)
    monkeypatch.setattr(runner, "_login_status", AsyncMock(return_value={"authenticated": True}))
    monkeypatch.setattr(codex_runner, "INVOCATION_TIMEOUT_S", 1)
    pid_file = tmp_path / "child"
    script = "import os,sys,time; from pathlib import Path; child=os.fork(); Path(sys.argv[1]).write_text(str(child)) if child else None; time.sleep(60)"
    actual_capture = codex_runner.capture_process

    async def capture(*args, **kwargs):
        return await actual_capture([sys.executable, "-c", script, str(pid_file)],
            env={"PATH": "/usr/bin"}, cwd=str(tmp_path), timeout=60)

    monkeypatch.setattr(codex_runner, "capture_process", capture)
    with pytest.raises(DomainError) as error:
        await runner.invoke(InvocationRequest(prompt="fixture"))
    assert error.value.code == "CODEX_TIMEOUT"
    child_pid = int(pid_file.read_text())
    child_state = Path(f"/proc/{child_pid}/stat")
    if child_state.exists():
        assert child_state.read_text().split()[2] == "Z"
    monkeypatch.setattr(codex_runner, "capture_process", AsyncMock(return_value=(0, events(), b"")))
    assert (await runner.invoke(InvocationRequest(prompt="after timeout"))).result.content == "done"


@pytest.mark.parametrize("status, body", [
    (503, b'{"code":"foreign-synthetic-private-value","message":"synthetic-private-value"}'),
    (503, b'{"code":["synthetic-private-value"]}'),
    (503, b'{"code":"CODEX_BUSY","message":"synthetic-private-value"}'),
    (500, b'["synthetic-private-value"]'),
    (500, b"invalid-synthetic-private-value"),
    (500, b"\xff"),
    (500, b"[" * 1500 + b"0" + b"]" * 1500),
])
async def test_invalid_runner_errors_fail_closed_without_remote_content(monkeypatch, token_file, status, body):
    original = httpx.AsyncClient
    handler = Mock(return_value=httpx.Response(status, content=body))
    monkeypatch.setattr(codex_model.httpx, "AsyncClient", lambda **kwargs: original(**kwargs,
        transport=httpx.MockTransport(handler)))
    with pytest.raises(DomainError) as error:
        await CodexChatModel(token_file=token_file).ainvoke("fixture")
    assert error.value.code == "CODEX_RUNNER_FAILED"
    assert "synthetic-private-value" not in str(error.value)
    handler.assert_called_once()


async def test_runner_error_body_is_bounded_without_reading_the_remainder(monkeypatch, token_file):
    class OversizedError(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"x" * (codex_model.MAX_ERROR_BYTES + 1)
            raise AssertionError("Error response must not be read beyond its bound")

    original = httpx.AsyncClient
    monkeypatch.setattr(codex_model.httpx, "AsyncClient", lambda **kwargs: original(**kwargs,
        transport=httpx.MockTransport(lambda request: httpx.Response(503, stream=OversizedError()))))
    with pytest.raises(DomainError) as error:
        await CodexChatModel(token_file=token_file).ainvoke("fixture")
    assert error.value.code == "CODEX_RUNNER_FAILED"


async def test_process_output_limit_terminates_process(tmp_path):
    with pytest.raises(DomainError) as error:
        await codex_runner.capture_process([sys.executable, "-c", "import sys,time;sys.stdout.write('x'*300000);sys.stdout.flush();time.sleep(60)"],
            env={"PATH": "/usr/bin"}, cwd=str(tmp_path), timeout=5)
    assert error.value.code == "CODEX_OUTPUT_LIMIT"


@pytest.mark.parametrize("status, payload, expected", [
    (200, {"authenticated": False, "provider": "codex_cli", "usage_kind": "cli_invocation"}, False),
    (200, {"authenticated": True, "provider": "codex_cli", "usage_kind": "cli_invocation"}, True),
    (409, {"code": "CODEX_BUSY"}, None),
])
async def test_readiness_reports_actual_session_state(monkeypatch, token_file, status, payload, expected):
    original = httpx.AsyncClient
    monkeypatch.setattr(codex_model.httpx, "AsyncClient", lambda **kwargs: original(**kwargs,
        transport=httpx.MockTransport(lambda request: httpx.Response(status, json=payload))))
    result = await codex_model.runner_status(settings(codex_cli_token_file=token_file))
    assert result["available"] is True
    assert result["authenticated"] is expected
    assert result["busy"] is (status == 409)


def test_reasoning_is_discarded_without_changing_final_result():
    lines = events().splitlines()
    lines.insert(2, b'{"type":"item.completed","item":{"type":"reasoning","text":"synthetic internal reasoning"}}')
    result = codex_runner.parse_events(b"\n".join(lines))
    assert "reasoning" not in result.model_dump_json()
    assert result.result.content == "done"


@pytest.mark.parametrize("state, expected", [
    ({"available": True, "authenticated": True, "busy": False}, True),
    ({"available": True, "authenticated": False, "busy": False}, False),
    ({"available": True, "authenticated": None, "busy": True}, False),
    (DomainError("CODEX_RUNNER_UNAVAILABLE", "synthetic-private-dependency-message", 503), False),
])
async def test_factory_status_uses_real_cli_readiness_and_preserves_other_provider_roles(monkeypatch, state, expected):
    probe = AsyncMock(side_effect=state) if isinstance(state, Exception) else AsyncMock(return_value=state)
    monkeypatch.setattr(codex_model, "runner_status", probe)
    config = settings(monthly_budget_usd=10, role_models={"qa": {"model_provider": "openai", "model_name": "fixture",
        "model_api_key": "synthetic-api-key", "model_input_usd_per_million": 1, "model_output_usd_per_million": 1}})
    service = FactoryService(SimpleNamespace(healthy=AsyncMock(return_value=True)), None, None, SimpleNamespace(), SecretGuard(), config)
    result = await service.status()
    assert result["model"]["configured"] is expected
    assert result["roles"]["developer"]["configured"] is expected
    assert result["roles"]["qa"]["configured"] is True
    assert "synthetic-private" not in json.dumps(result)
    if isinstance(state, Exception):
        assert result["model"]["cli"]["available"] is False
        assert result["model"]["cli"]["error_code"] == "CODEX_RUNNER_UNAVAILABLE"
    probe.assert_awaited_once()


async def test_tool_schema_cannot_fetch_an_external_reference(monkeypatch):
    fetch = Mock(side_effect=AssertionError("External schema retrieval must never run"))
    monkeypatch.setattr(urllib.request, "urlopen", fetch)
    result = response(calls=[RequestedTool(name="foreign", arguments_json='{"value":"x"}')])
    monkeypatch.setattr(CodexChatModel, "_invoke", AsyncMock(return_value=result))
    tool_schema = {"type": "function", "function": {"name": "foreign", "description": "Synthetic tool", "parameters": {
        "type": "object", "properties": {"value": {"$ref": "http://127.0.0.1:9/private-schema"}}, "required": ["value"]}}}
    with pytest.raises(DomainError) as error:
        await CodexChatModel().bind_tools([tool_schema]).ainvoke("fixture")
    assert error.value.code == "CODEX_INVALID_TOOL_REQUEST"
    fetch.assert_not_called()


@pytest.mark.parametrize("reference, succeeds", [("#/$defs/value", True), ("http://127.0.0.1:9/private-schema", False)])
async def test_catalog_resolves_local_definitions_without_remote_fetch(monkeypatch, reference, succeeds):
    fetch = Mock(side_effect=AssertionError("External schema retrieval must never run"))
    monkeypatch.setattr(urllib.request, "urlopen", fetch)
    handler = AsyncMock(return_value="ready")
    catalog = ToolCatalog()
    schema = {"type": "object", "$defs": {"value": {"type": "string"}}, "properties": {"value": {"$ref": reference}}, "required": ["value"]}
    catalog.register(ToolDefinition("fixture", "Synthetic tool", schema, ToolPolicy(frozenset({"developer"}), "read"), handler))
    if succeeds:
        assert await catalog.invoke("fixture", {"value": "x"}, "developer") == "ready"
        handler.assert_awaited_once_with(value="x")
    else:
        with pytest.raises(DomainError) as error:
            await catalog.invoke("fixture", {"value": "x"}, "developer")
        assert error.value.code == "INVALID_TOOL_ARGUMENTS"
        assert "private-schema" not in str(error.value)
        handler.assert_not_awaited()
    fetch.assert_not_called()
