import base64
import hashlib
import json

import pytest

from sabre.artifacts import ArtifactStore
from sabre.executor import snapshot_digest
from sabre.models import DomainError
from sabre.project_context import MAX_RESPONSE_BYTES, ProjectContext
from sabre.security import SecretGuard
from sabre.tools import workspace_tools


class Workspace:
    def __init__(self, files):
        self.files = files
        self.base_commit = "a" * 40
        self.snapshots = 0
        self.writes = []

    async def snapshot(self, work_id):
        self.snapshots += 1
        entries = [{"path": path, "content": content, "encoding": "utf-8"} for path, content in self.files.items()]
        return {"files": entries, "digest": snapshot_digest(entries), "base_commit": self.base_commit}

    async def write_file(self, work_id, path, content, *, expected_content_digest=None):
        if hashlib.sha256(self.files[path].encode()).hexdigest() != expected_content_digest:
            from sabre.models import DomainError
            raise DomainError("SOURCE_CONTEXT_STALE", "Changed before writing")
        self.writes.append((path, content))
        self.files[path] = content


async def context(tmp_path, files, *, guard=None, role="developer", instruction="Inspect source", project="project-one"):
    guard = guard or SecretGuard()
    executor = Workspace(files)
    manager = ProjectContext(ArtifactStore(tmp_path, guard), executor, guard)
    view = await manager.for_role(project, "work-one", await executor.snapshot("work-one"), role, instruction)
    return manager, executor, view


def output_size(value):
    return len(json.dumps(value, ensure_ascii=False).encode())


async def test_brief_selects_role_and_task_paths_without_forwarding_source_or_inventing_areas(tmp_path):
    files = {f"src/file-{i:02}.py": "UNIQUE_SOURCE_BODY = True\n" for i in range(45)}
    files.update({"web/package.json": '{"dependencies":{"react":"19.0.0"}}',
                  "backend/pyproject.toml": '[project]\ndependencies=["fastapi==0.162.0"]\n',
                  "infra/compose.yaml": "services: {}\n", "tests/test_calculation.py": "assert True\n"})
    manager, executor, view = await context(tmp_path, files, role="qa", instruction="Verify calculation")
    selected = {file["path"]: file for file in view.brief["files"]}
    assert "tests/test_calculation.py" in selected
    assert selected["web/package.json"]["areas"] == [{"area": "frontend", "basis": "dependency:react", "path": "web/package.json"}]
    assert selected["backend/pyproject.toml"]["areas"][0]["area"] == "backend"
    assert selected["infra/compose.yaml"]["areas"][0]["area"] == "infrastructure"
    assert view.brief["role"] == "qa"
    assert len(selected) <= 40 and view.brief["omitted_files"] == len(files) - len(selected)
    assert "UNIQUE_SOURCE_BODY" not in json.dumps(view.brief)
    assert output_size(view.brief) <= MAX_RESPONSE_BYTES
    other = await manager.for_role("project-one", "work-one", await executor.snapshot("work-one"), "developer", "Change src/file-44.py")
    assert other.brief["files"][0]["path"] == "src/file-44.py"
    assert all(file["areas"] == [] for file in other.brief["files"] if file["path"].startswith("src/"))
    assert all(b"UNIQUE_SOURCE_BODY" not in file.read_bytes() for file in tmp_path.rglob("*") if file.is_file())


