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

from sabre.codex_model import AssistantEnvelope
from sabre.codex_runner import BINARY, capture_process, cli_arguments, parse_events

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


@pytest.mark.parametrize("attack", ["image", "shell", "patch", "patch_read", "bridge_read", "public_read_control"])
async def test_pinned_cli_cannot_read_or_write_synthetic_private_files(tmp_path, attack):
    assert hashlib.sha256(Path(BINARY).read_bytes()).hexdigest() == PINNED_BINARY_SHA256
    home, workspace = tmp_path / "private", tmp_path / "workspace"
    home.mkdir(mode=0o700)
    workspace.mkdir()
    bridge = tmp_path / "bridge"
    bridge.mkdir(mode=0o700)
    bridge_token = bridge / "token"
    bridge_token.write_text("SYNTHETIC_PRIVATE_BRIDGE_CANARY\n")
    # A user configuration must not relax the fixed policy or replace the provider.
    (home / "config.toml").write_text("THIS IS DELIBERATELY INVALID USER CONFIG")
    canary = home / "canary.png"
    canary.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"))
    marker = home / "modified"
    private_text = home / "credential-fixture.txt"
    private_text.write_text("SYNTHETIC_PRIVATE_MATERIAL_CANARY\n")
    public_text = workspace / "public-fixture.txt"
    public_text.write_text("SYNTHETIC_PUBLIC_MATERIAL\n")
    target = json.dumps(str(canary))
    attacks = {
        "image": f"const result = await tools.view_image({{path:{target}}}); image(result.image_url);",
        "shell": f"text({{process:typeof process,require:typeof require,fetch:typeof fetch,read:typeof tools.read_file,shell:typeof tools.exec_command}}); const result=await tools.exec_command({{cmd:'cat '+{target}}}); text(result);",
        "patch": "const result=await tools.apply_patch(" + json.dumps(f"*** Begin Patch\n*** Add File: {marker}\n+CHANGED\n*** End Patch") + ");text(result);",
        "patch_read": "const result=await tools.apply_patch(" + json.dumps(f"*** Begin Patch\n*** Update File: {private_text}\n@@\n-NONMATCHING\n+CHANGED\n*** End Patch") + ");text(result);",
        "bridge_read": "const result=await tools.apply_patch(" + json.dumps(f"*** Begin Patch\n*** Update File: {bridge_token}\n@@\n-NONMATCHING\n+CHANGED\n*** End Patch") + ");text(result);",
        "public_read_control": "const result=await tools.apply_patch(" + json.dumps(f"*** Begin Patch\n*** Update File: {public_text}\n@@\n-NONMATCHING\n+CHANGED\n*** End Patch") + ");text(result);",
    }
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            number = len(requests)
            text = AssistantEnvelope(content="synthetic completed", tool_calls=[]).model_dump_json()
            item = {"type": "custom_tool_call", "id": "ctc_synthetic", "call_id": "call_synthetic", "name": "exec", "input": attacks[attack], "status": "completed"} if number == 1 else {
                "type": "message", "id": "msg_synthetic", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]}
            base = {"id": f"resp_synthetic_{number}", "object": "response"}
            events = [
                ("response.created", {"type": "response.created", "response": {**base, "status": "in_progress", "output": []}}),
                ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}}),
            ]
            if number != 1:
                events.append(("response.output_text.delta", {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": text}))
            events.extend([
                ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
                ("response.completed", {"type": "response.completed", "response": {**base, "status": "completed", "output": [item], "usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120, "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}}),
            ])
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for event, data in events:
                self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    schema = workspace / "schema.json"
    schema.write_text(json.dumps(AssistantEnvelope.model_json_schema()))
    overrides = {
        "model_provider": "sabredouble", "model_providers.sabredouble.name": "Synthetic offline test",
        "model_providers.sabredouble.base_url": f"http://127.0.0.1:{server.server_port}/v1",
        "model_providers.sabredouble.wire_api": "responses", "model_providers.sabredouble.env_key": "SABRE_SYNTHETIC_KEY",
        "model_providers.sabredouble.requires_openai_auth": False,
    }
    args = cli_arguments(home=home, workspace=workspace, secrets_dir=bridge)
    for key, value in overrides.items():
        args.extend(["-c", f"{key}={json.dumps(value)}"])
    args.extend(["--json", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "-C", str(workspace),
        "-m", "gpt-6.1-sol", "--output-schema", str(schema), "-"])
    try:
        code, stdout, _ = await capture_process(args, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home),
            "CODEX_HOME": str(home), "SABRE_SYNTHETIC_KEY": "synthetic-not-a-credential"},
            cwd=str(workspace), stdin=b"Return a synthetic fixture result", timeout=30)
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
    assert code == 0
    assert len(requests) == 2
    result = parse_events(stdout)
    assert result.input_tokens == 200 and result.output_tokens == 40
    assert result.usage_kind == "cli_invocation"
    assert not marker.exists()
    assert private_text.read_text() == "SYNTHETIC_PRIVATE_MATERIAL_CANARY\n"
    assert "SYNTHETIC_PRIVATE_MATERIAL_CANARY" not in json.dumps(requests)
    assert bridge_token.read_text() == "SYNTHETIC_PRIVATE_BRIDGE_CANARY\n"
    assert "SYNTHETIC_PRIVATE_BRIDGE_CANARY" not in json.dumps(requests)
    assert all("data:image/" not in json.dumps(request.get("input")) for request in requests)
    outputs = json.dumps([item for request in requests for item in request.get("input", []) if item.get("type") == "custom_tool_call_output"])
    assert "fs sandbox helper failed" not in outputs
    if attack == "image":
        assert "tools.view_image is not a function" in outputs
    elif attack == "shell":
        assert "tools.exec_command is not a function" in outputs
        for capability in ("process", "require", "fetch", "read", "shell"):
            assert f'\\"{capability}\\":\\"undefined\\"' in outputs
    elif attack == "patch":
        assert "write approval" in outputs or "writing outside" in outputs or "read-only" in outputs
    elif attack in {"patch_read", "bridge_read"}:
        assert "Failed to read file" in outputs
        assert "Failed to find expected lines" not in outputs
    else:
        assert "Failed to find expected lines" in outputs
        assert public_text.read_text() == "SYNTHETIC_PUBLIC_MATERIAL\n"
