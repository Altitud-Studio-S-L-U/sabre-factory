import asyncio
import hashlib
import io
import json
import subprocess
import sys
import tarfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from sabre import executor
from sabre.executor import (
    FILE_HELPER,
    DockerBroker,
    ExecutionResult,
    ExecutorClient,
    github_repository,
    snapshot_digest,
    valid_path,
    valid_work_id,
    validate_node_manifest,
    validate_python_manifest,
)
from sabre.models import DomainError, Project


@pytest.fixture(autouse=True)
def isolated_broker_bootstrap(monkeypatch):
    # Integration checks mount a control identity; broker units must never consume that grant.
    monkeypatch.delenv("SABRE_BOOTSTRAP_FILE", raising=False)


@pytest.mark.parametrize("path", ["../secret", "/etc/passwd", "a/../../b", "C:/owner", "a\\b", ".git/config", "src/.git/config", ""])
def test_workspace_paths_cannot_escape(path):
    with pytest.raises(DomainError):
        valid_path(path)


@pytest.mark.parametrize("repository", ["file:///owner", "https://user:token@github.com/a/b", "https://github.com.evil/a/b", "http://github.com/a/b", "https://github.com/a/b?token=x", "https://github.com/a/../b"])
def test_repository_source_cannot_redirect_credentials_or_read_host(repository):
    with pytest.raises(DomainError):
        github_repository(repository)


def test_valid_repository_and_paths_are_normalized():
    assert github_repository("https://github.com/owner/repository.git") == ("owner", "repository")
    assert valid_path("src/app.py") == "src/app.py"
    with pytest.raises(DomainError):
        valid_work_id("../owner")


def test_container_boundary_has_only_its_workspace_and_no_network(tmp_path):
    observed = []

    def create(**kwargs):
        observed.append(kwargs)

    broker = DockerBroker(tmp_path, SimpleNamespace(containers=SimpleNamespace(create=create)))
    broker._container("sha256:" + "a" * 64, "work-1", ["python", "-m", "unittest"])
    request = observed[0]
    assert request["network_disabled"] is True
    assert request["user"] == "10001:10001"
    assert request["read_only"] is True
    assert request["cap_drop"] == ["ALL"]
    assert request["security_opt"] == ["no-new-privileges:true"]
    assert list(request["volumes"]) == ["sabre-factory-ws-work-1"]
    assert "docker.sock" not in json.dumps(request)
    assert not any("TOKEN" in key or "KEY" in key for key in request["environment"])


