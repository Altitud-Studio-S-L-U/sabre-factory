"""The executor reaches Docker only through a proxy that enforces the sandbox profile."""

import asyncio
import copy
import json
import re
from types import SimpleNamespace

import docker
import pytest

from sabre.browser_qa import browser_seccomp
from sabre.docker_proxy import MAX_HEAD, Denied, DockerProxy, Policy, parse_body
from sabre.executor import DockerBroker

HELPER = "registry.example/helper@sha256:" + "a" * 64
PYTHON = "registry.example/python@sha256:" + "b" * 64
BROWSER = "sha256:" + "c" * 64
ENVIRONMENT = {
    "SABRE_HELPER_IMAGE": HELPER, "SABRE_PYTHON_IMAGE": PYTHON, "SABRE_BROWSER_IMAGE": BROWSER,
    "SABRE_NODE_IMAGE": "", "SABRE_UNPINNED_IMAGE": "registry.example/latest:tag",
    "SABRE_DEPENDENCY_NETWORK": "sabre-factory_dependencies", "SABRE_SECURITY_UPDATE_NETWORK": "sabre-factory_security_updates",
    "SABRE_TRIVY_DB_VOLUME": "sabre-factory-trivy-cache", "SABRE_SEMGREP_RULES_VOLUME": "sabre-factory-semgrep-rules",
    "OTHER_IMAGE": "registry.example/other@sha256:" + "d" * 64,
}
OWNED = {"sabre.owner": "factory", "sabre.work_id": "work-1", "sabre.kind": "command"}


class FakeDaemon:
    """Records every request that reaches the daemon socket and answers like the Engine API."""

    def __init__(self):
        self.requests: list[SimpleNamespace] = []
        self.containers: dict[str, dict | None] = {}
        self.volumes: dict[str, dict | None] = {}
        self.networks: dict[str, dict] = {}
        self.execs: dict[str, str] = {}
        self.kept_alive: bytes | None = None

    async def handle(self, reader, writer):
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head[:-4].decode().split("\r\n")
        method, target, _version = lines[0].split(" ")
        headers = {name.lower(): value.strip() for name, value in (line.split(":", 1) for line in lines[1:])}
        body = await reader.readexactly(int(headers.get("content-length", 0)))
        self.requests.append(SimpleNamespace(method=method, target=target, headers=headers, body=body))
        if method == "POST" and target.endswith("/start") and "/exec/" in target:
            await self.exec_start(target, headers, reader, writer)
            return
        status, payload = self.respond(method, re.sub(r"^/v[\d.]+", "", target.split("?")[0]), body)
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        writer.write(f"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n"
                     "Connection: close\r\n\r\n".encode() + data)
        await writer.drain()
        writer.close()

    async def exec_start(self, target, headers, reader, writer):
        """Like the Engine: a raw multiplexed stream after an upgrade, or a refusal on a kept-alive connection."""
        if "9" * 64 in target:
            refusal = b'{"message":"exec is already running"}'
            writer.write(b"HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
                         + f"{len(refusal):x}\r\n".encode() + refusal + b"\r\n0\r\n\r\n")
            await writer.drain()
            self.kept_alive = await reader.read()
            writer.close()
            return
        assert headers.get("connection") == "Upgrade" and headers.get("upgrade") == "tcp"
        output = b"hello from the exec\n"
        writer.write(b"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
                     + b"\x01\x00\x00\x00" + len(output).to_bytes(4, "big") + output)
        await writer.drain()
        writer.close()

    def respond(self, method, path, body):
        if path == "/_ping":
            return 200, b"OK"
        if path == "/version":
            return 200, {"ApiVersion": "1.43", "Version": "fixture"}
        if path == "/containers/create":
            self.containers["c" * 64] = json.loads(body).get("Labels")
            return 201, {"Id": "c" * 64, "Warnings": []}
        if path == "/volumes/create":
            data = json.loads(body)
            self.volumes[data["Name"]] = data.get("Labels")
            return 201, {"Name": data["Name"], "Labels": data.get("Labels"), "Driver": "local", "Mountpoint": "", "Scope": "local"}
        if path == "/networks/create":
            data = json.loads(body)
            self.networks["n" * 12] = {"Id": "n" * 12, "Name": data["Name"], "Labels": data.get("Labels"), "Internal": data.get("Internal")}
            return 201, {"Id": "n" * 12, "Warning": ""}
        if found := re.fullmatch(r"/containers/([^/]+)/json", path):
            if found[1] not in self.containers:
                return 404, {"message": "No such container: " + found[1]}
            return 200, {"Id": found[1], "Name": "/fixture", "Image": "sha256:" + "0" * 64, "State": {"Status": "running"},
                         "Config": {"Labels": self.containers[found[1]], "Image": HELPER, "Tty": False}}
        if found := re.fullmatch(r"/volumes/([^/]+)", path):
            if found[1] not in self.volumes:
                return 404, {"message": "No such volume: " + found[1]}
            return (200, {"Name": found[1], "Labels": self.volumes[found[1]], "Options": {"type": "tmpfs"}}) if method == "GET" else (204, b"")
        if found := re.fullmatch(r"/networks/([^/]+)", path):
            network = self.networks.get(found[1]) or next((item for item in self.networks.values() if item["Name"] == found[1]), None)
            if network is None:
                return 404, {"message": "No such network: " + found[1]}
            return (200, network) if method == "GET" else (204, b"")
        if found := re.fullmatch(r"/exec/([^/]+)/json", path):
            if found[1] not in self.execs:
                return 404, {"message": "No such exec instance"}
            return 200, {"ID": found[1], "ContainerID": self.execs[found[1]], "ExitCode": 0, "Running": False}
        if found := re.fullmatch(r"/containers/([^/]+)/exec", path):
            self.execs["e" * 64] = found[1]
            return 201, {"Id": "e" * 64}
        if path in {"/containers/json", "/networks"}:
            return 200, []
        if path.endswith("/wait"):
            return 200, {"StatusCode": 0}
        if path.endswith("/archive"):
            return 200, b""
        return (200, {}) if method == "GET" else (204, b"")

    def seen(self, method, suffix):
        return [request for request in self.requests if request.method == method and request.target.split("?")[0].endswith(suffix)]


