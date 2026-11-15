import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import BaseModel

from sabre import claude_model, claude_runner
from sabre.claude_model import ClaudeChatModel, ClaudeInvocationResponse, read_bridge_token
from sabre.cli_protocol import read_lines, serialize_turn
from sabre.codex_model import AssistantEnvelope, InvocationRequest, InvocationResponse, RequestedTool
from sabre.models import DomainError


def result_bytes(**overrides):
    return json.dumps({"type": "result", "subtype": "success", "is_error": False,
        "structured_output": AssistantEnvelope(content="done", tool_calls=[]).model_dump(),
        "usage": {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 30, "cache_creation_input_tokens": 40},
        **overrides}).encode()


@pytest.fixture
def token_file(tmp_path):
    file = tmp_path / "token"
    file.write_text("synthetic-bridge-token-long-enough-for-testing")
    file.chmod(0o400)
    return file


async def test_langchain_retains_its_tool_loop_and_structured_result(monkeypatch):
    executions = []

    @tool
    def fixture_status() -> str:
        """Read synthetic status."""
        executions.append("executed")
        return "ready"

    class Result(BaseModel):
        status: str

    requests = []

    async def invoke(self, request):
        # The adapter sends blocks; together they are the prompt. It names no effort unless one is configured.
        assert not request.prompt and request.segments and request.effort == ""
        prompt = read_lines("".join(request.segments))
        requests.append(prompt)
        assert "output_schema" not in prompt
        requested = RequestedTool(name="fixture_status", arguments_json="{}") if len(requests) == 1 else RequestedTool(name="Result", arguments_json='{"status":"ready"}')
        return ClaudeInvocationResponse(result=AssistantEnvelope(content="", tool_calls=[requested]),
            input_tokens=170, output_tokens=20, cached_input_tokens=30, cache_creation_input_tokens=40)

    monkeypatch.setattr(ClaudeChatModel, "_invoke", invoke)
    graph = create_agent(model=ClaudeChatModel(), tools=[fixture_status], response_format=Result)
    output = await graph.ainvoke({"messages": [{"role": "user", "content": "Read status"}]})
    assert output["structured_response"] == Result(status="ready")
    assert executions == ["executed"]
    assert any(item["role"] == "tool" and item["content"] == "ready" for item in requests[1]["conversation"])
    assert output["messages"][-2].usage_metadata["input_tokens"] == 170
    assert output["messages"][-2].usage_metadata["input_token_details"] == {"cache_read": 30, "cache_creation": 40}
    assert output["messages"][-2].response_metadata["protocol"] == "claude_lines_v1"


def test_claude_instruction_separates_native_formatting_from_authorized_sabre_actions():
    history = [HumanMessage(content="Conserva la decisión"), ToolMessage(content="unchanged evidence", tool_call_id="read-1")]
    original = [message.model_dump() for message in history]
    payload = read_lines(serialize_turn(history, [], "none", "Claude"))
    instruction = payload["instruction"]
    assert "native StructuredOutput tool" in instruction
    assert "tool_choice governs that array, not the formatting tool" in instruction
    assert "Do not invoke any other native Claude tool" in instruction
    assert "Request only listed SABRE tools in the output tool_calls array" in instruction
    assert payload["tools"] == [] and payload["tool_choice"] == "none"
    assert payload["conversation"] == [{"role": "human", "content": "Conserva la decisión"},
        {"role": "tool", "content": "unchanged evidence", "tool_call_id": "read-1"}]
    assert [message.model_dump() for message in history] == original


@pytest.mark.parametrize("changes, code", [({"subtype": "error_max_turns"}, "CLAUDE_TURN_LIMIT"),
    ({"is_error": True}, "CLAUDE_EXECUTION_FAILED"),
    ({"structured_output": "private-invalid"}, "CLAUDE_STRUCTURED_OUTPUT_INVALID"),
    ({"structured_output": None, "result": '{"content":"valid prose JSON","tool_calls":[]}'}, "CLAUDE_STRUCTURED_OUTPUT_MISSING"),
    ({"permission_denials": [{"tool": "Read"}]}, "CLAUDE_NATIVE_TOOL_DENIED"),
    ({"usage": {"input_tokens": True}}, "CLAUDE_USAGE_INVALID"), ({"usage": None}, "CLAUDE_USAGE_INVALID"),
    ({"type": "unknown-private-value"}, "CLAUDE_PROTOCOL_INVALID")])
