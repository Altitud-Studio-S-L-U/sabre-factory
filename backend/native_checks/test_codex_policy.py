"""Mandatory native suite: pinned CLI, offline, without authentication mounts."""

import base64
import hashlib
import json
import os
import platform
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from sabre.cli_protocol import serialize_turn
from sabre.codex_model import AssistantEnvelope
from sabre.codex_runner import (
    BINARY,
    SCHEMA_FILE,
    capture_process,
    cli_arguments,
    parse_events,
    turn_arguments,
    turn_directory,
)
from sabre.models import DomainError

PINNED_BINARY_SHA256 = {"x86_64": "b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306", "aarch64": "8813c8d8a4cea2eeba271b72ab22f49628b184b24ab18dbef06b4ce41e9a8d39"}[platform.machine()]


async def test_outer_privileges_stay_disabled_and_seccomp_rejects_other_operations(tmp_path):
    assert os.getuid() == 10001
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    assert int(status["CapEff"].strip(), 16) == 0
    assert status["NoNewPrivs"].strip() == "1"
    assert os.statvfs("/").f_flag & os.ST_RDONLY
    expected_apparmor = os.environ.get("SABRE_EXPECT_APPARMOR_PROFILE", "")
    (tmp_path / "allowed").mkdir()
    (tmp_path / "forbidden").mkdir()
    # A positive mount inside the exact permitted user namespace distinguishes
    # seccomp rejection from lacking CAP_SYS_ADMIN in the outer container.
    program = r'''
import ctypes,errno,json,os,pathlib,platform,sys
libc=ctypes.CDLL(None,use_errno=True)
libc.mount.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_ulong,ctypes.c_void_p]
libc.mount.restype=ctypes.c_int
clone_syscall={"x86_64":56,"aarch64":220}[platform.machine()]
flags=2013397009
uid,gid=os.getuid(),os.getgid()
variant=libc.syscall(clone_syscall,ctypes.c_ulong(flags|0x04000000),0,0,0,0)
variant_errno=ctypes.get_errno()
if variant==0: os._exit(0)
if variant>0: os.waitpid(variant,0)
read_fd,write_fd=os.pipe()
child=libc.syscall(clone_syscall,ctypes.c_ulong(flags),0,0,0,0)
if child<0: raise RuntimeError('The exact namespace combination was rejected')
if child==0:
 os.close(read_fd)
 try:
  pathlib.Path('/proc/self/setgroups').write_text('deny')
  pathlib.Path('/proc/self/uid_map').write_text(f'0 {uid} 1\n')
  pathlib.Path('/proc/self/gid_map').write_text(f'0 {gid} 1\n')
  allowed=os.fsencode(sys.argv[1]+'/allowed')
  forbidden=os.fsencode(sys.argv[1]+'/forbidden')
  def mount(source,target,kind,options):
   ctypes.set_errno(0)
   result=libc.mount(source,target,kind,options,None)
   return {'result':result,'errno':ctypes.get_errno()}
  report={'positive':mount(b'tmpfs',allowed,b'tmpfs',6),
   'generic':mount(b'tmpfs',forbidden,b'tmpfs',0),
   'rw_remount':mount(None,allowed,None,36902)}
  if sys.argv[2]: report['apparmor_destination']=mount(b'tmpfs',forbidden,b'tmpfs',6)
 except Exception as error: report={'error':str(error)}
 os.write(write_fd,json.dumps(report).encode());os.close(write_fd);os._exit(0)
os.close(write_fd)
report=json.loads(os.read(read_fd,4096));os.close(read_fd);os.waitpid(child,0)
report['other_namespace']={'result':variant,'errno':variant_errno}
print(json.dumps(report))
'''
    code, raw, _ = await capture_process([sys.executable, "-c", program, str(tmp_path), expected_apparmor], env={"PATH": "/usr/bin"}, cwd=str(tmp_path), timeout=10)
    assert code == 0
    result = json.loads(raw)
    assert "error" not in result
    try:
        with Path("/proc/self/attr/current").open(encoding="utf-8", errors="replace") as profile:
            security_context = profile.read(256).strip()
    except OSError as error:
        security_context = f"unavailable(errno={error.errno})"
    assert result["positive"]["result"] == 0, {"syscalls": result, "security_context": security_context}
    if expected_apparmor:
        assert security_context == f"{expected_apparmor} (enforce)"
        assert result["apparmor_destination"] == {"result": -1, "errno": 13}
    for operation in ("generic", "rw_remount", "other_namespace"):
        assert result[operation] == {"result": -1, "errno": 1}