async def test_search_and_ranges_use_fresh_snapshot_reject_stale_content_and_drop_deleted_paths(tmp_path):
    manager, executor, view = await context(tmp_path, {"src/app.py": "first\ncalculate(1)\nlast\n"})
    found = await view.search_source("calculate")
    match = found["matches"][0]
    assert match["line"] == 2 and match["path"] == "src/app.py"
    assert match["content_digest"] == hashlib.sha256(b"first\ncalculate(1)\nlast\n").hexdigest()
    read = await view.read_file_range(match["path"], match["content_digest"], 2, 3)
    assert read["content"] == "calculate(1)\nlast\n"
    assert read["project_id"] == "project-one" and read["snapshot_digest"] == found["snapshot_digest"]
    executor.files["src/app.py"] = "calculate(2)\n"
    with pytest.raises(DomainError, match="changed") as stale:
        await view.read_file_range(match["path"], match["content_digest"], 1, 1)
    assert stale.value.code == "SOURCE_CONTEXT_STALE"
    new = await view.search_source("calculate")
    assert new["matches"][0]["preview"] == "calculate(2)"
    assert new["snapshot_digest"] != found["snapshot_digest"]
    executor.files["src/renamed.py"] = executor.files.pop("src/app.py")
    assert [item["path"] for item in (await view.search_source("calculate"))["matches"]] == ["src/renamed.py"]
    with pytest.raises(DomainError) as deleted:
        await view.read_file_range("src/app.py", new["matches"][0]["content_digest"], 1, 1)
    assert deleted.value.code == "SOURCE_NOT_FOUND"
    refreshed = await manager.for_role("project-one", "work-one", await executor.snapshot("work-one"), "reviewer", "Review")
    assert [file["path"] for file in refreshed.brief["files"]] == ["src/renamed.py"]


async def test_patch_brief_is_compact_without_excluding_omitted_files_from_search(tmp_path):
    files = {f"src/file-{i:02}.py": f"value_{i} = True\n" for i in range(30)}
    files["package.json"] = '{"name":"fixture"}'
    manager, executor, _ = await context(tmp_path, files)
    view = await manager.for_role("project-one", "work-one", await executor.snapshot("work-one"),
                                  "supervisor", "Patch src/file-29.py", mode="patch")
    paths = [entry["path"] for entry in view.brief["files"]]
    assert len(paths) == 12
    assert paths[0] == "src/file-29.py" and "package.json" in paths
    assert view.brief["omitted_files"] == len(files) - len(paths)
    omitted = next(path for path in files if path not in paths)
    found = await view.search_source(files[omitted].strip())
    assert found["matches"][0]["path"] == omitted
    match = found["matches"][0]
    assert (await view.read_file_range(omitted, match["content_digest"], 1, 1))["content"] == files[omitted]


async def test_edit_source_changes_exact_occurrences_and_returns_only_metadata(tmp_path):
    original = "before()\r\nkeep()\r\nbefore()\r\n"
    _, executor, view = await context(tmp_path, {"src/app.py": original})
    signature = hashlib.sha256(original.encode()).hexdigest()
    result = await view.edit_source("src/app.py", signature, "before()", "after()", 2)
    expected = "after()\r\nkeep()\r\nafter()\r\n"
    assert executor.files["src/app.py"] == expected
    assert result == {"path": "src/app.py", "previous_content_digest": signature,
        "content_digest": hashlib.sha256(expected.encode()).hexdigest(), "occurrences": 2}
    assert "after()" not in json.dumps(result)
    assert (await view.read_file_range("src/app.py", result["content_digest"], 1, 3))["content"] == expected


@pytest.mark.parametrize(("signature", "old", "new", "count", "code"), [
    ("b" * 64, "before()", "after()", 1, "SOURCE_CONTEXT_STALE"),
    (None, "before()", "after()", 2, "SOURCE_EDIT_COUNT"),
    (None, "missing()", "after()", 1, "SOURCE_EDIT_COUNT"),
    (None, "", "after()", 1, "INVALID_TOOL_ARGUMENTS"),
    (None, "before()", "x" * 12289, 1, "INVALID_TOOL_ARGUMENTS"),
    (None, "before()", "after()", True, "INVALID_TOOL_ARGUMENTS"),
])
async def test_edit_source_rejects_stale_or_ambiguous_changes_without_writing(tmp_path, signature, old, new, count, code):
    original = "before()\n"
    _, executor, view = await context(tmp_path, {"src/app.py": original})
    with pytest.raises(DomainError) as error:
        await view.edit_source("src/app.py", signature or hashlib.sha256(original.encode()).hexdigest(), old, new, count)
    assert error.value.code == code and not executor.writes
    assert executor.files["src/app.py"] == original


