"""Docker API permission proxy for the executor broker.

The broker is the only component that drives Docker. It used to hold the daemon socket,
which is root on the host. This proxy holds the socket instead and forwards only what the
broker's own container profile needs: the configured digest-pinned images, per-run
workspace volumes and the two scanner caches, no privileges, no host namespaces or paths,
and container-scoped calls only on containers labelled as factory-owned.

One request is served per connection. The request line, headers and any checked JSON body
are written again by the proxy, so the daemon parses exactly what the policy examined, and
no byte the client sends after its request is ever forwarded.
"""

import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

DIGEST_IMAGE = re.compile(r"(?:[^\s]+@)?sha256:[0-9a-f]{64}")
WORKSPACE_VOLUME = re.compile(r"sabre-factory-ws-[A-Za-z0-9][A-Za-z0-9_-]{0,79}")
BROWSER_NETWORK = re.compile(r"sabre-browser-[0-9a-f]{1,24}")
CONTAINER_NAME = re.compile(r"sabre-factory-keeper-[A-Za-z0-9][A-Za-z0-9_-]{0,79}")
NAME = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}"
VERSION = re.compile(r"/v\d+\.\d+(?=/)")
TOKEN = re.compile(r"[A-Za-z0-9!#$%&'*+.^_`|~-]+")
MAX_HEAD = 65536
MAX_CHECKED_BODY = 4 * 1024 * 1024
MAX_LOOKUP = 8 * 1024 * 1024
MAX_REFUSAL = 1024 * 1024
HEAD_TIMEOUT = 30

ROUTES: list[tuple[frozenset[str], re.Pattern[str], str]] = [
    (frozenset(methods.split()), re.compile(pattern), kind) for methods, pattern, kind in [
        ("GET HEAD", r"/_ping", "open"),
        ("GET", r"/version", "open"),
        ("POST", r"/containers/create", "container_create"),
        ("GET", r"/containers/json", "owned_list"),
        ("GET", rf"/containers/({NAME})/(?:json|logs)", "container"),
        ("POST", rf"/containers/({NAME})/(?:start|kill|wait)", "container"),
        ("PUT", rf"/containers/({NAME})/archive", "container"),
        ("DELETE", rf"/containers/({NAME})", "container"),
        ("POST", rf"/containers/({NAME})/exec", "exec_create"),
        ("POST", rf"/exec/({NAME})/start", "exec"),
        ("GET", rf"/exec/({NAME})/json", "exec"),
        ("POST", r"/volumes/create", "volume_create"),
        ("GET", rf"/volumes/({NAME})", "volume_read"),
        ("DELETE", rf"/volumes/({NAME})", "volume_remove"),
        ("POST", r"/networks/create", "network_create"),
        ("GET", r"/networks", "owned_list"),
        ("GET", rf"/networks/({NAME})", "network_read"),
        ("DELETE", rf"/networks/({NAME})", "network_remove"),
        ("GET", r"/images/(.+)/json", "image_read"),
    ]
]

# HostConfig fields the broker's profile uses. Any other field must be empty.
HOST_NUMBERS = {"memory", "nanocpus", "pidslimit", "shmsize", "memoryswap"}
HOST_CHECKED = {"binds", "networkmode", "readonlyrootfs", "capdrop", "securityopt", "logconfig", "tmpfs",
                "restartpolicy", "dns", "init"}
MASQUERADE = "com.docker.network.bridge.enable_ip_masquerade"
CHECKED = {"container_create", "exec_create", "volume_create", "network_create"}


class Denied(Exception):
    def __init__(self, reason: str, status: int = 403):
        super().__init__(reason)
        self.reason, self.status = reason, status


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    # The daemon matches JSON keys without regard to case and keeps the last duplicate.
    seen: set[str] = set()
    for key, _value in pairs:
        folded = key.casefold()
        if folded in seen:
            raise Denied("the request repeats a JSON key")
        seen.add(folded)
    return dict(pairs)


def parse_body(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_keys)
    except (ValueError, UnicodeDecodeError):
        raise Denied("the request body is not valid JSON", 400) from None
    if not isinstance(value, dict):
        raise Denied("the request body must be a JSON object", 400)
    return value