def test_result_rejects_failure_or_missing_usage(changes, code):
    valid = claude_runner.parse_result(result_bytes())
    assert valid.input_tokens == 170 and valid.output_tokens == 20 and valid.cached_input_tokens == 30
    assert valid.cache_creation_input_tokens == 40
    with pytest.raises(DomainError) as error:
        claude_runner.parse_result(result_bytes(**changes))
    assert error.value.code == code
    assert "private-invalid" not in str(error.value)


def test_nonzero_exit_cannot_become_success_and_known_failure_stays_classified():
    with pytest.raises(DomainError) as error:
        claude_runner.parse_result(result_bytes(), exit_code=1)
    assert error.value.code == "CLAUDE_PROCESS_FAILED"
    with pytest.raises(DomainError) as error:
        claude_runner.parse_result(result_bytes(subtype="error_max_turns", is_error=True), exit_code=1)
    assert error.value.code == "CLAUDE_TURN_LIMIT"


@pytest.mark.parametrize("method, subscription, authenticated", [("claude.ai", "pro", True), ("claude.ai", "max", True),
    ("claude.ai", "ultra", True), ("api_key", "pro", False), ("oauth_token", "max", False), ("none", None, False)])
async def test_auth_requires_personal_first_party_session(monkeypatch, tmp_path, method, subscription, authenticated):
    tmp_path.chmod(0o700)
    raw = json.dumps({"loggedIn": method != "none", "authMethod": method, "apiProvider": "firstParty",
        "subscriptionType": subscription, "email": "synthetic-private-value"}).encode()
    monkeypatch.setattr(claude_runner, "capture_process", AsyncMock(return_value=(0, raw, b"")))
    result = await claude_runner.ClaudeRunner(tmp_path).status()
    assert result["authenticated"] is authenticated
    assert "synthetic-private-value" not in json.dumps(result)