def malicious_archive(name, link=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        info = tarfile.TarInfo(name)
        if link:
            info.type, info.linkname = tarfile.SYMTYPE, "/etc/passwd"
            archive.addfile(info)
        else:
            content = b"data"
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


@pytest.mark.parametrize("name,link", [("repo/../../owner", False), ("repo/src/link", True), ("repo/C:/owner", False)])
def test_unsafe_archives_are_rejected_before_volume_creation(tmp_path, name, link):
    broker = DockerBroker(tmp_path, SimpleNamespace())
    with pytest.raises(DomainError):
        broker._install_archive("work", malicious_archive(name, link))
    assert list(tmp_path.iterdir()) == []


def test_broker_requires_its_own_bearer_token(monkeypatch, tmp_path):
    bootstrap = tmp_path / "broker.json"
    bootstrap.write_text(json.dumps({"format": 1, "executor_token": "synthetic-broker-token"}))
    bootstrap.chmod(0o600)
    monkeypatch.setenv("SABRE_BOOTSTRAP_FILE", str(bootstrap))
    client = TestClient(executor.app)
    assert client.get("/health").status_code == 200
    response = client.get("/workspaces/work-1/files")
    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"
    monkeypatch.delenv("SABRE_BOOTSTRAP_FILE")
    assert client.get("/workspaces/work-1/files").status_code == 503


async def test_http_executor_client_propagates_domain_errors_without_invented_success():
    async def handle(request):
        assert request.headers["authorization"] == "Bearer private-broker-token"
        return httpx.Response(409, json={"code": "STALE_SNAPSHOT", "message": "Changed snapshot"})

    client = ExecutorClient("http://executor", "private-broker-token", httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    with pytest.raises(DomainError) as error:
        await client.execute_gate("work-1", ["python", "-m", "unittest"], "a" * 64)
    assert error.value.code == "STALE_SNAPSHOT"
    await client.aclose()


async def test_cleanup_is_idempotent_after_failed_admission_or_a_lost_response(tmp_path, monkeypatch):
    broker = DockerBroker(tmp_path, SimpleNamespace())
    observed = []
    monkeypatch.setattr(broker, "_remove_workspace_volume", lambda work_id: observed.append(work_id))
    await broker.cleanup("work-1")
    await broker.cleanup("work-1")
    assert observed == ["work-1", "work-1"]
    assert list(tmp_path.iterdir()) == []


def test_restore_cleanup_reaps_only_owned_orphan_commands(tmp_path):
    removed = []
    command = SimpleNamespace(attrs={"Config": {"Labels": {"sabre.owner": "factory", "sabre.work_id": "work-1", "sabre.kind": "command"}}}, remove=lambda **kwargs: removed.append(True))

    def absent(name):
        raise executor.docker.errors.NotFound("missing")

    broker = DockerBroker(tmp_path, SimpleNamespace(containers=SimpleNamespace(list=lambda **kwargs: [command], get=absent), volumes=SimpleNamespace(get=absent)))
    broker._remove_workspace_volume("work-1")
    assert removed == [True]
    command.attrs["Config"]["Labels"]["sabre.work_id"] = "other-work"
    with pytest.raises(DomainError) as error:
        broker._remove_workspace_volume("work-1")
    assert error.value.code == "WORKSPACE_OWNERSHIP"
    assert removed == [True]


async def test_workspace_identity_can_be_persisted_without_granting_readers_write_access(tmp_path, monkeypatch):
    broker = DockerBroker(tmp_path, SimpleNamespace())
    observed = []

    def run(image, work_id, command, timeout, **kwargs):
        observed.append(kwargs["readonly_workspace"])
        return ExecutionResult(exit_code=0, output='{"result":true}')

    monkeypatch.setenv("SABRE_HELPER_IMAGE", "sha256:" + "a" * 64)
    monkeypatch.setattr(broker, "_run", run)
    await broker._helper("work", "set_identity", {"identity": "work"})
    await broker._helper("work", "read", {"path": "file.py"})
    assert observed == [False, True]


async def test_internal_snapshot_transport_preserves_bytes_and_does_not_use_redacted_logs(tmp_path, monkeypatch):
    content = "x" * 4_100_000 + "ghp_" + "aA0bB1cC2dD3eE4fF5gG6hH7iI8jJ9kK0lL1"
    files = [{"path": "source.txt", "content": content, "encoding": "utf-8", "executable": False}]
    snapshot = {"files": files, "digest": snapshot_digest(files)}
    serialized = json.dumps({"result": snapshot}).encode()
    removed = []

    def no_logs(**kwargs):
        raise AssertionError("Raw snapshot bytes must not enter the log path")

    container = SimpleNamespace(
        start=lambda: None, exec_run=lambda *args, **kwargs: SimpleNamespace(exit_code=0, output=serialized), logs=no_logs,
        remove=lambda **kwargs: removed.append(True),
    )
    broker = DockerBroker(tmp_path, SimpleNamespace(containers=SimpleNamespace(create=lambda **kwargs: container)))
    monkeypatch.setenv("SABRE_HELPER_IMAGE", "sha256:" + "a" * 64)
    captured = await broker._helper("work", "snapshot")
    assert captured == snapshot
    assert removed == [True]


async def test_gate_uses_fresh_source_and_dependency_environment(tmp_path, monkeypatch):
    gate_volumes = []
    fake_volume = SimpleNamespace(attrs={}, remove=lambda: None)
    fake_docker = SimpleNamespace(volumes=SimpleNamespace(get=lambda name: fake_volume))
    broker = DockerBroker(tmp_path, fake_docker)
    project = Project(name="test", repository="https://github.com/owner/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    broker._metadata_path("work-1").write_text(json.dumps({"project": project.model_dump(mode="json"), "base_commit": "b" * 40}))

    async def helper(work_id, operation, data=None):
        assert work_id == "work-1"
        return {"digest": "a" * 64, "files": []}

    def install(work_id, snapshot):
        assert work_id != "work-1"
        gate_volumes.append(work_id)
        fake_volume.attrs = {"Labels": {"sabre.work_id": work_id}}

    prepared = []

    async def prepare(work_id, meta):
        prepared.append(work_id)

    executed = []

    def run(image, work_id, argv, timeout):
        executed.append(work_id)
        return ExecutionResult(exit_code=0, output="passed")

    monkeypatch.setenv("SABRE_PYTHON_IMAGE", "sha256:" + "f" * 64)
    monkeypatch.setattr(broker, "_helper", helper)
    async def ensure(work_id):
        return broker._metadata(work_id)
    monkeypatch.setattr(broker, "_ensure_workspace", ensure)
    monkeypatch.setattr(broker, "_install_snapshot", install)
    monkeypatch.setattr(broker, "_prepare_dependencies", prepare)
    monkeypatch.setattr(broker, "_run", run)
    monkeypatch.setattr(broker, "_remove_workspace_volume", lambda work_id: None)
    for _ in range(2):
        assert (await broker.execute_gate("work-1", ["python", "-m", "unittest"], "a" * 64)).exit_code == 0
    assert len(set(gate_volumes)) == 2
    assert prepared == executed == gate_volumes
    with pytest.raises(DomainError) as error:
        await broker.execute_gate("work-1", ["python", "-m", "unittest"], "c" * 64)
    assert error.value.code == "STALE_SNAPSHOT"
    assert len(executed) == 2


def run_helper(directory, operation, data=None):
    helper = FILE_HELPER.replace("root = pathlib.Path('/workspace')", f"root = pathlib.Path({str(directory)!r})")
    return subprocess.run([sys.executable, "-I", "-S", "-c", helper, operation, json.dumps(data or {})], capture_output=True, text=True, check=False)  # noqa: S603 - fixed trusted helper, never generated project code


async def test_conditional_write_is_atomic_and_compares_raw_crlf_bytes(tmp_path, monkeypatch):
    original = b"before()\r\n"
    (tmp_path / "app.py").write_bytes(original)
    broker = DockerBroker(tmp_path / "state", SimpleNamespace())
    monkeypatch.setattr(broker, "_ensure_workspace", AsyncMock(return_value={}))
    persist = AsyncMock()
    monkeypatch.setattr(broker, "_persist_workspace", persist)
    async def helper(work_id, operation, data):
        process = run_helper(tmp_path, operation, data)
        assert process.returncode == 0
        result = json.loads(process.stdout)["result"]
        await asyncio.sleep(0)
        return result
    monkeypatch.setattr(broker, "_helper", helper)
    signature = hashlib.sha256(original).hexdigest()
    outcomes = await asyncio.gather(*(broker.write_file("work-1", "app.py", value, expected_content_digest=signature)
        for value in ("first()\r\n", "second()\r\n")), return_exceptions=True)
    assert sum(value is None for value in outcomes) == 1
    assert sum(isinstance(value, DomainError) and value.code == "SOURCE_CONTEXT_STALE" for value in outcomes) == 1
    assert (tmp_path / "app.py").read_bytes() in {b"first()\r\n", b"second()\r\n"}
    persist.assert_awaited_once_with("work-1")
    before = (tmp_path / "app.py").read_bytes()
    with pytest.raises(DomainError):
        await broker.write_file("work-1", "app.py", "lost-update", expected_content_digest=signature)
    assert (tmp_path / "app.py").read_bytes() == before
    await broker.write_file("work-1", "app.py", "legacy write")
    assert (tmp_path / "app.py").read_text() == "legacy write"


async def test_executor_client_preserves_optional_conditional_write_contract():
    client = ExecutorClient("http://executor:8090", "synthetic-client-token")
    client._request = AsyncMock()
    await client.write_file("work-1", "app.py", "new", expected_content_digest="a" * 64)
    assert client._request.await_args.args[2] == {"path": "app.py", "content": "new", "expected_content_digest": "a" * 64}
    await client.write_file("work-1", "app.py", "legacy")
    assert client._request.await_args.args[2] == {"path": "app.py", "content": "legacy"}


def test_helper_snapshots_binary_bytes_modes_and_limits(tmp_path):
    (tmp_path / "binary.bin").write_bytes(b"\x00\xff\x10")
    (tmp_path / "run.py").write_text("print('ok')\n")
    (tmp_path / "run.py").chmod(0o755)
    (tmp_path / ".sabre-workspace-id").write_text("private-metadata")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "cache.js").write_text("untrusted dependency cache")
    result = run_helper(tmp_path, "snapshot")
    assert result.returncode == 0, result.stderr
    snapshot = json.loads(result.stdout)["result"]
    assert snapshot_digest(snapshot["files"]) == snapshot["digest"]
    assert [entry["path"] for entry in snapshot["files"]] == ["binary.bin", "run.py"]
    assert snapshot["files"][0]["encoding"] == "base64"
    assert snapshot["files"][1]["executable"] is True
    (tmp_path / "run.py").chmod(0o644)
    changed = json.loads(run_helper(tmp_path, "snapshot").stdout)["result"]
    assert changed["digest"] != snapshot["digest"]
    (tmp_path / "large").write_bytes(b"x" * 5_000_001)
    assert run_helper(tmp_path, "snapshot").returncode != 0


def test_helper_refuses_symlink_escape_for_reads_and_writes(tmp_path):
    external = tmp_path.parent / "outside.txt"
    external.write_text("do not read")
    (tmp_path / "link").symlink_to(external)
    assert run_helper(tmp_path, "read", {"path": "link"}).returncode != 0
    assert run_helper(tmp_path, "write", {"path": "link", "content": "changed"}).returncode != 0
    assert external.read_text() == "do not read"


def test_helper_rejects_special_files_without_blocking_reads_or_writes(tmp_path):
    import os

    os.mkfifo(tmp_path / "pipe")
    assert run_helper(tmp_path, "read", {"path": "pipe"}).returncode != 0
    assert run_helper(tmp_path, "write", {"path": "pipe", "content": "changed"}).returncode != 0


def test_internal_helper_timeout_terminates_only_its_own_container(tmp_path, monkeypatch):
    killed, removed = [], []
    container = SimpleNamespace(
        start=lambda: None, kill=lambda: killed.append(True),
        exec_run=lambda *args, **kwargs: SimpleNamespace(exit_code=137),
        remove=lambda **kwargs: removed.append(True),
    )

    class ImmediateTimer:
        def __init__(self, seconds, callback):
            self.callback = callback

        def start(self):
            self.callback()

        def cancel(self):
            pass

    monkeypatch.setattr(executor.threading, "Timer", ImmediateTimer)
    broker = DockerBroker(tmp_path, SimpleNamespace(containers=SimpleNamespace(create=lambda **kwargs: container)))
    with pytest.raises(DomainError) as error:
        broker._run("sha256:" + "a" * 64, "work", ["python", "-I"], capture_file="/tmp/sabre-helper-result.json")  # noqa: S108 - private container output
    assert error.value.code == "EXECUTION_TIMEOUT"
    assert killed == removed == [True]


def test_durable_snapshot_is_atomic_and_detects_corruption(tmp_path):
    broker = DockerBroker(tmp_path, SimpleNamespace())
    files = [{"path": "src/app.py", "content": "exact bytes\n", "encoding": "utf-8", "executable": True}]
    data = {"files": files, "digest": snapshot_digest(files)}
    broker._atomic_json(broker._snapshot_path("work"), data)
    assert broker._load_snapshot("work") == data
    assert not list(tmp_path.glob("*.tmp"))
    data["files"][0]["content"] = "modified"
    broker._snapshot_path("work").write_text(json.dumps(data))
    with pytest.raises(DomainError) as error:
        broker._load_snapshot("work")
    assert error.value.code == "WORKSPACE_SNAPSHOT_CORRUPT"


async def test_workspace_restores_durable_bytes_after_memory_volume_loss(tmp_path, monkeypatch):
    import docker

    volumes, contents, identities = {}, {}, {}

    def get_volume(name):
        if name not in volumes:
            raise docker.errors.NotFound("missing")
        return volumes[name]

    fake_docker = SimpleNamespace(volumes=SimpleNamespace(get=get_volume))
    broker = DockerBroker(tmp_path, fake_docker)
    metadata = {"base_commit": "b" * 40, "project": {"profile": "python"}}
    broker._atomic_json(broker._metadata_path("work"), metadata)
    files = [{"path": "binary.bin", "content": "AP8Q", "encoding": "base64", "executable": False}]
    durable = {"files": files, "digest": snapshot_digest(files)}
    broker._atomic_json(broker._snapshot_path("work"), durable)

    def install(work_id, snapshot):
        name = "sabre-factory-ws-" + work_id
        volumes[name] = SimpleNamespace(attrs={"Labels": {"sabre.owner": "factory", "sabre.work_id": work_id}, "Options": {"type": "tmpfs"}})
        contents[work_id] = snapshot

    async def helper(work_id, operation, data=None):
        if operation == "set_identity":
            identities[work_id] = data["identity"]
            return True
        if operation == "identity":
            return identities.get(work_id)
        return contents[work_id]

    monkeypatch.setattr(broker, "_install_snapshot", install)
    monkeypatch.setattr(broker, "_helper", helper)
    assert await broker._ensure_workspace("work") == metadata
    assert contents["work"] == durable
    volumes.clear()
    contents.clear()
    identities.clear()
    assert await broker._ensure_workspace("work") == metadata
    assert contents["work"] == durable


async def test_dependency_manifests_require_immutable_locks(tmp_path, monkeypatch):
    broker = DockerBroker(tmp_path, SimpleNamespace())

    async def helper(work_id, operation, data=None):
        return ["pyproject.toml"]

    monkeypatch.setattr(broker, "_helper", helper)
    with pytest.raises(DomainError) as error:
        await broker._prepare_dependencies("work", {"project": {"profile": "python"}})
    assert error.value.code == "DEPENDENCIES_NOT_LOCKED"


async def test_scanner_process_errors_produce_blocking_findings(tmp_path, monkeypatch):
    broker = DockerBroker(tmp_path, SimpleNamespace())

    async def ensure(work_id):
        return {}

    async def helper(work_id, operation, data=None):
        return {"digest": "a" * 64, "files": []}

    async def broken(work_id, scanner):
        raise DomainError("SCANNER_FAILED", "Unavailable")

    monkeypatch.setattr(broker, "_ensure_workspace", ensure)
    monkeypatch.setattr(broker, "_helper", helper)
    monkeypatch.setattr(broker, "_scanner", broken)
    findings = await broker.scan_snapshot("work", "a" * 64, [])
    assert len(findings) == 3
    assert all(item.category == "scanner_error" for item in findings)


async def test_private_repo_token_is_only_sent_to_github_api(tmp_path, monkeypatch):
    raw = malicious_archive("repo/app.py")
    observed = []

    async def handle(request):
        observed.append(request)
        if "/commits/" in request.url.path:
            return httpx.Response(200, json={"sha": "a" * 40})
        if request.url.host == "api.github.com":
            return httpx.Response(302, headers={"Location": "https://codeload.github.com/owner/project/archive"})
        return httpx.Response(200, content=raw)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(executor.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    async def credential(*args, **kwargs):
        return {"token": "synthetic-github-read-token"}
    monkeypatch.setattr(executor, "fetch_credentials", credential)
    broker = DockerBroker(tmp_path, SimpleNamespace())
    project = Project(name="project", repository="https://github.com/owner/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    data, commit = await broker._github_archive(project)
    assert data == raw and commit == "a" * 40
    assert observed[0].headers["Authorization"] == "Bearer synthetic-github-read-token"
    assert observed[1].headers["Authorization"] == "Bearer synthetic-github-read-token"
    assert "Authorization" not in observed[2].headers


@pytest.mark.parametrize("requirement", ["six>=1.0", "six==1.*", "six @ file:///private", "six @ git+https://github.com/owner/package", "six @ https://example.com/package.whl"])
def test_python_resolution_rejects_unpinned_or_external_sources(requirement):
    manifest = '[project]\nname="test"\nversion="0.1.0"\ndependencies=[' + json.dumps(requirement) + ']\n'
    with pytest.raises(DomainError) as error:
        validate_python_manifest(manifest)
    assert error.value.code == "DEPENDENCY_MANIFEST_NOT_ALLOWED"


@pytest.mark.parametrize("extra", ['dynamic=["dependencies"]', 'dynamic=["version"]', '\n[build-system]\nbackend-path=["."]', '\n[tool.uv.sources]\nsix={path="../outside"}'])
def test_python_resolution_rejects_dynamic_metadata_or_local_backends(extra):
    with pytest.raises(DomainError):
        validate_python_manifest('[project]\nname="test"\nversion="0.1.0"\ndependencies=["six==1.17.0"]\n' + extra)


@pytest.mark.parametrize("version", ["^7.0.0", "file:../private", "git+https://github.com/owner/package", "https://example.com/package.tgz", "latest"])
def test_node_resolution_rejects_unpinned_or_external_sources(version):
    with pytest.raises(DomainError) as error:
        validate_node_manifest(json.dumps({"name": "test", "dependencies": {"is-number": version}}))
    assert error.value.code == "DEPENDENCY_MANIFEST_NOT_ALLOWED"


@pytest.mark.parametrize("field,value", [("scripts", {"postinstall": "run-untrusted-code"}), ("workspaces", ["../private"]), ("overrides", {"pkg": "file:../private"}), ("pnpm", {"pnpmfile": "hook.cjs"})])
def test_node_resolution_rejects_install_hooks_and_alternate_sources(field, value):
    with pytest.raises(DomainError):
        validate_node_manifest(json.dumps({"name": "test", field: value}))


def test_static_exact_manifests_are_accepted_without_executing_project_code():
    validate_python_manifest('[project]\nname="test"\nversion="0.1.0"\ndependencies=["six==1.17.0"]\n')
    assert validate_node_manifest('{"name":"test","dependencies":{"is-number":"7.0.0"},"scripts":{"test":"node --test"}}')["name"] == "test"


async def test_security_database_update_is_a_control_action_with_no_workspace_or_credentials(tmp_path, monkeypatch):
    fake_docker = SimpleNamespace(
        networks=SimpleNamespace(get=lambda name: SimpleNamespace(attrs={"Internal": True})),
        volumes=SimpleNamespace(get=lambda name: SimpleNamespace(attrs={"Labels": {"com.docker.compose.project": "sabre-factory"}})),
    )
    broker = DockerBroker(tmp_path, fake_docker)
    monkeypatch.setenv("SABRE_SECURITY_UPDATE_NETWORK", "sabre-factory_security_updates")
    monkeypatch.setenv("SABRE_SECURITY_UPDATE_PROXY", "http://security-proxy:3128")
    monkeypatch.setenv("SABRE_TRIVY_DB_VOLUME", "sabre-factory-trivy-cache")
    monkeypatch.setenv("SABRE_TRIVY_IMAGE", "sha256:" + "a" * 64)
    monkeypatch.setenv("SABRE_HELPER_IMAGE", "sha256:" + "b" * 64)
    calls = []

    def run(image, work_id, argv, timeout, **kwargs):
        calls.append((argv, kwargs))
        output = "updated" if len(calls) == 1 else json.dumps({"updated_at": "2026-11-05T00:00:00Z", "age_seconds": 60, "digest": "c" * 64})
        return ExecutionResult(exit_code=0, output=output)

    monkeypatch.setattr(broker, "_run", run)
    assert (await broker.refresh_security_database())["digest"] == "c" * 64
    assert all(not kwargs["include_workspace"] for _, kwargs in calls)
    assert calls[0][1]["user"] == "0:0"
    assert calls[0][1]["network"] == "sabre-factory_security_updates"
    assert calls[0][1]["extra_volumes"] == {"sabre-factory-trivy-cache": {"bind": "/cache", "mode": "rw"}}
    assert "--db-repository" in calls[0][0]
    assert not any("TOKEN" in name or "KEY" in name for name in calls[0][1]["environment"])


async def test_security_update_cannot_use_a_general_egress_network(tmp_path, monkeypatch):
    fake_docker = SimpleNamespace(networks=SimpleNamespace(get=lambda name: SimpleNamespace(attrs={"Internal": False})))
    broker = DockerBroker(tmp_path, fake_docker)
    monkeypatch.setenv("SABRE_SECURITY_UPDATE_NETWORK", "bridge")
    monkeypatch.setenv("SABRE_SECURITY_UPDATE_PROXY", "http://security-proxy:3128")
    with pytest.raises(DomainError) as error:
        await broker.refresh_security_database()
    assert error.value.code == "SECURITY_UPDATE_NETWORK_UNSAFE"


async def test_admission_that_finds_a_possible_secret_says_where_and_keeps_no_workspace(tmp_path, monkeypatch):
    broker = DockerBroker(tmp_path, SimpleNamespace())
    project = Project(name="project", repository="https://github.com/owner/project", profile="node", gate_commands=[["npm", "test"]])
    secret = "0123456789ABCDEF" * 2
    removed = []

    async def archive(_project):
        return b"archive", "c" * 40

    async def scanner(work_id, name):
        assert name == "gitleaks"
        return [{"File": "/workspace/test/client.test.ts", "RuleID": "generic-api-key", "StartLine": 14, "Secret": secret, "Match": f"key = '{secret}'"}]

    monkeypatch.setattr(broker, "_github_archive", archive)
    monkeypatch.setattr(broker, "_install_archive", lambda work_id, raw: None)
    monkeypatch.setattr(broker, "_scanner", scanner)
    monkeypatch.setattr(broker, "_remove_workspace_volume", removed.append)
    with pytest.raises(DomainError) as error:
        await broker.prepare(project, "work-1")
    assert error.value.code == "SECRET_DETECTED"
    assert "Found at: test/client.test.ts line 14 (generic-api-key)." in error.value.message
    assert "content will not be sent to agents" in error.value.message and secret not in error.value.message
    assert removed == ["work-1"] and not broker._metadata_path("work-1").exists()