def field(body: Any, name: str) -> Any:
    """Read a field the way the daemon would: by name, ignoring case."""
    if not isinstance(body, dict):
        return None
    folded = name.casefold()
    return next((value for key, value in body.items() if key.casefold() == folded), None)


def empty(value: Any) -> bool:
    return value is None or value is False or value == "" or value == 0 or value == [] or value == {}


def owned(labels: Any) -> bool:
    return isinstance(labels, dict) and labels.get("sabre.owner") == "factory"


def one_of(value: Any, allowed) -> bool:
    return isinstance(value, (str, type(None))) and value in allowed


@dataclass(frozen=True)
class Policy:
    images: frozenset[str]
    networks: frozenset[str]
    volumes: frozenset[str]
    seccomp: frozenset[str] = frozenset()

    @classmethod
    def from_environment(cls, environment=os.environ) -> Policy:
        images = {value for key, value in environment.items()
                  if key.startswith("SABRE_") and key.endswith("_IMAGE") and DIGEST_IMAGE.fullmatch(value)}
        networks = {environment.get(key, "") for key in ("SABRE_DEPENDENCY_NETWORK", "SABRE_SECURITY_UPDATE_NETWORK")}
        volumes = {environment.get("SABRE_TRIVY_DB_VOLUME", "sabre-factory-trivy-db"),
                   environment.get("SABRE_SEMGREP_RULES_VOLUME", "sabre-factory-semgrep-rules")}
        # The one reviewed syscall profile, as the browser runner sends it.
        profile = Path(__file__).with_name("browser_seccomp.json")
        seccomp = {"seccomp=" + profile.read_text(encoding="utf-8")} if profile.is_file() else set()
        return cls(frozenset(images), frozenset(networks - {""}), frozenset(volumes - {""}), frozenset(seccomp))

    def mountable(self, name: str) -> bool:
        return bool(WORKSPACE_VOLUME.fullmatch(name)) or name in self.volumes

    def container_create(self, body: dict, query: dict[str, list[str]]) -> None:
        name = query.get("name", [""])[-1]
        if name and not CONTAINER_NAME.fullmatch(name):
            raise Denied("the container name is outside the factory namespace")
        if set(query) - {"name"}:
            raise Denied("container creation accepts only a name")
        if not one_of(field(body, "Image"), self.images):
            raise Denied("the image is not one of the configured digest-pinned images")
        if not owned(field(body, "Labels")):
            raise Denied("the container is not labelled as factory-owned")
        host = field(body, "HostConfig")
        if not isinstance(host, dict):
            raise Denied("the container has no host configuration")
        for key, value in host.items():
            folded = key.casefold()
            if folded in HOST_NUMBERS:
                if value is not None and (type(value) is not int or value < 0):
                    raise Denied(f"HostConfig.{key} must be a non-negative integer")
            elif folded not in HOST_CHECKED and not empty(value):
                raise Denied(f"HostConfig.{key} is outside the sandbox profile")
        if field(host, "ReadonlyRootfs") is not True:
            raise Denied("the container root filesystem must be read-only")
        dropped = field(host, "CapDrop")
        if not isinstance(dropped, list) or "ALL" not in dropped:
            raise Denied("the container must drop all capabilities")
        options = field(host, "SecurityOpt")
        if not isinstance(options, list) or "no-new-privileges:true" not in options:
            raise Denied("the container must set no-new-privileges")
        for option in options:
            if option != "no-new-privileges:true" and not one_of(option, self.seccomp):
                raise Denied("the security option is outside the sandbox profile")
        for bind in field(host, "Binds") or []:
            parts = bind.split(":") if isinstance(bind, str) else []
            if len(parts) not in (2, 3) or not self.mountable(parts[0]) or not parts[1].startswith("/") \
                    or (len(parts) == 3 and parts[2] not in {"ro", "rw"}):
                raise Denied("the mount is not a run workspace or a scanner cache")
        log = field(host, "LogConfig")
        if not empty(log) and (not isinstance(log, dict) or not one_of(field(log, "Type"), {None, "", "json-file"})):
            raise Denied("container logs must stay in the local json-file driver")
        tmpfs = field(host, "Tmpfs")
        if not empty(tmpfs) and not (isinstance(tmpfs, dict) and all(
                isinstance(path, str) and path.startswith("/") and isinstance(value, str) for path, value in tmpfs.items())):
            raise Denied("the temporary filesystem is malformed")
        restart = field(host, "RestartPolicy")
        if not empty(restart) and (not isinstance(restart, dict) or not one_of(field(restart, "Name"), {None, "", "no", "unless-stopped"})):
            raise Denied("the restart policy is outside the sandbox profile")
        dns = field(host, "Dns")
        if not empty(dns) and not (isinstance(dns, list) and all(isinstance(item, str) for item in dns)):
            raise Denied("the DNS configuration is malformed")
        if not isinstance(field(host, "Init"), (bool, type(None))):
            raise Denied("the init flag is malformed")
        mode = field(host, "NetworkMode") or "default"
        if not isinstance(mode, str):
            raise Denied("the network is malformed")
        if field(body, "NetworkDisabled") is True:
            if mode not in {"default", "none"}:
                raise Denied("a container without network cannot name a network")
        elif mode not in self.networks and not BROWSER_NETWORK.fullmatch(mode):
            raise Denied("the network is not an internal factory network")
        endpoints = field(field(body, "NetworkingConfig"), "EndpointsConfig")
        if not empty(endpoints):
            if not isinstance(endpoints, dict) or set(endpoints) != {mode} or not all(
                    empty(value) or (isinstance(value, dict) and all(empty(item) for item in value.values()))
                    for value in endpoints.values()):
                raise Denied("the endpoint configuration is outside the sandbox profile")

    def exec_create(self, body: dict) -> None:
        if not empty(field(body, "Privileged")):
            raise Denied("privileged exec is not allowed")

    def volume_create(self, body: dict) -> None:
        name = field(body, "Name")
        if not isinstance(name, str) or not WORKSPACE_VOLUME.fullmatch(name):
            raise Denied("only run workspace volumes can be created")
        if not one_of(field(body, "Driver"), {None, "", "local"}):
            raise Denied("workspace volumes use the local driver")
        options = field(body, "DriverOpts")
        if not isinstance(options, dict) or set(options) - {"type", "device", "o"} \
                or options.get("type") != "tmpfs" or options.get("device") != "tmpfs" \
                or not isinstance(options.get("o", ""), str):
            raise Denied("workspace volumes are memory-backed, never a host path")
        if not owned(field(body, "Labels")):
            raise Denied("the volume is not labelled as factory-owned")

    def network_create(self, body: dict) -> None:
        name = field(body, "Name")
        if not isinstance(name, str) or not BROWSER_NETWORK.fullmatch(name):
            raise Denied("only per-job browser networks can be created")
        if field(body, "Internal") is not True or not one_of(field(body, "Driver"), {None, "", "bridge"}):
            raise Denied("browser networks are internal bridges")
        if not owned(field(body, "Labels")):
            raise Denied("the network is not labelled as factory-owned")
        options = field(body, "Options") or {}
        if not isinstance(options, dict) or set(options) - {MASQUERADE} or options.get(MASQUERADE, "false") != "false":
            raise Denied("the network option is outside the sandbox profile")
        for key in ("Attachable", "Ingress", "ConfigOnly", "ConfigFrom", "EnableIPv6", "EnableIPv4", "IPAM", "Scope"):
            if not empty(field(body, key)):
                raise Denied(f"network {key} is outside the sandbox profile")

    @staticmethod
    def owned_filter(query: dict[str, list[str]]) -> None:
        try:
            filters = json.loads(query.get("filters", ["{}"])[-1])
            labels = filters.get("label", [])
        except (ValueError, AttributeError):
            raise Denied("the list filter is malformed", 400) from None
        if isinstance(labels, dict):
            labels = [key for key, enabled in labels.items() if enabled]
        if "sabre.owner=factory" not in labels:
            raise Denied("lists must be filtered to factory-owned resources")