@pytest.fixture
async def stack(tmp_path):
    daemon, denials = FakeDaemon(), []
    upstream, socket = str(tmp_path / "daemon.sock"), str(tmp_path / "proxy.sock")
    proxy = DockerProxy(Policy.from_environment(ENVIRONMENT), upstream, log=denials.append)
    servers = [await asyncio.start_unix_server(daemon.handle, upstream),
               await asyncio.start_unix_server(proxy.handle, socket, limit=MAX_HEAD)]
    client = docker.DockerClient(base_url="unix://" + socket, version="1.43", timeout=10)
    try:
        yield SimpleNamespace(daemon=daemon, client=client, socket=socket, denials=denials, root=tmp_path)
    finally:
        client.close()
        for server in servers:
            server.close()
            await server.wait_closed()


async def call(function, *args, **kwargs):
    return await asyncio.to_thread(function, *args, **kwargs)


async def raw(socket, data: bytes) -> bytes:
    reader, writer = await asyncio.open_unix_connection(socket)
    writer.write(data)
    await writer.drain()
    response = await asyncio.wait_for(reader.read(), 10)
    writer.close()
    return response


def test_policy_reads_only_pinned_sabre_images_and_the_named_networks_and_caches():
    policy = Policy.from_environment(ENVIRONMENT)
    assert policy.images == {HELPER, PYTHON, BROWSER}
    assert policy.networks == {"sabre-factory_dependencies", "sabre-factory_security_updates"}
    assert policy.volumes == {"sabre-factory-trivy-cache", "sabre-factory-semgrep-rules"}
    assert policy.seccomp == {"seccomp=" + browser_seccomp()}
    assert policy.mountable("sabre-factory-ws-work-1") and policy.mountable("sabre-factory-trivy-cache")
    for secret in ("sabre-factory-control-bootstrap", "sabre-factory-broker-bootstrap", "sabre-factory-codex-home",
                   "sabre-factory_postgres-data", "sabre-factory-ws-", "/", "/var/run/docker.sock"):
        assert not policy.mountable(secret)