async def test_edit_source_guard_checks_new_content_and_broker_stale_rejection_propagates(tmp_path, monkeypatch):
    original, secret = "before()\n", "synthetic-private-edited-value"
    _, executor, view = await context(tmp_path, {"src/app.py": original}, guard=SecretGuard([secret]))
    signature = hashlib.sha256(original.encode()).hexdigest()
    with pytest.raises(DomainError) as guarded:
        await view.edit_source("src/app.py", signature, "before()", secret)
    assert guarded.value.code == "SECRET_DETECTED" and not executor.writes
    write = executor.write_file
    async def concurrent_write(*args, **kwargs):
        executor.files["src/app.py"] = "concurrent()\n"
        await write(*args, **kwargs)
    monkeypatch.setattr(executor, "write_file", concurrent_write)
    with pytest.raises(DomainError) as stale:
        await view.edit_source("src/app.py", signature, "before()", "after()")
    assert stale.value.code == "SOURCE_CONTEXT_STALE"
    assert executor.files["src/app.py"] == "concurrent()\n" and not executor.writes


async def test_restart_reuses_unchanged_indexes_across_commits_and_reindexes_only_changed_file(tmp_path, monkeypatch):
    manager, executor, _ = await context(tmp_path, {"a.py": "before()\n", "b.py": "stable()\n"})
    rebuilt = []
    restarted = ProjectContext(manager.artifacts, executor, manager.guard)
    build = restarted._build_index

    def track(identity, source):
        rebuilt.append((identity["project_id"], source.path))
        return build(identity, source)

    monkeypatch.setattr(restarted, "_build_index", track)
    executor.base_commit = "b" * 40
    snapshot = await executor.snapshot("work-one")
    resumed = await restarted.for_role("project-one", "work-one", snapshot, "reviewer", "Inspect")
    assert rebuilt == [] and resumed.brief["source_commit"] == "b" * 40
    executor.files["a.py"] = "after()\n"
    await resumed.search_source("()")
    assert rebuilt == [("project-one", "a.py")]
    await restarted.for_role("project-two", "work-two", await executor.snapshot("work-two"), "analyst", "Inspect")
    assert rebuilt[1:] == [("project-two", "a.py"), ("project-two", "b.py")]


async def test_cache_reference_recovers_but_corrupt_immutable_artifact_fails_closed(tmp_path):
    manager, executor, view = await context(tmp_path, {"a.py": "run()\n"})
    references = [path for path in (tmp_path / "project-context").rglob("*") if path.is_file()]
    assert len(references) == 1
    reference = references[0]
    original_digest = reference.read_text()
    reference.write_text("broken reference")
    assert (await view.search_source("run"))["matches"][0]["line"] == 1
    assert reference.read_text() == original_digest
    artifact = tmp_path / original_digest[:2] / original_digest
    artifact.write_text("corrupt immutable artifact")
    with pytest.raises(DomainError) as corrupt:
        await view.search_source("run")
    assert corrupt.value.code == "ARTIFACT_CORRUPT"
    assert artifact.read_text() == "corrupt immutable artifact"


async def test_cross_project_reference_cannot_supply_other_projects_navigation(tmp_path):
    manager, executor, view = await context(tmp_path, {"a.py": "run()\n"})
    first = next(path for path in (tmp_path / "project-context").rglob("*") if path.is_file())
    first_artifact = first.read_text()
    await manager.for_role("other-project", "other-work", await executor.snapshot("other-work"), "analyst", "Inspect")
    second = next(path for path in (tmp_path / "project-context").rglob("*") if path.is_file() and path != first)
    first.write_text(second.read_text())
    assert (await view.search_source("run"))["project_id"] == "project-one"
    assert first.read_text() == first_artifact