@dataclass
class Request:
    method: str
    target: str
    headers: list[tuple[str, str]]
    length: int

    @property
    def path(self) -> str:
        return urlsplit(self.target).path

    @property
    def query(self) -> dict[str, list[str]]:
        values = parse_qs(urlsplit(self.target).query, keep_blank_values=True)
        # The daemon reads the first of a repeated parameter; refuse the ambiguity.
        if any(len(value) > 1 for value in values.values()):
            raise Denied("a query parameter is repeated", 400)
        return values


def parse_head(head: bytes) -> Request:
    """Strict HTTP/1.1 request head. Anything two parsers could read differently is refused."""
    if b"\x00" in head or not head.endswith(b"\r\n\r\n") or b"\n" in head.replace(b"\r\n", b"") or b"\r" in head.replace(b"\r\n", b""):
        raise Denied("malformed request", 400)
    try:
        lines = head[:-4].decode("ascii").split("\r\n")
        method, target, version = lines[0].split(" ")
    except ValueError:
        raise Denied("malformed request", 400) from None
    if version not in {"HTTP/1.1", "HTTP/1.0"} or not TOKEN.fullmatch(method) or not target.startswith("/") \
            or any(ord(character) <= 32 or ord(character) == 127 or character in "#\\;" for character in target):
        raise Denied("malformed request", 400)
    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        name, separator, value = line.partition(":")
        if not separator or not TOKEN.fullmatch(name):
            raise Denied("malformed request", 400)
        headers.append((name, value.strip(" \t")))
    names = [name.casefold() for name, _value in headers]
    if "transfer-encoding" in names or names.count("content-length") > 1:
        raise Denied("request bodies must declare one Content-Length", 400)
    length = next((value for name, value in headers if name.casefold() == "content-length"), "0")
    if not re.fullmatch(r"\d{1,12}", length):
        raise Denied("malformed request", 400)
    return Request(method, target, headers, int(length))


