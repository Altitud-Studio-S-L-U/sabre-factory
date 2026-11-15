"""Pinned Claude executable against a local synthetic provider, never an account."""

import hashlib
import json
import os
import platform
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from sabre.claude_runner import (
    BINARY,
    STREAM_OUTPUT_BYTES,
    ClaudeRunner,
    capture_process,
    cli_arguments,
    cli_input,
    parse_result,
    turn_directory,
)
from sabre.cli_protocol import serialize_segments
from sabre.codex_model import AssistantEnvelope
from sabre.models import DomainError

PINNED_BINARY_SHA256 = {"x86_64": "fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824", "aarch64": "55cdb8e162d190432696ea54010e0fca2e18d06fa7a7127fd563b9ffd4f22624"}[platform.machine()]


async def test_native_identity_empty_auth_and_outer_boundary(tmp_path):
    assert os.getuid() == 10001
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    assert int(status["CapEff"].strip(), 16) == 0
    assert status["NoNewPrivs"].strip() == "1"
    assert os.statvfs("/").f_flag & os.ST_RDONLY
    with Path(BINARY).open("rb") as binary:
        assert hashlib.file_digest(binary, "sha256").hexdigest() == PINNED_BINARY_SHA256
    tmp_path.chmod(0o700)
    runner = ClaudeRunner(tmp_path)
    code, output, _ = await capture_process([BINARY, "--version"], env=runner.environment(), cwd=str(tmp_path), timeout=15)
    assert code == 0 and output.strip() == b"2.1.316 (Claude Code)"
    state = await runner.status()
    assert state == {"authenticated": False, "provider": "claude_cli", "usage_kind": "cli_invocation"}
    oracle = tmp_path / "read-oracle"
    oracle.write_text("synthetic")
    os.utime(oracle, (1, 1))
    oracle.read_bytes()
    assert oracle.stat().st_atime_ns != 1_000_000_000, "The filesystem must observe the canary read oracle"


# The model the factory selects by default, and one for which the pinned CLI lays the request out the older way.
DEFAULT_MODEL = "claude-opus-5-5"
MODELS = [DEFAULT_MODEL, "claude-sonnet-4-6"]
ATTACKS = ["StructuredOutput", "text_then_structured", "invalid_then_structured", "invalid_schema", "prose", "Bash", "Read", "Write", "Agent",
           "WebFetch", "mcp__synthetic__read", "DeferredToolPlaceholder"]


def offered_tools(request) -> list[str]:
    """The tools a request offers the model, leaving out the CLI's inert placeholder after checking that it is one."""
    names = []
    for tool in request.get("tools", []):
        if tool.get("name") == "DeferredToolPlaceholder":
            # For some models the CLI sends this to keep its deferred loading on. It takes no input and loads nothing here.
            assert tool.get("defer_loading") is True and tool["input_schema"].get("properties") == {}
            continue
        names.append(tool.get("name"))
    return names


