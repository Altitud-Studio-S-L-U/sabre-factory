import hashlib

import pytest

from sabre.artifacts import ArtifactStore
from sabre.executor import snapshot_digest
from sabre.models import DomainError
from sabre.project_context import ProjectContext
from sabre.repository_ingestion import build_index
from sabre.security import SecretGuard


def snapshot(files, commit="a" * 40):
    entries = [{"path": path, "content": content, "encoding": "utf-8"} for path, content in files.items()]
    return {"files": entries, "digest": snapshot_digest(entries), "base_commit": commit}


def test_index_preserves_provenance_and_recognized_evidence_without_source_payloads(tmp_path):
    context = ProjectContext(ArtifactStore(tmp_path), None, SecretGuard())
    source = snapshot({"web/package.json": '{"dependencies":{"react":"19.0.0"}}', "src/app.py": "UNIQUE_SOURCE_PAYLOAD = 1\n"})
    result = build_index(context, "project-one", source)
    assert result.project_id == "project-one" and result.source_commit == "a" * 40
    assert result.snapshot_digest == source["digest"] and result.untrusted
    assert result.files[1].areas[0].area == "frontend"
    assert result.files[0].content_digest == hashlib.sha256(b"UNIQUE_SOURCE_PAYLOAD = 1\n").hexdigest()
    assert "UNIQUE_SOURCE_PAYLOAD" not in result.model_dump_json()
    assert all(item.validator == "bounded_source_index_v1" for item in result.files)


def test_changed_deleted_and_renamed_paths_are_reconciled_without_reusing_stale_facts(tmp_path):
    context = ProjectContext(ArtifactStore(tmp_path), None, SecretGuard())
    first = build_index(context, "project-one", snapshot({"src/old.py": "one\n", "src/change.py": "old\n"}))
    second = build_index(context, "project-one", snapshot({"src/new.py": "one\n", "src/change.py": "new\n"}, "b" * 40), first)
    assert second.changes.added == ["src/new.py"]
    assert second.changes.changed == ["src/change.py"]
    assert second.changes.deleted == ["src/old.py"]
    assert second.previous_commit == first.source_commit
    assert "src/old.py" not in {item.path for item in second.files}
    assert first.files[1].path == "src/old.py"


@pytest.mark.parametrize("path", ["../private", "/absolute", "src/../secret", "src\\bad.py"])
def test_index_rejects_unsafe_source_paths_before_retention(tmp_path, path):
    context = ProjectContext(ArtifactStore(tmp_path), None, SecretGuard())
    with pytest.raises(DomainError) as error:
        build_index(context, "project-one", {"files": [{"path": path, "content": "source"}], "digest": "d" * 64, "base_commit": "a" * 40})
    assert error.value.code == "INVALID_SOURCE_PATH"
    assert not list(tmp_path.iterdir())


def test_secret_guard_rejects_snapshot_before_any_index_artifact(tmp_path):
    context = ProjectContext(ArtifactStore(tmp_path), None, SecretGuard())
    private = "ghp_" + "a" * 30
    with pytest.raises(DomainError):
        build_index(context, "project-one", snapshot({"src/app.py": private}))
    assert not list(tmp_path.iterdir())


def test_index_bound_omits_excess_files_and_never_claims_them_indexed(tmp_path, monkeypatch):
    monkeypatch.setattr("sabre.repository_ingestion.MAX_INDEX_FILES", 2)
    context = ProjectContext(ArtifactStore(tmp_path), None, SecretGuard())
    result = build_index(context, "project-one", snapshot({f"file-{number}.py": "text\n" for number in range(5)}))
    assert len(result.files) == 2 and result.total_files == 5 and result.omitted_files == 3
    oversized = build_index(context, "project-one", snapshot({"large.py": "x" * 1_048_577}))
    assert oversized.files[0].lines is None and not oversized.files[0].indexable


def test_reconciliation_rejects_another_project_and_does_not_delete_files_outside_new_selection(tmp_path, monkeypatch):
    monkeypatch.setattr("sabre.repository_ingestion.MAX_INDEX_FILES", 2)
    context = ProjectContext(ArtifactStore(tmp_path), None, SecretGuard())
    first = build_index(context, "project-one", snapshot({"b.py": "text", "c.py": "text"}))
    second = build_index(context, "project-one", snapshot({"a.py": "text", "b.py": "text", "c.py": "text"}, "b" * 40), first)
    assert second.changes.deleted == []
    with pytest.raises(DomainError) as mismatch:
        build_index(context, "project-two", snapshot({"other.py": "source"}), first)
    assert mismatch.value.code == "INGESTION_PROJECT_MISMATCH"