def render_head(request: Request, length: int, *, stream: bool = False) -> bytes:
    # Hop-by-hop headers are replaced: the daemon serves this one request and closes. Only an
    # exec start asks for the raw stream the Docker client reads its output from.
    dropped = {"connection", "upgrade", "keep-alive", "content-length", "te", "trailer", "proxy-connection", "expect"}
    lines = [f"{request.method} {request.target} HTTP/1.1"]
    lines += [f"{name}: {value}" for name, value in request.headers if name.casefold() not in dropped]
    lines += [f"Content-Length: {length}", *(["Connection: Upgrade", "Upgrade: tcp"] if stream else ["Connection: close"]), "", ""]
    return "\r\n".join(lines).encode("ascii")


async def read_response_body(reader: asyncio.StreamReader, head: bytes) -> bytes:
    """The bounded body of an ordinary response whose connection the daemon keeps open."""
    lines = head[:-4].split(b"\r\n")
    headers = {name.strip().lower(): value.strip() for name, _, value in (line.partition(b":") for line in lines[1:])}
    if b"chunked" in headers.get(b"transfer-encoding", b"").lower():
        body = bytearray()
        while True:
            size = int((await reader.readline()).split(b";")[0].strip(), 16)
            chunk = await reader.readexactly(size + 2)
            if size == 0:
                return bytes(body)
            body += chunk[:-2]
            if len(body) > MAX_REFUSAL:
                raise Denied("the daemon response is too large", 502)
    length = int(headers.get(b"content-length", b"0"))
    if length > MAX_REFUSAL:
        raise Denied("the daemon response is too large", 502)
    return await reader.readexactly(length)


def dechunk(body: bytes) -> bytes:
    output, position = bytearray(), 0
    while True:
        end = body.index(b"\r\n", position)
        size = int(body[position:end].split(b";")[0], 16)
        if size == 0:
            return bytes(output)
        output += body[end + 2:end + 2 + size]
        position = end + 2 + size + 2


