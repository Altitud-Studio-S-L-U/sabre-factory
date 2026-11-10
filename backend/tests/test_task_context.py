import json

import pytest

from sabre.models import DomainError, Status, Task
from sabre.security import SecretGuard
from sabre.workflows import MAX_TASK_CONTEXT_BYTES, source_index, task_context
from tests.test_memory_budget import fixture_work


def snapshot(files=None, commit="a" * 40):
    return {"base_commit": commit, "digest": "b" * 64,
            "files": [{"path": path, "content": content, "encoding": "utf-8"} for path, content in (files or {"src/main.py": "before()"}).items()]}


def test_task_context_includes_only_completed_direct_dependencies_and_verified_delta():
    _, work = fixture_work()
    prior = Task(title="Implement parser", status=Status.COMPLETED, result="Changed src/main.py; tests claimed by the agent")
    unrelated = Task(title="Unrelated", status=Status.COMPLETED, result="UNRELATED_SUMMARY")
    pending = Task(title="Pending", result="UNFINISHED_SUMMARY")
    current = Task(title="Consume parser", depends_on=[prior.id, pending.id])
    work.tasks = [prior, unrelated, pending, current]
    baseline = source_index(work, snapshot({"src/main.py": "before()", "removed.py": "old()"}))
    source = snapshot({"src/main.py": "after()", "new.py": "new()"})
    value = task_context(work, source, "developer", SecretGuard(), task=current, baseline=baseline)
    assert [item["task_id"] for item in value["dependencies"]] == [prior.id]
    assert "UNRELATED_SUMMARY" not in json.dumps(value) and "UNFINISHED_SUMMARY" not in json.dumps(value)
    assert value["task_id"] == current.id and value["untrusted"]
    assert value["delta_available"] and value["omitted_changed_paths"] == 0
    assert {item["path"]: item["change"] for item in value["changed_paths"]} == {"src/main.py": "modified", "new.py": "added", "removed.py": "deleted"}
    assert next(item for item in value["changed_paths"] if item["change"] == "deleted")["content_digest"] is None
    assert "before()" not in json.dumps(value) and "after()" not in json.dumps(value)


@pytest.mark.parametrize("mismatch", [None, "project_id", "work_id", "plan_revision", "source_commit"])
def test_legacy_or_other_scope_index_cannot_invent_a_delta(mismatch):
    _, work = fixture_work()
    source = snapshot()
    baseline = source_index(work, source) if mismatch else None
    if baseline:
        baseline[mismatch] = "different"
    value = task_context(work, source, "reviewer", SecretGuard(), baseline=baseline)
    assert not value["delta_available"] and value["changed_paths"] == []
    assert value["base_snapshot_digest"] is None


def test_review_context_is_bounded_explicitly_incomplete_and_does_not_promote_task_claims():
    _, work = fixture_work()
    work.tasks = [Task(title=f"Task {index}", status=Status.COMPLETED, result="claimed-pass " + "\x01雪" * 2000) for index in range(15)]
    baseline = source_index(work, snapshot({f"src/file-{index}.py": "old()" for index in range(50)}))
    value = task_context(work, snapshot({f"src/file-{index}.py": "new()" for index in range(50)}), "qa", SecretGuard(), baseline=baseline)
    assert len(json.dumps(value, ensure_ascii=False).encode()) <= MAX_TASK_CONTEXT_BYTES
    assert value["omitted_dependencies"] > 0 and value["omitted_changed_paths"] > 0
    assert all(item["summary_truncated"] for item in value["dependencies"])
    assert "not passed gates or approvals" in value["usage"]
    assert all("exit_code" not in item and "passed" not in item for item in value["dependencies"])


def test_task_context_guards_omitted_summary_and_tracks_mode_only_change():
    _, work = fixture_work()
    secret = "synthetic-private-task-summary"
    work.tasks = [Task(title="Dependency", status=Status.COMPLETED, result="x" * 4000 + secret)]
    source = snapshot()
    with pytest.raises(DomainError) as error:
        task_context(work, source, "reviewer", SecretGuard([secret]))
    assert error.value.code == "SECRET_DETECTED"
    work.tasks = []
    baseline = source_index(work, source)
    source["files"][0]["executable"] = True
    result = task_context(work, source, "reviewer", SecretGuard(), baseline=baseline)
    assert result["changed_paths"][0]["change"] == "modified"