async def test_the_broker_profile_passes_and_the_daemon_receives_what_was_checked(stack, monkeypatch):
    for key, value in ENVIRONMENT.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("SABRE_BOOTSTRAP_FILE", raising=False)
    broker = DockerBroker(stack.root / "state", docker_client=stack.client)
    cache = {"sabre-factory-trivy-cache": {"bind": "/cache", "mode": "rw"}}
    await call(broker._container, HELPER, "work-1", ["/usr/bin/sleep", "infinity"])
    await call(broker._container, HELPER, "work-1", ["sleep", "infinity"], keeper=True)
    await call(broker._container, PYTHON, "work-1", ["uv", "sync"], network="sabre-factory_dependencies",
               environment={"HTTP_PROXY": "http://dependencies-proxy:3128"})
    await call(broker._container, HELPER, "security-update", ["trivy"], include_workspace=False, user="0:0",
               network="sabre-factory_security_updates", extra_volumes=cache, temporary_size_mb=512)
    await call(broker._container, HELPER, "work-1", ["cat"], readonly_workspace=True,
               extra_volumes={"sabre-factory-semgrep-rules": {"bind": "/rules", "mode": "ro"}})
    created = stack.daemon.seen("POST", "/containers/create")
    assert len(created) == 5 and stack.denials == []
    assert "name=sabre-factory-keeper-work-1" in created[1].target
    for request in created:
        body = json.loads(request.body)
        assert request.headers["connection"] == "close" and int(request.headers["content-length"]) == len(request.body)
        assert request.body == json.dumps(body, separators=(",", ":")).encode()
        host = body["HostConfig"]
        assert host["ReadonlyRootfs"] is True and host["CapDrop"] == ["ALL"] and host["SecurityOpt"] == ["no-new-privileges:true"]
        assert body["Labels"]["sabre.owner"] == "factory"
    assert json.loads(created[0].body)["NetworkDisabled"] is True
    assert json.loads(created[2].body)["HostConfig"]["NetworkMode"] == "sabre-factory_dependencies"
    assert "sabre-factory-trivy-cache:/cache:rw" in json.loads(created[3].body)["HostConfig"]["Binds"]


async def test_workspace_volume_browser_network_and_browser_containers_pass(stack):
    client = stack.client
    await call(client.volumes.create, name="sabre-factory-ws-work-1", labels={"sabre.owner": "factory", "sabre.work_id": "work-1"},
               driver_opts={"type": "tmpfs", "device": "tmpfs", "o": "size=512m,uid=10001,gid=10001,mode=0755"})
    labels = {"sabre.owner": "factory", "sabre.work_id": "work-1", "sabre.kind": "browser-qa", "sabre.browser_job": "ab12"}
    network = await call(client.networks.create, "sabre-browser-ab12", driver="bridge", internal=True, labels=labels,
                         options={"com.docker.network.bridge.enable_ip_masquerade": "false"})
    await call(network.reload)
    common = dict(user="10001:10001", network=network.name, read_only=True, cap_drop=["ALL"], mem_limit="1g",
                  nano_cpus=1_000_000_000, dns=["127.0.0.1"], labels=labels,
                  tmpfs={"/tmp": "rw,nosuid,noexec,size=128m,uid=10001,gid=10001"},  # noqa: S108 - container path
                  log_config=docker.types.LogConfig(type="json-file", config={"max-size": "1m", "max-file": "1"}))
    await call(client.containers.create, image=PYTHON, command=["npm", "start"], working_dir="/workspace", pids_limit=128,
               security_opt=["no-new-privileges:true"], environment={"PORT": "3000"},
               volumes={"sabre-factory-ws-work-1": {"bind": "/workspace", "mode": "ro"}}, **common)
    await call(client.containers.create, image=BROWSER, command=["/usr/bin/sleep", "infinity"], working_dir="/opt/sabre-browser",
               pids_limit=256, init=True, shm_size="128m", environment={"HOME": "/tmp"},  # noqa: S108 - container path
               security_opt=["no-new-privileges:true", "seccomp=" + browser_seccomp()], **common)
    await call(client.images.get, BROWSER)
    await call(client.containers.list, all=True, filters={"label": ["sabre.owner=factory", "sabre.work_id=work-1"]})
    await call(client.networks.list, filters={"label": ["sabre.owner=factory"]})
    await call(network.remove)
    await call((await call(client.volumes.get, "sabre-factory-ws-work-1")).remove)
    assert stack.denials == []
    assert len(stack.daemon.seen("POST", "/containers/create")) == 2
    assert stack.daemon.seen("DELETE", "/networks/" + "n" * 12) and stack.daemon.seen("DELETE", "/volumes/sabre-factory-ws-work-1")