@pytest.mark.parametrize("model", MODELS)
@pytest.mark.parametrize("attack", ATTACKS)
async def test_no_native_tools_or_customizations_run(tmp_path, attack, model):
    home = tmp_path / "home"
    home.mkdir(mode=0o700)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    marker = home / "executed"
    canary = home / "private-fixture"
    canary.write_text("SYNTHETIC_CLAUDE_PRIVATE_CANARY")
    os.utime(canary, (1, 1))
    # Only synthetic public configuration is seeded; there are no login files.
    hook = {"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": f"touch {marker}"}]}]}}
    (home / "settings.json").write_text(json.dumps(hook))
    (workspace / ".claude").mkdir()
    (workspace / ".claude" / "settings.json").write_text(json.dumps(hook))
    (workspace / "CLAUDE.md").write_text("SYNTHETIC_CUSTOMIZATION_MUST_NOT_LOAD")
    (workspace / ".mcp.json").write_text(json.dumps({"mcpServers": {"synthetic": {"command": "touch", "args": [str(marker)]}}}))
    requests = []
    failures = []
    envelope = AssistantEnvelope(content="synthetic completed", tool_calls=[]).model_dump()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_GET(self):
            marker.touch()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"synthetic")

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                selected = attack
                if attack in {"text_then_structured", "invalid_then_structured"}:
                    selected = ("prose" if attack == "text_then_structured" else "invalid_schema") if len(requests) == 1 else "StructuredOutput"
                tool_input = {
                    "StructuredOutput": envelope, "invalid_schema": {"content": 42, "tool_calls": []},
                    "Bash": {"command": f"touch {marker}"}, "Read": {"file_path": str(canary)},
                    "Write": {"file_path": str(canary), "content": "changed"},
                    "Agent": {"description": "Synthetic fixture", "prompt": f"Read {canary}", "subagent_type": "general-purpose"},
                    "WebFetch": {"url": f"http://127.0.0.1:{server.server_port}/canary", "prompt": "Read synthetic data"},
                }.get(selected, {})
                injected = selected != "prose"
                name = "StructuredOutput" if selected == "invalid_schema" else selected
                block = {"type": "tool_use", "id": f"toolu_synthetic_{len(requests)}", "name": name, "input": {}} if injected else {"type": "text", "text": ""}
                delta = {"type": "input_json_delta", "partial_json": json.dumps(tool_input)} if injected else {"type": "text_delta", "text": json.dumps(envelope)}
                usage = {"input_tokens": 100, "output_tokens": 0, "cache_creation_input_tokens": 20, "cache_read_input_tokens": 30}
                message = {"id": "msg_synthetic", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": usage}
                events = [("message_start", {"type": "message_start", "message": message}),
                    ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": block}),
                    ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta}),
                    ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                    ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use" if injected else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 15}}),
                    ("message_stop", {"type": "message_stop"})]
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for name, event in events:
                    self.wfile.write(f"event: {name}\ndata: {json.dumps(event)}\n\n".encode())
            except Exception as error:
                failures.append(type(error).__name__)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    environment = ClaudeRunner(home).environment()
    environment.update({"ANTHROPIC_API_KEY": "synthetic-not-a-credential", "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}"})
    try:
        code, stdout, stderr = await capture_process([*cli_arguments(), "--model", model], env=environment,
            cwd=str(workspace), stdin=cli_input(["Return the synthetic envelope"]), timeout=45)
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
    assert not failures
    assert requests, {"exit_code": code, "stderr": stderr.decode(errors="replace")[:2000], "stdout": stdout.decode(errors="replace")[:2000]}
    assert len(requests) == (1 if attack == "StructuredOutput" else 2)
    assert all(offered_tools(request) == ["StructuredOutput"] for request in requests)
    # What the CLI itself reports as its tools has no placeholder in it.
    started = [json.loads(line) for line in stdout.splitlines() if line.strip().startswith(b"{")]
    assert [line.get("tools") for line in started if line.get("subtype") == "init"] == [["StructuredOutput"]]
    wire = json.dumps(requests)
    assert "SYNTHETIC_CLAUDE_PRIVATE_CANARY" not in wire
    assert "SYNTHETIC_CUSTOMIZATION_MUST_NOT_LOAD" not in wire
    assert not marker.exists()
    assert canary.stat().st_atime_ns == 1_000_000_000, "Native tools must not read the private canary"
    assert canary.read_text() == "SYNTHETIC_CLAUDE_PRIVATE_CANARY"
    assert b"SYNTHETIC_CLAUDE_PRIVATE_CANARY" not in stdout
    if attack in {"StructuredOutput", "text_then_structured", "invalid_then_structured"}:
        assert code == 0
        assert json.loads(stdout.splitlines()[-1]).get("permission_denials") == []
        result = parse_result(stdout, exit_code=code)
        assert result.result.content == "synthetic completed"
        assert result.input_tokens == 150 * len(requests) and result.output_tokens == 15 * len(requests)
        assert result.cached_input_tokens == 30 * len(requests) and result.cache_creation_input_tokens == 20 * len(requests)
        if attack == "invalid_then_structured":
            results = [block for message in requests[1]["messages"] if isinstance(message.get("content"), list)
                for block in message["content"] if block.get("type") == "tool_result"]
            assert any(block.get("is_error") is True for block in results)
    else:
        with pytest.raises(DomainError):
            parse_result(stdout, exit_code=code)


