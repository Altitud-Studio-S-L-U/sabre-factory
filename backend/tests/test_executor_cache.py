"""Reads come from the verified snapshot without a helper container, and never from a stale one."""

from types import SimpleNamespace

import pytest

from sabre.executor import DockerBroker, snapshot_digest
from sabre.models import DomainError


def files(**contents):
    return [{"path": path.replace("__", "/"), "content": content, "encoding": "utf-8", "executable": False} for path, content in contents.items()]


class Helper:
    """A fake helper container: counts calls and serves a mutable workspace."""

    def __init__(self, workspace):
        self.workspace, self.calls = workspace, []

    async def __call__(self, work_id, operation, data=None):
        self.calls.append(operation)
        if operation == "identity":
            return work_id
        if operation == "set_identity":
            return True
        if operation == "list":
            return sorted(self.workspace)
        if operation == "read":
            if data["path"] not in self.workspace:
                raise DomainError("WORKSPACE_IO_FAILED", "The workspace operation failed: FileNotFoundError (exit 2)", 422)
            return self.workspace[data["path"]]
        if operation == "write":
            self.workspace[data["path"]] = data["content"]
            return True
        if operation == "snapshot":
            entries = files(**{path.replace("/", "__"): content for path, content in sorted(self.workspace.items())})
            return {"files": entries, "digest": snapshot_digest(entries)}
        raise AssertionError(operation)


@pytest.fixture(autouse=True)
def isolated_broker_bootstrap(monkeypatch):
    # Integration checks mount a control identity; broker units must never consume that grant.
    monkeypatch.delenv("SABRE_BOOTSTRAP_FILE", raising=False)


@pytest.fixture
def broker(tmp_path, monkeypatch):
    value = DockerBroker(tmp_path, SimpleNamespace())
    value._atomic_json(value._metadata_path("work"), {"base_commit": "b" * 40, "project": {"profile": "python"}})
    helper = Helper({"app.py": "print('ok')\n", "src/util.py": "x = 1\n"})
    monkeypatch.setattr(value, "_helper", helper)

    async def ensure(work_id):
        return {"base_commit": "b" * 40, "project": {"profile": "python"}}

    monkeypatch.setattr(value, "_ensure_workspace", ensure)
    return value, helper


async def test_reads_listings_and_snapshots_after_a_persist_use_no_helper_container(broker):
    value, helper = broker
    persisted = await value._persist_workspace("work")
    helper.calls.clear()
    assert await value.read_file("work", "./app.py") == "print('ok')\n"
    assert await value.list_files("work") == ["app.py", "src/util.py"]
    snapshot = await value.snapshot("work")
    assert snapshot["digest"] == persisted["digest"] and snapshot["base_commit"] == "b" * 40
    snapshot["files"][0]["content"] = "mutated by caller"
    assert await value.read_file("work", "app.py") == "print('ok')\n"
    assert helper.calls == []


async def test_a_write_refreshes_the_snapshot_and_conditional_writes_compare_cached_digests(broker):
    import hashlib

    value, helper = broker
    await value._persist_workspace("work")
    digest = hashlib.sha256(b"print('ok')\n").hexdigest()
    helper.calls.clear()
    await value.write_file("work", "app.py", "print('fixed')\n", expected_content_digest=digest)
    assert "digest" not in helper.calls and "write" in helper.calls
    helper.calls.clear()
    assert await value.read_file("work", "app.py") == "print('fixed')\n"
    assert helper.calls == []
    with pytest.raises(DomainError) as error:
        await value.write_file("work", "app.py", "lost update", expected_content_digest=digest)
    assert error.value.code == "SOURCE_CONTEXT_STALE"


async def test_a_failed_persist_leaves_no_cached_view(broker, monkeypatch):
    value, helper = broker
    await value._persist_workspace("work")

    async def broken(work_id):
        raise DomainError("WORKSPACE_SNAPSHOT_FAILED", "Could not save the tool result; the run is blocked")

    monkeypatch.setattr(value, "_persist_workspace", broken)
    with pytest.raises(DomainError):
        await value.write_file("work", "app.py", "changed\n")
    helper.calls.clear()
    assert await value.read_file("work", "app.py") == "changed\n"
    assert helper.calls == ["read"]


async def test_paths_outside_the_snapshot_and_binary_files_still_go_through_the_helper(broker):
    value, helper = broker
    await value._persist_workspace("work")
    value.current["work"]["index"]["blob.bin"] = {"path": "blob.bin", "content": "AP8=", "encoding": "base64", "executable": False}
    helper.workspace["node_modules/pkg/index.js"] = "module.exports = 1\n"
    helper.calls.clear()
    assert await value.read_file("work", "node_modules/pkg/index.js") == "module.exports = 1\n"
    with pytest.raises(DomainError):
        await value.read_file("work", "blob.bin")
    assert helper.calls == ["read", "read"]
    with pytest.raises(DomainError) as error:
        await value.read_file("work", "../escape.py")
    assert error.value.code == "UNSAFE_PATH"


async def test_cleanup_and_a_broker_restart_forget_the_cached_view(broker, tmp_path, monkeypatch):
    value, helper = broker
    await value._persist_workspace("work")
    restarted = DockerBroker(tmp_path, SimpleNamespace())
    assert restarted.current == {}
    monkeypatch.setattr(value, "_remove_workspace_volume", lambda work_id: None)
    monkeypatch.setattr(value.browser_runner, "cleanup_orphans", lambda work_id: None)
    await value.cleanup("work")
    assert "work" not in value.current