def valid_container():
    return {"Image": HELPER, "Cmd": ["true"], "Labels": dict(OWNED), "NetworkDisabled": True,
            "HostConfig": {"ReadonlyRootfs": True, "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
                           "Binds": ["sabre-factory-ws-work-1:/workspace:rw"], "NetworkMode": "default", "Memory": 2147483648,
                           "NanoCpus": 1000000000, "PidsLimit": 256, "Tmpfs": {"/tmp": "rw,noexec"}}}  # noqa: S108 - container path


def changed(*path_and_value):
    body = valid_container()
    target = body
    *path, key, value = path_and_value
    for step in path:
        target = target[step]
    if value is ...:
        del target[key]
    else:
        target[key] = value
    return body


ESCAPES = {
    "privileged": changed("HostConfig", "Privileged", True),
    "host root bind": changed("HostConfig", "Binds", ["/:/host"]),
    "daemon socket bind": changed("HostConfig", "Binds", ["/var/run/docker.sock:/var/run/docker.sock"]),
    "relative host bind": changed("HostConfig", "Binds", ["./state:/state"]),
    "control credentials volume": changed("HostConfig", "Binds", ["sabre-factory-control-bootstrap:/secrets:ro"]),
    "database volume": changed("HostConfig", "Binds", ["sabre-factory_postgres-data:/data"]),
    "bind propagation": changed("HostConfig", "Binds", ["sabre-factory-ws-work-1:/workspace:rw,shared"]),
    "mounts": changed("HostConfig", "Mounts", [{"Type": "bind", "Source": "/", "Target": "/host"}]),
    "volumes from": changed("HostConfig", "VolumesFrom", ["sabre-factory-api-1"]),
    "added capability": changed("HostConfig", "CapAdd", ["SYS_ADMIN"]),
    "capabilities kept": changed("HostConfig", "CapDrop", []),
    "writable root": changed("HostConfig", "ReadonlyRootfs", False),
    "new privileges": changed("HostConfig", "SecurityOpt", []),
    "seccomp off": changed("HostConfig", "SecurityOpt", ["no-new-privileges:true", "seccomp=unconfined"]),
    "another seccomp profile": changed("HostConfig", "SecurityOpt", ["no-new-privileges:true", 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}']),
    "apparmor off": changed("HostConfig", "SecurityOpt", ["no-new-privileges:true", "apparmor=unconfined"]),
    "host network": changed("HostConfig", "NetworkMode", "host"),
    "another container's network": changed("HostConfig", "NetworkMode", "container:sabre-factory-api-1"),
    "default bridge with network": {**valid_container(), "NetworkDisabled": False},
    "control network": {**changed("HostConfig", "NetworkMode", "sabre-factory_control"), "NetworkDisabled": False},
    "host pid": changed("HostConfig", "PidMode", "host"),
    "host ipc": changed("HostConfig", "IpcMode", "host"),
    "host user namespace": changed("HostConfig", "UsernsMode", "host"),
    "device": changed("HostConfig", "Devices", [{"PathOnHost": "/dev/sda", "PathInContainer": "/dev/sda", "CgroupPermissions": "rwm"}]),
    "published port": changed("HostConfig", "PortBindings", {"80/tcp": [{"HostPort": "80"}]}),
    "another runtime": changed("HostConfig", "Runtime", "sysbox"),
    "remote log driver": changed("HostConfig", "LogConfig", {"Type": "syslog", "Config": {"syslog-address": "tcp://203.0.113.9:514"}}),
    "always restart": changed("HostConfig", "RestartPolicy", {"Name": "always"}),
    "sysctl": changed("HostConfig", "Sysctls", {"kernel.core_pattern": "|/tmp/x"}),
    "unpinned image": changed("Image", "python:latest"),
    "pinned image outside the list": changed("Image", "registry.example/other@sha256:" + "d" * 64),
    "no owner label": changed("Labels", {"sabre.work_id": "work-1"}),
    "no host configuration": changed("HostConfig", ...),
    "lower-case host configuration": {**{key: value for key, value in valid_container().items() if key != "HostConfig"},
                                      "hostconfig": {**valid_container()["HostConfig"], "privileged": True}},
    "another endpoint": {**valid_container(), "NetworkingConfig": {"EndpointsConfig": {"sabre-factory_control": {}}}},
}


@pytest.mark.parametrize("name", list(ESCAPES))
def test_container_creation_outside_the_sandbox_profile_is_refused(name):
    policy = Policy.from_environment(ENVIRONMENT)
    policy.container_create(valid_container(), {})
    policy.container_create(valid_container(), {"name": ["sabre-factory-keeper-work-1"]})
    with pytest.raises(Denied):
        policy.container_create(copy.deepcopy(ESCAPES[name]), {})


def test_container_names_volumes_networks_and_exec_stay_inside_the_factory_namespace():
    policy = Policy.from_environment(ENVIRONMENT)
    volume = {"Name": "sabre-factory-ws-work-1", "Driver": "local", "Labels": {"sabre.owner": "factory"},
              "DriverOpts": {"type": "tmpfs", "device": "tmpfs", "o": "size=512m"}}
    network = {"Name": "sabre-browser-ab12", "Driver": "bridge", "Internal": True, "Labels": {"sabre.owner": "factory"},
               "Options": {"com.docker.network.bridge.enable_ip_masquerade": "false"}}
    policy.volume_create(volume)
    policy.network_create(network)
    policy.exec_create({"Cmd": ["cat"], "User": "10001:10001", "Privileged": False})
    refused = [
        (policy.container_create, valid_container(), {"name": ["sabre-factory-api-1"]}),
        (policy.container_create, valid_container(), {"name": ["sabre-factory-keeper-work-1"], "platform": ["linux/amd64"]}),
        (policy.volume_create, {**volume, "DriverOpts": {"type": "none", "o": "bind", "device": "/"}}),
        (policy.volume_create, {**volume, "DriverOpts": {"type": "nfs", "device": ":/export", "o": "addr=203.0.113.9"}}),
        (policy.volume_create, {**volume, "Name": "sabre-factory-control-bootstrap"}),
        (policy.volume_create, {**volume, "Labels": {}}),
        (policy.volume_create, {**volume, "Driver": "vieux/sshfs"}),
        (policy.network_create, {**network, "Internal": False}),
        (policy.network_create, {**network, "Name": "sabre-factory_control"}),
        (policy.network_create, {**network, "Driver": "host"}),
        (policy.network_create, {**network, "Options": {"com.docker.network.bridge.enable_ip_masquerade": "true"}}),
        (policy.network_create, {**network, "Attachable": True}),
        (policy.exec_create, {"Cmd": ["cat"], "Privileged": True}),
        (policy.exec_create, {"Cmd": ["cat"], "privileged": True}),
    ]
    for function, *arguments in refused:
        with pytest.raises(Denied):
            function(*arguments)


def test_checked_json_cannot_hide_a_field_behind_a_repeated_or_recased_key():
    for text in ('{"HostConfig":{},"HostConfig":{"Privileged":true}}', '{"HostConfig":{},"hostconfig":{"Privileged":true}}',
                 '{"Labels":{"a":1,"A":2}}', "[]", '"text"', "{"):
        with pytest.raises(Denied):
            parse_body(text.encode())
    assert parse_body(b' {"Image" : "x",\n "Labels": {"a": "b"}} ') == {"Image": "x", "Labels": {"a": "b"}}


async def test_container_calls_reach_only_factory_owned_containers(stack):
    daemon, client = stack.daemon, stack.client
    daemon.containers.update({"owned": dict(OWNED), "sabre-factory-api-1": {"com.docker.compose.project": "sabre-factory"},
                              "unlabelled": None})
    container = await call(client.containers.get, "owned")
    await call(container.start)
    await call(container.kill)
    await call(container.wait, timeout=5)
    await call(container.logs, tail=10)
    archive = bytes(range(256)) * 1200
    assert await call(container.put_archive, "/workspace", archive)
    assert daemon.seen("PUT", "/containers/owned/archive")[0].body == archive
    await call(container.remove, force=True)
    assert [request.target.split("?")[0].rsplit("/", 1)[-1] for request in daemon.requests if request.method == "POST"] == ["start", "kill", "wait"]
    with pytest.raises(docker.errors.NotFound):
        await call(client.containers.get, "missing")
    forwarded = len(daemon.requests)
    for name in ("sabre-factory-api-1", "unlabelled"):
        with pytest.raises(docker.errors.APIError) as error:
            await call(client.containers.get, name)
        assert error.value.status_code == 403
        for operation in ("start", "kill", "stop", "restart", "pause", "wait", "exec", "attach", "update", "rename"):
            response = await raw(stack.socket, f"POST /v1.43/containers/{name}/{operation} HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\n\r\n{{}}".encode())
            assert response.startswith(b"HTTP/1.1 403 ")
        for method, suffix in (("DELETE", ""), ("GET", "/logs"), ("GET", "/archive?path=/"), ("PUT", "/archive?path=/"), ("GET", "/export"), ("GET", "/top")):
            response = await raw(stack.socket, f"{method} /v1.43/containers/{name}{suffix} HTTP/1.1\r\nHost: docker\r\n\r\n".encode())
            assert response.startswith(b"HTTP/1.1 403 ")
    # Only the ownership lookups reached the daemon: nothing was started, read or removed.
    assert {(request.method, request.target.rsplit("/", 1)[-1]) for request in daemon.requests[forwarded:]} == {("GET", "json")}
    assert stack.denials and all(record["event"] == "docker_request_denied" for record in stack.denials)


async def test_exec_runs_only_unprivileged_in_owned_containers_and_is_attributed_by_the_daemon(stack):
    daemon, client = stack.daemon, stack.client
    daemon.containers.update({"owned": dict(OWNED), "foreign": {}})
    created = await call(client.api.exec_create, "owned", ["cat", "/tmp/result.json"], user="10001:10001")
    assert created["Id"] == "e" * 64 and json.loads(daemon.seen("POST", "/containers/owned/exec")[0].body)["Privileged"] is False
    assert (await call(client.api.exec_inspect, created["Id"]))["ContainerID"] == "owned"
    result = await call((await call(client.containers.get, "owned")).exec_run, ["cat", "/tmp/result.json"], user="10001:10001")
    assert result.output == b"hello from the exec\n" and result.exit_code == 0
    # A refusal arrives on a connection the daemon keeps open; the proxy closes it and forwards nothing more.
    daemon.execs["9" * 64] = "owned"
    refused = await raw(stack.socket, f"POST /v1.43/exec/{'9' * 64}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n"
                                      "Content-Length: 2\r\n\r\n{}POST /v1.43/containers/create HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\n\r\n{}".encode())
    assert refused.startswith(b"HTTP/1.1 409 ") and b"Connection: close" in refused and refused.endswith(b'{"message":"exec is already running"}')
    for _ in range(100):
        if daemon.kept_alive is not None:
            break
        await asyncio.sleep(0.01)
    assert daemon.kept_alive == b"" and len(daemon.seen("POST", "/containers/create")) == 0
    with pytest.raises(docker.errors.APIError):
        await call(client.api.exec_create, "owned", ["id"], privileged=True)
    with pytest.raises(docker.errors.APIError):
        await call(client.api.exec_create, "foreign", ["cat", "/run/secrets/sabre/control.json"])
    daemon.execs["f" * 64] = "foreign"
    for request in (f"POST /v1.43/exec/{'f' * 64}/start HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\n\r\n{{}}",
                    f"GET /v1.43/exec/{'f' * 64}/json HTTP/1.1\r\nHost: docker\r\n\r\n"):
        assert (await raw(stack.socket, request.encode())).startswith(b"HTTP/1.1 403 ")
    assert len(daemon.seen("POST", "/exec")) == 2 and not daemon.seen("POST", f"/exec/{'f' * 64}/start")


async def test_everything_else_in_the_engine_api_is_closed(stack):
    daemon, client = stack.daemon, stack.client
    daemon.volumes.update({"sabre-factory-control-bootstrap": {"com.docker.compose.project": "sabre-factory"},
                           "sabre-factory-ws-foreign": {}, "sabre-factory-trivy-cache": {"com.docker.compose.project": "sabre-factory"}})
    daemon.networks["sabre-factory_control"] = {"Id": "control", "Name": "sabre-factory_control", "Labels": {}, "Internal": False}
    daemon.networks["sabre-factory_dependencies"] = {"Id": "deps", "Name": "sabre-factory_dependencies", "Labels": {}, "Internal": True}
    assert (await call(client.volumes.get, "sabre-factory-trivy-cache")).name == "sabre-factory-trivy-cache"
    assert (await call(client.networks.get, "sabre-factory_dependencies")).attrs["Internal"] is True
    assert await call(client.ping)
    before = len(daemon.requests)
    closed = [
        (client.info,), (client.containers.list,), (client.containers.list, True), (client.images.list,), (client.images.pull, "alpine"),
        (client.images.get, "alpine"), (client.images.get, "registry.example/other@sha256:" + "d" * 64),
        (client.volumes.list,), (client.volumes.get, "sabre-factory-control-bootstrap"), (client.networks.list,),
        (client.api.remove_volume, "sabre-factory-trivy-cache"), (client.api.remove_volume, "sabre-factory-control-bootstrap"),
        (client.api.remove_network, "sabre-factory_dependencies"), (client.api.prune_containers,), (client.api.prune_volumes,),
        (client.df,), (client.api.init_swarm,), (client.api.inspect_swarm,), (client.secrets.list,), (client.plugins.list,),
        (client.api.connect_container_to_network, "owned", "sabre-factory_control"),
    ]
    for function, *arguments in closed:
        with pytest.raises(docker.errors.APIError) as error:
            await call(function, *arguments)
        assert error.value.status_code == 403, function
    for path in ("/events", "/v1.43/events", "/build", "/auth", "/containers/owned/attach/ws", "/session", "/grpc"):
        assert (await raw(stack.socket, f"GET {path} HTTP/1.1\r\nHost: docker\r\n\r\n".encode())).startswith(b"HTTP/1.1 403 ")
    for name in ("sabre-factory-ws-foreign", "sabre-factory_control"):
        with pytest.raises(docker.errors.APIError) as error:
            await call(client.api.remove_volume if name.startswith("sabre-factory-ws") else client.api.inspect_network, name)
        assert error.value.status_code == 403
    assert all(request.method == "GET" and re.search(r"/(volumes|networks)/[^/?]+$", request.target) for request in daemon.requests[before:])


@pytest.mark.parametrize("request_bytes,status", [
    (b"GET /_ping HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", 400),
    (b"POST /containers/owned/start HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\nContent-Length: 44\r\n\r\n", 400),
    (b"GET /_ping HTTP/1.1\r\nHost: docker\nTransfer-Encoding: chunked\r\n\r\n", 400),
    (b"GET /_ping HTTP/1.1\r\nHost: docker\r\n X-Folded: value\r\n\r\n", 400),
    (b"GET /_ping HTTP/2\r\nHost: docker\r\n\r\n", 400),
    (b"GET /containers/json?filters=%7B%22label%22%3A%5B%22sabre.owner%3Dfactory%22%5D%7D&filters=%7B%7D HTTP/1.1\r\nHost: docker\r\n\r\n", 400),
    (b"GET /_ping#/containers/create HTTP/1.1\r\nHost: docker\r\n\r\n", 400),
    (b"GET /containers/owned/../../info HTTP/1.1\r\nHost: docker\r\n\r\n", 403),
    (b"GET /v1.43//info HTTP/1.1\r\nHost: docker\r\n\r\n", 403),
    (b"GET /containers/owned%2F..%2F..%2Finfo/json HTTP/1.1\r\nHost: docker\r\n\r\n", 403),
    (b"POST /containers/create HTTP/1.1\r\nHost: docker\r\nContent-Length: 9999999\r\n\r\n", 413),
    (b"GET /" + b"a" * (MAX_HEAD + 10) + b" HTTP/1.1\r\nHost: docker\r\n\r\n", 431),
])
async def test_ambiguous_or_oversized_requests_never_reach_the_daemon(stack, request_bytes, status):
    stack.daemon.containers["owned"] = dict(OWNED)
    response = await raw(stack.socket, request_bytes)
    assert response.startswith(f"HTTP/1.1 {status} ".encode())
    assert stack.daemon.requests == []


async def test_one_request_per_connection_so_a_pipelined_request_is_never_forwarded(stack):
    stack.daemon.containers["owned"] = dict(OWNED)
    smuggled = json.dumps({"Image": "alpine", "HostConfig": {"Privileged": True, "Binds": ["/:/host"]}}).encode()
    pipelined = (b"POST /v1.43/containers/owned/start HTTP/1.1\r\nHost: docker\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n"
                 b"POST /v1.43/containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n"
                 b"Content-Length: " + str(len(smuggled)).encode() + b"\r\n\r\n" + smuggled)
    response = await raw(stack.socket, pipelined)
    assert response.count(b"HTTP/1.1 ") == 1 and response.startswith(b"HTTP/1.1 204 ")
    assert [(request.method, request.target) for request in stack.daemon.requests] == [
        ("GET", "/v1.43/containers/owned/json"), ("POST", "/v1.43/containers/owned/start")]
    assert stack.daemon.requests[1].headers["connection"] == "close" and stack.daemon.requests[1].body == b""