# The pinned CLI lays a request out by model, and offers the model different native tools in each layout.
# One model of each: a code tool that composes nested tools, and a patch tool the model calls directly.
CODE_TOOL_MODEL = "gpt-6.1-sol"
DIRECT_TOOL_MODEL = "gpt-5.5"
MODELS = [CODE_TOOL_MODEL, DIRECT_TOOL_MODEL]


def final_message() -> dict:
    text = AssistantEnvelope(content="synthetic completed", tool_calls=[]).model_dump_json()
    return {"type": "message", "id": "msg_synthetic", "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}]}


def synthetic_provider(requests: list, answer=None):
    """A local stand-in for the provider. ``answer(number)`` gives the output item of that request; by default the final message."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            number = len(requests)
            item = answer(number) if answer else final_message()
            base = {"id": f"resp_synthetic_{number}", "object": "response"}
            events = [
                ("response.created", {"type": "response.created", "response": {**base, "status": "in_progress", "output": []}}),
                ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}}),
            ]
            if item["type"] == "message":
                events.append(("response.output_text.delta", {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0,
                                                              "delta": item["content"][0]["text"]}))
            usage = {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120, "input_tokens_details": {"cached_tokens": 0},
                     "output_tokens_details": {"reasoning_tokens": 0}}
            events.extend([
                ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
                ("response.completed", {"type": "response.completed", "response": {**base, "status": "completed", "output": [item], "usage": usage}}),
            ])
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for event, data in events:
                self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def provider_arguments(server) -> list[str]:
    """Configuration that points the CLI at the local stand-in instead of its provider."""
    overrides = {
        "model_provider": "sabredouble", "model_providers.sabredouble.name": "Synthetic offline test",
        "model_providers.sabredouble.base_url": f"http://127.0.0.1:{server.server_port}/v1",
        "model_providers.sabredouble.wire_api": "responses", "model_providers.sabredouble.env_key": "SABRE_SYNTHETIC_KEY",
        "model_providers.sabredouble.requires_openai_auth": False,
    }
    return [argument for key, value in overrides.items() for argument in ("-c", f"{key}={json.dumps(value)}")]


def environment(home: Path) -> dict[str, str]:
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home), "CODEX_HOME": str(home), "SABRE_SYNTHETIC_KEY": "synthetic-not-a-credential"}


def offered_tools(request) -> set[str]:
    """Every native tool a request offers the model, wherever the CLI lists it."""
    listed = list(request.get("tools", []))
    listed += [tool for item in request["input"] if item.get("type") == "additional_tools" for tool in item.get("tools", [])]
    names = set()
    for tool in listed:
        nested = tool.get("tools") if tool.get("type") == "namespace" else [tool]
        names.update(entry.get("name") for entry in nested)
    return names


class Fixture:
    """Private material the CLI must not read or change, public material it may read, and a canary for each."""

    def __init__(self, tmp_path: Path):
        self.home, self.workspace, self.bridge = tmp_path / "private", tmp_path / "workspace", tmp_path / "bridge"
        self.home.mkdir(mode=0o700)
        self.workspace.mkdir()
        self.bridge.mkdir(mode=0o700)
        self.bridge_token = self.bridge / "token"
        self.bridge_token.write_text("SYNTHETIC_PRIVATE_BRIDGE_CANARY\n")
        # A user configuration must not relax the fixed policy or replace the provider.
        (self.home / "config.toml").write_text("THIS IS DELIBERATELY INVALID USER CONFIG")
        self.canary = self.home / "canary.png"
        self.canary.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"))
        self.marker = self.home / "modified"
        self.private_text = self.home / "credential-fixture.txt"
        self.private_text.write_text("SYNTHETIC_PRIVATE_MATERIAL_CANARY\n")
        self.public_text = self.workspace / "public-fixture.txt"
        self.public_text.write_text("SYNTHETIC_PUBLIC_MATERIAL\n")
        self.created = self.workspace / "created-by-the-model.txt"
        self.schema = self.workspace / "schema.json"
        self.schema.write_text(json.dumps(AssistantEnvelope.model_json_schema()))

    def patches(self) -> dict[str, str]:
        def update(target):
            return f"*** Begin Patch\n*** Update File: {target}\n@@\n-NONMATCHING\n+CHANGED\n*** End Patch"
        def add(target):
            return f"*** Begin Patch\n*** Add File: {target}\n+CHANGED\n*** End Patch"
        # The workspace may be read, and nothing may be written: not there either.
        return {"patch": add(self.marker), "workspace_write": add(self.created), "patch_read": update(self.private_text),
                "bridge_read": update(self.bridge_token), "public_read_control": update(self.public_text)}

    async def run(self, model: str, answer):
        """One call of the pinned CLI in the public workspace, with the model's output scripted by ``answer``."""
        requests: list = []
        server, thread = synthetic_provider(requests, answer)
        args = [*cli_arguments(home=self.home, workspace=self.workspace, secrets_dir=self.bridge), *provider_arguments(server),
                "--json", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "-C", str(self.workspace),
                "-m", model, "--output-schema", str(self.schema), "-"]
        try:
            code, stdout, _ = await capture_process(args, env=environment(self.home), cwd=str(self.workspace),
                                                    stdin=b"Return a synthetic fixture result", timeout=30)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        return code, stdout, requests

    def untouched(self, requests):
        assert not self.marker.exists() and not self.created.exists()
        assert self.private_text.read_text() == "SYNTHETIC_PRIVATE_MATERIAL_CANARY\n"
        assert "SYNTHETIC_PRIVATE_MATERIAL_CANARY" not in json.dumps(requests)
        assert self.bridge_token.read_text() == "SYNTHETIC_PRIVATE_BRIDGE_CANARY\n"
        assert "SYNTHETIC_PRIVATE_BRIDGE_CANARY" not in json.dumps(requests)
        assert self.public_text.read_text() == "SYNTHETIC_PUBLIC_MATERIAL\n"
        assert all("data:image/" not in json.dumps(request.get("input")) for request in requests)


@pytest.mark.parametrize("attack", ["image", "shell", "patch", "workspace_write", "patch_read", "bridge_read", "public_read_control"])
async def test_pinned_cli_cannot_read_or_write_synthetic_private_files(tmp_path, attack):
    assert hashlib.sha256(Path(BINARY).read_bytes()).hexdigest() == PINNED_BINARY_SHA256
    fixture = Fixture(tmp_path)
    target = json.dumps(str(fixture.canary))
    attacks = {
        "image": f"const result = await tools.view_image({{path:{target}}}); image(result.image_url);",
        "shell": f"text({{process:typeof process,require:typeof require,fetch:typeof fetch,read:typeof tools.read_file,shell:typeof tools.exec_command}}); const result=await tools.exec_command({{cmd:'cat '+{target}}}); text(result);",
        **{name: "const result=await tools.apply_patch(" + json.dumps(patch) + ");text(result);" for name, patch in fixture.patches().items()},
    }

    def answer(number):
        # The model first runs code through the CLI's code tool, then gives its result.
        return {"type": "custom_tool_call", "id": "ctc_synthetic", "call_id": "call_synthetic", "name": "exec", "input": attacks[attack],
                "status": "completed"} if number == 1 else final_message()

    code, stdout, requests = await fixture.run(CODE_TOOL_MODEL, answer)
    assert code == 0
    assert len(requests) == 2
    # The layout this test is about: a code tool, and no tool at the top of the request.
    assert "exec" in offered_tools(requests[0]) and not requests[0].get("tools")
    result = parse_events(stdout)
    assert result.input_tokens == 200 and result.output_tokens == 40
    assert result.usage_kind == "cli_invocation"
    fixture.untouched(requests)
    outputs = json.dumps([item for request in requests for item in request.get("input", []) if item.get("type") == "custom_tool_call_output"])
    assert "fs sandbox helper failed" not in outputs
    if attack == "image":
        assert "tools.view_image is not a function" in outputs
    elif attack == "shell":
        assert "tools.exec_command is not a function" in outputs
        for capability in ("process", "require", "fetch", "read", "shell"):
            assert f'\\"{capability}\\":\\"undefined\\"' in outputs
    elif attack in {"patch", "workspace_write"}:
        assert "write approval" in outputs or "writing outside" in outputs or "read-only" in outputs
    elif attack in {"patch_read", "bridge_read"}:
        assert "Failed to read file" in outputs
        assert "Failed to find expected lines" not in outputs
    else:
        assert "Failed to find expected lines" in outputs


@pytest.mark.parametrize("attack", ["patch", "workspace_write", "patch_read", "bridge_read", "public_read_control", "function_patch", "shell", "local_shell"])
async def test_pinned_cli_refuses_the_native_tools_it_offers_a_model_directly(tmp_path, attack):
    """The other layout: the CLI offers the patch tool itself, with no code tool around it."""
    fixture = Fixture(tmp_path)
    call = {"id": "call_item_synthetic", "call_id": "call_synthetic", "status": "completed"}
    attacks = {
        **{name: {**call, "type": "custom_tool_call", "name": "apply_patch", "input": patch} for name, patch in fixture.patches().items()},
        # The same patch through the other calling convention, and two tools this policy does not offer.
        "function_patch": {**call, "type": "function_call", "name": "apply_patch", "arguments": json.dumps({"input": fixture.patches()["patch"]})},
        "shell": {**call, "type": "function_call", "name": "shell", "arguments": json.dumps({"command": ["cat", str(fixture.private_text)]})},
        "local_shell": {**call, "type": "local_shell_call", "action": {"type": "exec", "command": ["cat", str(fixture.private_text)]}},
    }
    code, stdout, requests = await fixture.run(DIRECT_TOOL_MODEL, lambda number: attacks[attack] if number == 1 else final_message())
    assert code == 0
    # The layout this test is about: the patch tool at the top of the request, and neither a shell nor a code tool anywhere.
    assert offered_tools(requests[0]) == {"request_user_input", "apply_patch"}
    assert not [item for item in requests[0]["input"] if item.get("type") == "additional_tools"]
    fixture.untouched(requests)
    if attack == "local_shell":
        # The CLI drops a call it has no tool for and ends the turn with nothing: the bridge reports a failed call, not an answer.
        assert len(requests) == 1
        with pytest.raises(DomainError) as failed:
            parse_events(stdout)
        assert failed.value.code == "CODEX_PROTOCOL_INVALID"
        return
    assert len(requests) == 2
    result = parse_events(stdout)
    assert result.input_tokens == 200 and result.output_tokens == 40
    outputs = json.dumps([item for item in requests[1]["input"] if item.get("type") in {"custom_tool_call_output", "function_call_output"}])
    assert "fs sandbox helper failed" not in outputs
    if attack in {"patch", "workspace_write"}:
        assert "write approval" in outputs or "writing outside" in outputs or "read-only" in outputs
    elif attack in {"patch_read", "bridge_read"}:
        assert "Failed to read file" in outputs
        assert "Failed to find expected lines" not in outputs
    elif attack == "public_read_control":
        # Where reading is allowed the tool does read, so the refusals above are the policy and not a broken tool.
        assert "Failed to find expected lines" in outputs
    elif attack == "function_patch":
        assert '"output": "aborted"' in outputs
    else:
        assert "unsupported call: shell" in outputs


def fixture_conversation(turns: int):
    messages = [SystemMessage(content="You are the analyst of a synthetic project. " * 40), HumanMessage(content='{"objective":"Audit the synthetic package"}')]
    for turn in range(turns):
        calls = [{"name": "read_file", "args": {"path": f"module_{turn}_{index}.py"}, "id": f"call-{turn}-{index}", "type": "tool_call"} for index in range(3)]
        messages.append(AIMessage(content="", tool_calls=calls))
        messages += [ToolMessage(content=f"def function_{turn}_{index}():\n    return {index}\n" * 20, tool_call_id=call["id"]) for index, call in enumerate(calls)]
    return messages


@pytest.mark.parametrize("model", MODELS)
async def test_a_conversation_that_grew_reaches_the_provider_with_the_same_beginning(tmp_path, model):
    """What a provider that caches a shared beginning needs, shown on the request the pinned CLI builds. No provider is asked whether it hit."""
    home, bridge = tmp_path / "private", tmp_path / "bridge"
    home.mkdir(mode=0o700)
    bridge.mkdir(mode=0o700)
    tools = [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}]

    async def call(prompt, directory=None):
        # Each call is a new process, as nothing is kept between calls.
        requests: list = []
        server, thread = synthetic_provider(requests)

        async def run(where: str):
            # The command line the bridge builds for a call, with the provider replaced by the local stand-in.
            (Path(where) / SCHEMA_FILE).write_text(json.dumps(AssistantEnvelope.model_json_schema()))
            args = [*turn_arguments(where, home=home, model=model, secrets_dir=bridge), *provider_arguments(server), "-"]
            return await capture_process(args, env=environment(home), cwd=where, stdin=prompt.encode(), timeout=30)

        try:
            if directory is None:
                with turn_directory() as fixed:
                    code, stdout, _ = await run(fixed)
            else:
                directory.mkdir()
                code, stdout, _ = await run(str(directory))
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        assert code == 0 and len(requests) == 1
        assert parse_events(stdout).result.content == "synthetic completed"
        return requests[0]

    def prompt_of(request):
        # The factory's prompt is the last item the CLI sends, a user message of one text.
        last = request["input"][-1]
        assert last["role"] == "user" and len(last["content"]) == 1
        return last["content"][0]["text"]

    def written_by_the_cli(request):
        # Everything before the prompt, without the identifiers the CLI gives its own items, which are new on every call.
        def bare(value):
            if isinstance(value, list):
                return [bare(item) for item in value]
            return {key: bare(item) for key, item in value.items() if key != "id"} if isinstance(value, dict) else value
        return bare(request["input"][:-1])

    earlier, later = serialize_turn(fixture_conversation(2), tools, "auto", "Codex"), serialize_turn(fixture_conversation(3), tools, "auto", "Codex")
    first, second = await call(earlier), await call(later)
    # The CLI sends the prompt as it is, after what it writes itself.
    assert prompt_of(first) == earlier and prompt_of(second) == later
    # The factory's prompt grows at its end: the later one begins as the earlier one did, up to where its conversation closes.
    assert earlier.endswith("]}") and later.startswith(earlier[:-2] + ",")
    # What the CLI writes before the prompt is the same on both calls, so the two requests begin alike up to that point.
    assert written_by_the_cli(first) == written_by_the_cli(second)
    for part in ("instructions", "tools", "text", "reasoning", "tool_choice"):
        assert first.get(part) == second.get(part), part
    # Why the directory is fixed: the CLI names it before the prompt, and another path changes what comes first.
    elsewhere = await call(earlier, directory=tmp_path / "another-directory")
    assert written_by_the_cli(elsewhere) != written_by_the_cli(first) and prompt_of(elsewhere) == earlier
    assert str(tmp_path / "another-directory") in json.dumps(written_by_the_cli(elsewhere))
    # A limit the factory cannot move: the CLI names a cache key of its own, new for every process.
    assert len({request["prompt_cache_key"] for request in (first, second, elsewhere)}) == 3