def synthetic_provider(requests):
    """A local stand-in for the provider that records each request and answers with the structured envelope."""
    envelope = AssistantEnvelope(content="synthetic completed", tool_calls=[]).model_dump()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"synthetic")

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            usage = {"input_tokens": 100, "output_tokens": 0, "cache_creation_input_tokens": 20, "cache_read_input_tokens": 30}
            message = {"id": "msg_synthetic", "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": [], "stop_reason": None, "stop_sequence": None, "usage": usage}
            block = {"type": "tool_use", "id": f"toolu_synthetic_{len(requests)}", "name": "StructuredOutput", "input": {}}
            events = [("message_start", {"type": "message_start", "message": message}),
                ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": block}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(envelope)}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 15}}),
                ("message_stop", {"type": "message_stop"})]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for name, event in events:
                self.wfile.write(f"event: {name}\ndata: {json.dumps(event)}\n\n".encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def fixture_conversation(turns: int):
    messages = [SystemMessage(content="You are the analyst of a synthetic project. " * 40), HumanMessage(content='{"objective":"Audit the synthetic package"}')]
    for turn in range(turns):
        calls = [{"name": "read_file", "args": {"path": f"module_{turn}_{index}.py"}, "id": f"call-{turn}-{index}", "type": "tool_call"} for index in range(3)]
        messages.append(AIMessage(content="", tool_calls=calls))
        messages += [ToolMessage(content=f"def function_{turn}_{index}():\n    return {index}\n" * 20, tool_call_id=call["id"]) for index, call in enumerate(calls)]
    return messages


def cache_points(request) -> list[tuple]:
    """Where a request carries a cache point: (part, block index), in the order the provider renders them."""
    points = [("system", index) for index, block in enumerate(request["system"]) if block.get("cache_control")]
    for number, message in enumerate(request["messages"]):
        content = message["content"] if isinstance(message["content"], list) else []
        points += [(f"message {number}", index) for index, block in enumerate(content) if block.get("cache_control")]
    return points


@pytest.mark.parametrize("model", MODELS)
async def test_a_conversation_that_grew_reaches_the_provider_as_the_same_blocks_and_one_more(tmp_path, model):
    """What the provider's cache needs, shown on the request the pinned CLI builds. No provider is asked whether it hit."""
    tools = [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}]

    async def call(name, segments, directory=None):
        # Each call is a new process with a new, empty login directory, as nothing is kept between calls.
        home = tmp_path / f"home-{name}"
        home.mkdir(mode=0o700)
        requests = []
        server, thread = synthetic_provider(requests)
        environment = ClaudeRunner(home).environment()
        environment.update({"ANTHROPIC_API_KEY": "synthetic-not-a-credential", "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}"})
        try:
            if directory is None:
                with turn_directory() as fixed:
                    code, stdout, _ = await capture_process([*cli_arguments(), "--model", model], env=environment, cwd=fixed,
                        stdin=cli_input(segments), timeout=45, maximum_output=STREAM_OUTPUT_BYTES)
            else:
                directory.mkdir()
                code, stdout, _ = await capture_process([*cli_arguments(), "--model", model], env=environment, cwd=str(directory),
                    stdin=cli_input(segments), timeout=45, maximum_output=STREAM_OUTPUT_BYTES)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        assert code == 0 and len(requests) == 1
        assert parse_result(stdout, exit_code=code).result.content == "synthetic completed"
        return requests[0]

    def blocks(request):
        # The factory's prompt is the first message, a user message. Some models get a message of the CLI's after it.
        assert request["messages"][0]["role"] == "user"
        return request["messages"][0]["content"]

    def bare(value):
        if isinstance(value, list):
            return [bare(item) for item in value]
        return {key: bare(item) for key, item in value.items() if key != "cache_control"} if isinstance(value, dict) else value

    earlier, later = serialize_segments(fixture_conversation(2), tools, "auto"), serialize_segments(fixture_conversation(3), tools, "auto")
    first, second = await call("first", earlier), await call("second", later)
    # The CLI sends the factory's blocks as they are, in order, after any it writes itself in the same message.
    own = len(blocks(first)) - len(earlier)
    assert own >= 0 and [block["text"] for block in blocks(first)[own:]] == earlier
    assert [block["text"] for block in blocks(second)[own:]] == later
    # Everything the first call sent before its last cache point is the beginning of what the second sends.
    assert json.dumps(first["system"]) == json.dumps(second["system"]) and first.get("tools") == second.get("tools")
    assert bare(blocks(second)[:len(blocks(first))]) == bare(blocks(first)) and len(blocks(second)) == len(blocks(first)) + 1
    # What the CLI adds after the prompt, where it adds anything, is the same on both calls.
    assert bare(first["messages"][1:]) == bare(second["messages"][1:])
    for request in (first, second):
        points = cache_points(request)
        # The conversation ends at a cache point for every model: the factory's own, on its last block.
        assert ("message 0", len(blocks(request)) - 1) in points
        assert [point for point in points if point[0] == "message 0"] == [("message 0", len(blocks(request)) - 1)]
        # The provider takes four cache points in a request; with the CLI's own this is at most four.
        assert len(points) <= 4
    # So the second call can be read back up to where the first one's conversation ended: that block is a
    # cache point of the first request and a block of the second, with identical content before it.
    assert ("message 0", len(blocks(first)) - 1) in cache_points(first)
    # Why the directory is fixed: the CLI names it in what it writes itself, and another path changes that.
    elsewhere = await call("elsewhere", earlier, directory=tmp_path / "another-directory")
    assert bare(elsewhere["messages"]) != bare(first["messages"]) or json.dumps(elsewhere["system"]) != json.dumps(first["system"])
    assert [block["text"] for block in blocks(elsewhere)[own:]] == earlier