@pytest.mark.parametrize("subscription", ["team", "enterprise", "unknown", None])
async def test_organizational_or_unknown_subscriptions_fail_closed(monkeypatch, tmp_path, subscription):
    tmp_path.chmod(0o700)
    raw = json.dumps({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": subscription}).encode()
    monkeypatch.setattr(claude_runner, "capture_process", AsyncMock(return_value=(0, raw, b"")))
    with pytest.raises(DomainError, match="personal Claude"):
        await claude_runner.ClaudeRunner(tmp_path).invoke(InvocationRequest(segments=["fixture"]))
    assert claude_runner.capture_process.await_count == 1


async def test_policy_cache_blocks_before_any_process_without_reading_it(monkeypatch, tmp_path):
    tmp_path.chmod(0o700)
    cache = tmp_path / "remote-settings.json"
    cache.write_text("synthetic-private-value")
    cache.chmod(0)
    capture = AsyncMock()
    monkeypatch.setattr(claude_runner, "capture_process", capture)
    with pytest.raises(DomainError) as error:
        await claude_runner.ClaudeRunner(tmp_path).status()
    assert error.value.code == "CLAUDE_POLICY_UNSUPPORTED"
    capture.assert_not_awaited()
    assert cache.exists()


async def test_runner_stdin_closed_environment_and_default_model(monkeypatch, tmp_path):
    tmp_path.chmod(0o700)
    runner = claude_runner.ClaudeRunner(tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-private-value")
    monkeypatch.setattr(runner, "_login_status", AsyncMock(return_value={"authenticated": True}))
    capture = AsyncMock(return_value=(0, result_bytes(), b"synthetic-private-error"))
    monkeypatch.setattr(claude_runner, "capture_process", capture)
    await runner.invoke(InvocationRequest(segments=["synthetic-private-header\n", "synthetic-private-prompt\n"]))
    arguments = capture.call_args.args[0]
    assert "synthetic-private" not in str(arguments)
    # The prompt reaches the CLI on standard input only, as one user message whose blocks are the segments in order.
    sent = json.loads(capture.call_args.kwargs["stdin"])
    assert capture.call_args.kwargs["stdin"].endswith(b"\n") and capture.call_args.kwargs["stdin"].count(b"\n") == 1
    # The last block, and only the last, carries the factory's own cache point.
    assert sent == {"type": "user", "message": {"role": "user", "content": [
        {"type": "text", "text": "synthetic-private-header\n"},
        {"type": "text", "text": "synthetic-private-prompt\n", "cache_control": {"type": "ephemeral"}}]}}
    assert [arguments[arguments.index(flag) + 1] for flag in ("--input-format", "--output-format")] == ["stream-json", "stream-json"]
    assert "--verbose" in arguments and "--no-session-persistence" in arguments
    # Every call runs in the same empty directory, which is gone afterwards: the CLI names it in each request.
    assert capture.call_args.kwargs["cwd"] == str(claude_runner.TURN_DIRECTORY) and not claude_runner.TURN_DIRECTORY.exists()
    assert capture.call_args.kwargs["maximum_output"] == claude_runner.STREAM_OUTPUT_BYTES
    assert "--model" not in arguments
    assert json.loads(arguments[arguments.index("--json-schema") + 1]) == AssistantEnvelope.model_json_schema()
    assert arguments[arguments.index("--max-turns") + 1] == "2"
    assert arguments[arguments.index("--tools") + 1] == ""
    assert "ANTHROPIC_API_KEY" not in capture.call_args.kwargs["env"]
    assert "--bare" not in arguments
    # No effort is named unless the request carries one; then it is the CLI's own flag.
    assert "--effort" not in arguments
    await runner.invoke(InvocationRequest(segments=["fixture"], model="claude-fixture", effort="low"))
    named = capture.call_args.args[0]
    assert named[named.index("--effort") + 1] == "low" and named[named.index("--model") + 1] == "claude-fixture"


async def test_http_boundary_auth_limits_and_sanitized_errors(token_file):
    runner = SimpleNamespace(invoke=AsyncMock(return_value=claude_runner.parse_result(result_bytes())), status=AsyncMock(return_value={"authenticated": False}))
    app = claude_runner.create_app(runner, token_file)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        assert (await client.get("/health")).status_code == 200
        assert (await client.post("/invoke", json={"prompt": "fixture"})).status_code == 401
        headers = {"Authorization": "Bearer " + read_bridge_token(token_file)}
        response = await client.post("/invoke", headers=headers, json={"prompt": "fixture", "extra": "synthetic-private-value"})
        assert response.status_code == 422 and "synthetic-private-value" not in response.text
        assert (await client.post("/invoke", headers=headers, content=b"x" * (claude_model.MAX_INPUT_BYTES * 2 + 1))).status_code == 413
        # This bridge takes the prompt as blocks. One text, both forms or an empty block are refused before the runner.
        for refused in ({"prompt": "fixture"}, {"prompt": "fixture", "segments": ["fixture"]}, {"segments": []}, {"segments": ["fixture", ""]}):
            assert (await client.post("/invoke", headers=headers, json=refused)).status_code == 422
        oversized = {"segments": ["x" * (claude_model.MAX_INPUT_BYTES // 2), "y" * (claude_model.MAX_INPUT_BYTES // 2 + 1)]}
        assert (await client.post("/invoke", headers=headers, json=oversized)).status_code == 413
        runner.invoke.assert_not_awaited()
        # An effort is one of the CLI's levels or absent: anything else never reaches a command line.
        for level in ("extreme", "high --model other", "HIGH"):
            assert (await client.post("/invoke", headers=headers, json={"segments": ["turn"], "effort": level})).status_code == 422
        runner.invoke.assert_not_awaited()
        response = await client.post("/invoke", headers=headers, json={"segments": ["header\n", "turn\n"], "effort": "xhigh"})
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        runner.invoke.assert_awaited_once()
        assert runner.invoke.await_args.args[0].segments == ["header\n", "turn\n"]
        assert runner.invoke.await_args.args[0].effort == "xhigh"


async def test_busy_status_is_unknown_not_disconnected(monkeypatch, token_file):
    original = httpx.AsyncClient
    monkeypatch.setattr(claude_model.httpx, "AsyncClient", lambda **kwargs: original(**kwargs,
        transport=httpx.MockTransport(lambda request: httpx.Response(409))))
    state = await claude_model.runner_status(SimpleNamespace(claude_cli_url=claude_model.RUNNER_URL, claude_cli_token_file=token_file))
    assert state["authenticated"] is None and state["busy"] is True


@pytest.mark.parametrize("name, arguments", [("undeclared", "{}"), ("AssistantEnvelope", "[]"), ("AssistantEnvelope", '{"content":42}')])
async def test_invalid_tool_request_cannot_escape_langchain_contract(monkeypatch, name, arguments):
    response = InvocationResponse(result=AssistantEnvelope(content="", tool_calls=[RequestedTool(name=name, arguments_json=arguments)]),
        input_tokens=1, output_tokens=1, cached_input_tokens=0)
    monkeypatch.setattr(ClaudeChatModel, "_invoke", AsyncMock(return_value=response))
    with pytest.raises(DomainError) as error:
        await ClaudeChatModel().bind_tools([AssistantEnvelope]).ainvoke("fixture")
    assert error.value.code == "CLAUDE_INVALID_TOOL_REQUEST"


async def test_runner_redirect_and_unknown_error_never_export_remote_body(monkeypatch, token_file):
    original = httpx.AsyncClient
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://foreign.example/private-value"}, content=b"private-value")

    monkeypatch.setattr(claude_model.httpx, "AsyncClient", lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler)))
    with pytest.raises(DomainError) as error:
        await ClaudeChatModel(token_file=token_file).ainvoke("fixture")
    assert error.value.code == "CLAUDE_RUNNER_FAILED"
    assert "private-value" not in str(error.value)
    assert len(requests) == 1 and requests[0].url.host == "claude-runner"


async def test_status_probe_does_not_reject_or_overlap_an_invocation(monkeypatch, tmp_path):
    tmp_path.chmod(0o700)
    runner = claude_runner.ClaudeRunner(tmp_path)
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
        return 0, result_bytes(), b""

    monkeypatch.setattr(runner, "_login_status", login_status)
    process = AsyncMock(side_effect=capture)
    monkeypatch.setattr(claude_runner, "capture_process", process)
    status_task = asyncio.create_task(runner.status())
    await status_entered.wait()
    invocation = asyncio.create_task(runner.invoke(InvocationRequest(segments=["fixture"])))
    try:
        await asyncio.sleep(0)
        assert not invocation.done(), "An admitted invocation must wait for the status probe"
        with pytest.raises(DomainError) as error:
            await runner.invoke(InvocationRequest(segments=["competing"]))
        assert error.value.code == "CLAUDE_BUSY"
        release_status.set()
        await asyncio.wait_for(inference_entered.wait(), 1)
        with pytest.raises(DomainError) as error:
            await runner.status()
        assert error.value.code == "CLAUDE_BUSY"
        with pytest.raises(DomainError) as error:
            await runner.invoke(InvocationRequest(segments=["competing"]))
        assert error.value.code == "CLAUDE_BUSY"
        release_inference.set()
        assert (await invocation).result.content == "done"
        process.assert_awaited_once()
    finally:
        release_status.set()
        release_inference.set()
        await asyncio.gather(status_task, invocation, return_exceptions=True)


@pytest.mark.parametrize("status, code", [(409, "CLAUDE_BUSY"), (503, "CLAUDE_TIMEOUT"),
    (503, "CLAUDE_PROTOCOL_INVALID"), (503, "CLAUDE_PROCESS_FAILED"), (503, "CLAUDE_LOGIN_REQUIRED"),
    (503, "CLAUDE_TURN_LIMIT"), (503, "CLAUDE_STRUCTURED_OUTPUT_MISSING"), (503, "CLAUDE_STRUCTURED_OUTPUT_INVALID"),
    (503, "CLAUDE_NATIVE_TOOL_DENIED"), (503, "CLAUDE_EXECUTION_FAILED"), (503, "CLAUDE_USAGE_INVALID")])
async def test_http_errors_preserve_only_allowlisted_runner_codes(monkeypatch, token_file, status, code):
    original = httpx.AsyncClient
    monkeypatch.setattr(claude_model.httpx, "AsyncClient", lambda **kwargs: original(**kwargs,
        transport=httpx.MockTransport(lambda request: httpx.Response(status,
            json={"code": code, "message": "synthetic-private-response", "extra": "synthetic-private-response"}))))
    with pytest.raises(DomainError) as error:
        await ClaudeChatModel(token_file=token_file).ainvoke("fixture")
    assert error.value.code == code
    assert error.value.status_code == status
    assert "synthetic-private-response" not in str(error.value)


@pytest.mark.parametrize("mode", ["cancel", "wait_timeout"])
async def test_interrupted_status_wait_does_not_start_a_model_or_leak_admission(monkeypatch, tmp_path, mode):
    tmp_path.chmod(0o700)
    runner = claude_runner.ClaudeRunner(tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()

    async def login_status():
        entered.set()
        await release.wait()
        return {"authenticated": True}

    monkeypatch.setattr(runner, "_login_status", login_status)
    capture = AsyncMock(return_value=(0, result_bytes(), b""))
    monkeypatch.setattr(claude_runner, "capture_process", capture)
    if mode == "wait_timeout":
        monkeypatch.setattr(claude_runner, "STATUS_WAIT_TIMEOUT_S", 0.01)
    status_task = asyncio.create_task(runner.status())
    await entered.wait()
    invocation = asyncio.create_task(runner.invoke(InvocationRequest(segments=["fixture"])))
    try:
        await asyncio.sleep(0)
        if mode == "cancel":
            invocation.cancel()
            with pytest.raises(asyncio.CancelledError):
                await invocation
        else:
            with pytest.raises(DomainError) as error:
                await invocation
            assert error.value.code == "CLAUDE_BUSY"
        capture.assert_not_awaited()
    finally:
        release.set()
        await asyncio.gather(status_task, invocation, return_exceptions=True)
    assert (await runner.invoke(InvocationRequest(segments=["after interruption"]))).result.content == "done"
    capture.assert_awaited_once()


def stream(*lines) -> bytes:
    """What the CLI prints in stream-json mode: one JSON value per line, the result last."""
    return b"".join(json.dumps(line).encode() + b"\n" for line in lines)


def test_the_result_is_read_from_the_last_line_of_the_stream():
    result = json.loads(result_bytes(total_cost_usd=0.0123))
    printed = stream({"type": "system", "subtype": "init", "cwd": "/tmp/sabre-claude-turn"},
                     {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "StructuredOutput", "input": {"content": "not the result"}}]}},
                     {"type": "user", "message": {"content": [{"type": "tool_result"}]}}, result)
    parsed = claude_runner.parse_result(printed)
    assert parsed.result.content == "done" and parsed.reported_cost_usd == 0.0123
    assert (parsed.input_tokens, parsed.output_tokens, parsed.cached_input_tokens, parsed.cache_creation_input_tokens) == (170, 20, 30, 40)
    # A stream that never reached its result is a failed process when it exited so, and a broken protocol otherwise.
    unfinished = stream({"type": "system", "subtype": "init"}, {"type": "assistant", "message": {"content": []}})
    for raw, exit_code, code in ((unfinished, 1, "CLAUDE_PROCESS_FAILED"), (unfinished, 0, "CLAUDE_PROTOCOL_INVALID"),
                                 (b"", 0, "CLAUDE_PROTOCOL_INVALID"), (printed + b"not json\n", 0, "CLAUDE_PROTOCOL_INVALID")):
        with pytest.raises(DomainError) as error:
            claude_runner.parse_result(raw, exit_code=exit_code)
        assert error.value.code == code
    # What the provider refused still arrives as a result, in the stream as in a single document.
    with pytest.raises(DomainError) as limited:
        claude_runner.parse_result(stream({"type": "system", "subtype": "init"}, {**result, "is_error": True, "api_error_status": 429}), exit_code=1)
    assert limited.value.code == "CLAUDE_RATE_LIMITED"


def test_the_working_directory_of_a_call_is_one_empty_path_that_does_not_outlive_it(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_runner, "TURN_DIRECTORY", tmp_path / "turn")
    for _ in range(2):
        with claude_runner.turn_directory() as directory:
            assert directory == str(tmp_path / "turn") and list((tmp_path / "turn").iterdir()) == []
            (tmp_path / "turn" / "left-behind").write_text("synthetic")
        assert not (tmp_path / "turn").exists()
    # Something left at that path by an interrupted call is removed before the next one starts.
    (tmp_path / "turn").mkdir()
    (tmp_path / "turn" / "stale").write_text("synthetic")
    with claude_runner.turn_directory() as directory:
        assert list((tmp_path / "turn").iterdir()) == []
