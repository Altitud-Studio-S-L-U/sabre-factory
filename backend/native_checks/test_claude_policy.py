"""Pinned Claude executable against a local synthetic provider, never an account."""

import hashlib
import json
import os
import platform
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from sabre.claude_runner import BINARY, ClaudeRunner, capture_process, cli_arguments, parse_result
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


@pytest.mark.parametrize("attack", ["StructuredOutput", "text_then_structured", "invalid_then_structured", "invalid_schema", "prose", "Bash", "Read", "Write", "Agent", "WebFetch", "mcp__synthetic__read"])
async def test_no_native_tools_or_customizations_run(tmp_path, attack):
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
                message = {"id": "msg_synthetic", "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": [], "stop_reason": None, "stop_sequence": None, "usage": usage}
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
        code, stdout, stderr = await capture_process([*cli_arguments(), "--model", "claude-sonnet-4-6"], env=environment,
            cwd=str(workspace), stdin=b"Return the synthetic envelope", timeout=45)
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
    assert not failures
    assert requests, {"exit_code": code, "stderr": stderr.decode(errors="replace")[:2000], "stdout": stdout.decode(errors="replace")[:2000]}
    assert len(requests) == (1 if attack == "StructuredOutput" else 2)
    assert all([tool.get("name") for tool in request.get("tools", [])] == ["StructuredOutput"] for request in requests)
    wire = json.dumps(requests)
    assert "SYNTHETIC_CLAUDE_PRIVATE_CANARY" not in wire
    assert "SYNTHETIC_CUSTOMIZATION_MUST_NOT_LOAD" not in wire
    assert not marker.exists()
    assert canary.stat().st_atime_ns == 1_000_000_000, "Native tools must not read the private canary"
    assert canary.read_text() == "SYNTHETIC_CLAUDE_PRIVATE_CANARY"
    assert b"SYNTHETIC_CLAUDE_PRIVATE_CANARY" not in stdout
    if attack in {"StructuredOutput", "text_then_structured", "invalid_then_structured"}:
        assert code == 0
        assert json.loads(stdout).get("permission_denials") == []
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