async def test_cache_rejects_symlinks_without_writing_outside_artifacts(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "artifacts"
    root.mkdir()
    (root / "project-context").symlink_to(outside, target_is_directory=True)
    with pytest.raises(DomainError) as unsafe:
        await context(root, {"a.py": "run()\n"})
    assert unsafe.value.code == "UNSAFE_ARTIFACT_PATH"
    assert list(outside.iterdir()) == []


async def test_snapshot_secret_filter_precedes_cache_and_rechecks_all_files_before_egress(tmp_path):
    secret = "synthetic-source-private-value"
    guard = SecretGuard([secret])
    with pytest.raises(DomainError) as admission:
        await context(tmp_path, {"safe.py": "run()\n", "ignored.txt": secret}, guard=guard)
    assert admission.value.code == "SECRET_DETECTED"
    assert list(tmp_path.iterdir()) == []
    _, executor, view = await context(tmp_path, {"safe.py": "run()\n"}, guard=guard)
    executor.files["ignored.txt"] = secret
    with pytest.raises(DomainError) as egress:
        await view.search_source("run", path_prefix="safe.py")
    assert egress.value.code == "SECRET_DETECTED"
    binary = {"files": [{"path": "opaque.bin", "content": base64.b64encode(secret.encode()).decode(), "encoding": "base64"}], "digest": "a" * 64, "base_commit": "b" * 40}
    with pytest.raises(DomainError) as encoded_secret:
        await view.manager.for_role("project-one", "work-one", binary, "analyst", "Inspect")
    assert encoded_secret.value.code == "SECRET_DETECTED"


async def test_bounded_search_pagination_is_complete_and_cannot_continue_on_a_changed_snapshot(tmp_path):
    _, executor, view = await context(tmp_path, {"a.py": "".join(f"match({i})\n" for i in range(45))})
    first = await view.search_source("match")
    assert len(first["matches"]) == 20 and first["next_offset"] == 20
    second = await view.search_source("match", offset=first["next_offset"], snapshot_digest=first["snapshot_digest"])
    third = await view.search_source("match", offset=second["next_offset"], snapshot_digest=second["snapshot_digest"])
    assert [item["line"] for page in (first, second, third) for item in page["matches"]] == list(range(1, 46))
    assert third["next_offset"] is None and not third["truncated"]
    assert all(output_size(page) <= MAX_RESPONSE_BYTES for page in (first, second, third))
    executor.files["a.py"] = "match changed\n"
    with pytest.raises(DomainError) as stale:
        await view.search_source("match", offset=20, snapshot_digest=first["snapshot_digest"])
    assert stale.value.code == "SOURCE_CONTEXT_STALE"


async def test_unicode_ranges_truncate_at_lines_and_report_nonindexed_files(tmp_path):
    text = ("á" * 1000 + "\n") * 10
    _, _, view = await context(tmp_path, {"a.txt": text, "huge.txt": "x" * 1_048_577})
    found = await view.search_source("á")
    assert found["skipped_files"] == 1
    source = found["matches"][0]
    read = await view.read_file_range("a.txt", source["content_digest"], 1, 10)
    assert output_size(read) <= MAX_RESPONSE_BYTES and read["truncated"]
    assert read["content"] == ("á" * 1000 + "\n") * read["end_line"]
    rest = await view.read_file_range("a.txt", source["content_digest"], read["next_line"], 10)
    assert read["content"] + rest["content"] == text
    with pytest.raises(DomainError) as bad_range:
        await view.read_file_range("a.txt", source["content_digest"], 1, 121)
    assert bad_range.value.code == "INVALID_TOOL_ARGUMENTS"


async def test_navigation_tools_preserve_role_permissions_and_validate_before_snapshot(tmp_path):
    _, executor, view = await context(tmp_path, {"a.py": "run()\n"})
    catalog = workspace_tools(executor, "work-one", source_context=view)
    for role in ("analyst", "architect", "supervisor", "developer", "qa", "reviewer", "security"):
        assert {"search_source", "read_file_range"} <= {tool.name for tool in catalog.for_role(role)}
    assert "write_file" not in {tool.name for tool in catalog.for_role("reviewer")}
    before = executor.snapshots
    for arguments, role in (({"query": "run", "limit": 21}, "analyst"), ({"query": "run"}, "unknown")):
        with pytest.raises(DomainError):
            await catalog.invoke("search_source", arguments, role)
    assert executor.snapshots == before
    assert (await catalog.invoke("search_source", {"query": "run"}, "reviewer"))["matches"][0]["line"] == 1