class DockerProxy:
    def __init__(self, policy: Policy, upstream: str, log=None):
        self.policy, self.upstream = policy, upstream
        self.log = log or (lambda record: print(json.dumps(record), file=sys.stderr, flush=True))

    async def lookup(self, path: str) -> tuple[int, Any]:
        """Ask the daemon about one resource. The path is built from a validated identifier."""
        reader, writer = await asyncio.open_unix_connection(self.upstream)
        try:
            writer.write(f"GET {path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n".encode("ascii"))
            await writer.drain()
            raw = bytearray()
            async with asyncio.timeout(HEAD_TIMEOUT):
                while chunk := await reader.read(65536):
                    raw += chunk
                    if len(raw) > MAX_LOOKUP:
                        raise Denied("the daemon response is too large to check", 502)
        finally:
            writer.close()
        head, _, body = bytes(raw).partition(b"\r\n\r\n")
        try:
            status = int(head.split(b" ", 2)[1])
            if b"transfer-encoding: chunked" in head.lower():
                body = dechunk(body)
            return status, json.loads(body) if status == 200 else None
        except (ValueError, IndexError):
            raise Denied("the daemon response could not be checked", 502) from None

    async def _owned_container(self, prefix: str, identifier: str) -> None:
        status, data = await self.lookup(f"{prefix}/containers/{identifier}/json")
        if status == 404:
            raise Denied(f"No such container: {identifier}", 404)
        if status != 200 or not owned(field(field(data, "Config"), "Labels")):
            raise Denied("the container is not factory-owned")

    @staticmethod
    def route(request: Request) -> tuple[str, str, str]:
        """The allowed operation this request names: its kind, the resource and the API version prefix."""
        raw_path = request.path
        if ".." in raw_path or "//" in raw_path:
            raise Denied("the path is not allowed")
        match = VERSION.match(raw_path)
        prefix = match.group(0) if match else ""
        path = raw_path[len(prefix):]
        for methods, pattern, kind in ROUTES:
            found = pattern.fullmatch(path)
            if found and request.method in methods:
                return kind, found.group(1) if found.groups() else "", prefix
        raise Denied("this Docker operation is not available to the executor")

    async def authorize(self, request: Request, kind: str, identifier: str, prefix: str, body: dict | None) -> None:
        """Raise Denied unless the request fits the policy. `body` is set for checked routes."""
        try:
            await self._authorize(request, kind, identifier, prefix, body)
        except (TypeError, AttributeError, KeyError):
            raise Denied("the request is malformed", 400) from None

    async def _authorize(self, request: Request, kind: str, identifier: str, prefix: str, body: dict | None) -> None:
        policy = self.policy
        if kind == "open":
            return
        if kind == "container_create":
            policy.container_create(body or {}, request.query)
        elif kind == "owned_list":
            policy.owned_filter(request.query)
        elif kind == "container":
            await self._owned_container(prefix, identifier)
        elif kind == "exec_create":
            policy.exec_create(body or {})
            await self._owned_container(prefix, identifier)
        elif kind == "exec":
            status, data = await self.lookup(f"{prefix}/exec/{identifier}/json")
            container = field(data, "ContainerID")
            if status == 404:
                raise Denied(f"No such exec instance: {identifier}", 404)
            if status != 200 or not isinstance(container, str) or not re.fullmatch(NAME, container):
                raise Denied("the exec instance could not be attributed")
            await self._owned_container(prefix, container)
        elif kind == "volume_create":
            policy.volume_create(body or {})
        elif kind == "volume_read":
            if not policy.mountable(identifier):
                raise Denied("the volume is not a run workspace or a scanner cache")
        elif kind == "volume_remove":
            if not WORKSPACE_VOLUME.fullmatch(identifier):
                raise Denied("only run workspace volumes can be removed")
            status, data = await self.lookup(f"{prefix}/volumes/{identifier}")
            if status == 404:
                raise Denied(f"No such volume: {identifier}", 404)
            if status != 200 or not owned(field(data, "Labels")):
                raise Denied("the volume is not factory-owned")
        elif kind == "network_create":
            policy.network_create(body or {})
        elif kind in {"network_read", "network_remove"}:
            status, data = await self.lookup(f"{prefix}/networks/{identifier}")
            if status == 404:
                raise Denied(f"No such network: {identifier}", 404)
            name, factory = field(data, "Name"), status == 200 and owned(field(data, "Labels"))
            if kind == "network_read" and not (factory or (status == 200 and name in policy.networks)):
                raise Denied("the network is not a factory network")
            if kind == "network_remove" and not (factory and isinstance(name, str) and BROWSER_NETWORK.fullmatch(name)):
                raise Denied("only per-job browser networks can be removed")
        elif kind == "image_read":
            if unquote(identifier) not in policy.images:
                raise Denied("the image is not one of the configured digest-pinned images")

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        async with asyncio.timeout(HEAD_TIMEOUT):
            try:
                head = await reader.readuntil(b"\r\n\r\n")
            except asyncio.LimitOverrunError:
                raise Denied("the request head is too large", 431) from None
        request = parse_head(head)
        kind, identifier, prefix = self.route(request)
        checked = kind in CHECKED
        body: dict | None = None
        payload = b""
        if checked:
            if request.length > MAX_CHECKED_BODY:
                raise Denied("the request body is too large to check", 413)
            async with asyncio.timeout(HEAD_TIMEOUT):
                body = parse_body(await reader.readexactly(request.length))
            payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        await self.authorize(request, kind, identifier, prefix, body)
        stream = kind == "exec" and request.method == "POST"
        upstream_reader, upstream_writer = await asyncio.open_unix_connection(self.upstream)
        try:
            upstream_writer.write(render_head(request, len(payload) if checked else request.length, stream=stream) + payload)
            remaining = 0 if checked else request.length
            while remaining:
                chunk = await reader.read(min(65536, remaining))
                if not chunk:
                    return
                upstream_writer.write(chunk)
                await upstream_writer.drain()
                remaining -= len(chunk)
            await upstream_writer.drain()
            if stream:
                async with asyncio.timeout(HEAD_TIMEOUT):
                    answer = await upstream_reader.readuntil(b"\r\n\r\n")
                    status = answer.split(b" ", 2)[1:2]
                    if status != [b"101"]:
                        # Not a stream: the daemon would keep this connection open for another
                        # request. Hand the refusal over as one closed response instead.
                        try:
                            refusal = await read_response_body(upstream_reader, answer)
                            code = int(status[0])
                        except (ValueError, IndexError):
                            raise Denied("the daemon response could not be read", 502) from None
                        writer.write(f"HTTP/1.1 {code} Refused\r\nContent-Type: application/json\r\n"
                                     f"Content-Length: {len(refusal)}\r\nConnection: close\r\n\r\n".encode("ascii") + refusal)
                        return
                writer.write(answer)
                await writer.drain()
                # The Docker client reads the stream from the bare socket once it has parsed
                # this head; give it that moment so no output lands in its header buffer.
                await asyncio.sleep(0.01)

            async def respond():
                while chunk := await upstream_reader.read(65536):
                    writer.write(chunk)
                    await writer.drain()

            async def closed():
                # Later bytes from the client are discarded, never forwarded. Its closing ends the call.
                while await reader.read(65536):
                    pass

            response, gone = asyncio.ensure_future(respond()), asyncio.ensure_future(closed())
            try:
                await asyncio.wait({response, gone}, return_when=asyncio.FIRST_COMPLETED)
                if response.done():
                    response.result()
            finally:
                for task in (response, gone):
                    task.cancel()
        finally:
            upstream_writer.close()

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await self.serve(reader, writer)
        except Denied as denial:
            if denial.status == 403:
                self.log({"event": "docker_request_denied", "reason": denial.reason})
            message = json.dumps({"message": denial.reason if denial.status == 404 else f"SABRE Docker policy: {denial.reason}"}).encode()
            reasons = {400: "Bad Request", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large",
                       431: "Request Header Fields Too Large", 502: "Bad Gateway"}
            writer.write(f"HTTP/1.1 {denial.status} {reasons.get(denial.status, 'Error')}\r\nContent-Type: application/json\r\n"
                         f"Content-Length: {len(message)}\r\nConnection: close\r\n\r\n".encode("ascii") + message)
        except (TimeoutError, asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            try:
                await writer.drain()
            except (ConnectionError, OSError):
                pass
            writer.close()


async def main() -> None:
    path = os.environ.get("SABRE_DOCKER_PROXY_SOCKET", "/run/docker-proxy/docker.sock")
    proxy = DockerProxy(Policy.from_environment(), os.environ.get("SABRE_DOCKER_UPSTREAM", "/var/run/docker.sock"))
    if not proxy.policy.images:
        raise SystemExit("DOCKER_PROXY_NOT_CONFIGURED: no digest-pinned SABRE image is configured")
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    server = await asyncio.start_unix_server(proxy.handle, path, limit=MAX_HEAD)
    os.chmod(path, 0o600)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