async def test_without_the_factorys_own_cache_point_the_default_model_would_never_read_the_conversation_back(tmp_path):
    """The reason the factory marks its last block: for the default model the CLI's own cache point comes after the prompt."""
    home = tmp_path / "home"
    home.mkdir(mode=0o700)
    requests = []
    server, thread = synthetic_provider(requests)
    environment = ClaudeRunner(home).environment()
    environment.update({"ANTHROPIC_API_KEY": "synthetic-not-a-credential", "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}"})
    unmarked = json.loads(cli_input(["header\n", "turn\n"]))
    unmarked["message"]["content"][-1].pop("cache_control")
    try:
        with turn_directory() as directory:
            code, _, _ = await capture_process([*cli_arguments(), "--model", DEFAULT_MODEL], env=environment, cwd=directory,
                stdin=(json.dumps(unmarked) + "\n").encode(), timeout=45, maximum_output=STREAM_OUTPUT_BYTES)
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
    assert code == 0 and len(requests) == 1
    request = requests[0]
    # The CLI adds a message about the environment after the prompt and puts its cache point there, not on the prompt.
    assert [message["role"] for message in request["messages"]] == ["user", "system"]
    assert not any(part == "message 0" for part, _ in cache_points(request))
    assert ("message 1", len(request["messages"][1]["content"]) - 1) in cache_points(request)


@pytest.mark.parametrize("model,effort,sent", [
    # The factory's default model takes every level; without one this CLI asks for medium.
    (DEFAULT_MODEL, None, "medium"), (DEFAULT_MODEL, "low", "low"), (DEFAULT_MODEL, "medium", "medium"),
    (DEFAULT_MODEL, "high", "high"), (DEFAULT_MODEL, "xhigh", "xhigh"), (DEFAULT_MODEL, "max", "max"),
    # The CLI decides by model: another default, and a level this model does not have is lowered to one it has.
    ("claude-sonnet-4-6", None, "high"), ("claude-sonnet-4-6", "xhigh", "high"),
    # A model without the setting is asked for none, whatever the factory names.
    ("claude-haiku-4-5", None, None), ("claude-haiku-4-5", "high", None),
])
async def test_the_effort_given_to_the_cli_is_what_the_provider_is_asked_for_where_the_model_takes_it(tmp_path, model, effort, sent):
    """The factory's setting reaches the request as the CLI's own flag, and the rest of the request stays as it was."""

    async def call(name, level):
        home = tmp_path / f"home-{name}"
        home.mkdir(mode=0o700)
        requests = []
        server, thread = synthetic_provider(requests)
        environment = ClaudeRunner(home).environment()
        environment.update({"ANTHROPIC_API_KEY": "synthetic-not-a-credential", "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}"})
        arguments = [*cli_arguments(), "--model", model, *(["--effort", level] if level else [])]
        try:
            with turn_directory() as directory:
                code, stdout, _ = await capture_process(arguments, env=environment, cwd=directory, stdin=cli_input(["Return the synthetic envelope\n"]),
                    timeout=45, maximum_output=STREAM_OUTPUT_BYTES)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        assert code == 0 and len(requests) == 1
        assert parse_result(stdout, exit_code=code).result.content == "synthetic completed"
        return requests[0]

    def unlevelled(value):
        if isinstance(value, list):
            return [unlevelled(item) for item in value]
        return {key: unlevelled(item) for key, item in value.items() if key != "output_config"} if isinstance(value, dict) else value

    asked = await call("asked", effort)
    assert asked["model"] == model and asked.get("output_config") == ({"effort": sent} if sent else None)
    assert offered_tools(asked) == ["StructuredOutput"]
    # Where the CLI repeats the level on the message it adds after the prompt, it is the same level.
    assert all(message.get("output_config", {"effort": sent}) == {"effort": sent} for message in asked["messages"])
    if effort:
        # The level is the only thing that moves: the same system, tools, prompt and text after it.
        # Whether the provider keeps what it cached for a conversation across a change of level was not observed.
        plain = await call("plain", None)
        for part in ("system", "tools", "messages", "max_tokens", "thinking"):
            assert unlevelled(asked.get(part)) == unlevelled(plain.get(part)), part
