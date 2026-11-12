import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from sabre.memory import MemoryService, verified_fact
from sabre.memory_store import cited_paths, evaluate
from sabre.models import (
    Budget,
    DeliveryEvidence,
    DomainError,
    MemoryCreate,
    MemoryItem,
    Status,
    WorkOrder,
    memory_identity,
)
from sabre.repository import digest
from sabre.security import SecretGuard

SOURCE, LATER = "a" * 40, "c" * 40


def test_unchanged_citations_carry_and_changed_or_deleted_files_go_stale():
    baseline = {"src/app.py": "1" * 64, "src/util.py": "2" * 64}
    assert evaluate(baseline, dict(baseline)) == {"state": "valid", "basis": "citations_unchanged", "changed_paths": [], "digests": baseline}
    assert evaluate({}, {"src/app.py": "1" * 64})["basis"] == "no_citations"
    changed = evaluate(baseline, {"src/app.py": "9" * 64, "src/util.py": "2" * 64})
    assert changed["state"] == "stale" and changed["changed_paths"] == [{"path": "src/app.py", "change": "changed"}]
    # A rename is a deletion at the cited path; the new path is not assumed to hold the same knowledge.
    renamed = evaluate(baseline, {"src/application.py": "1" * 64, "src/util.py": "2" * 64})
    assert renamed["state"] == "stale" and renamed["changed_paths"] == [{"path": "src/app.py", "change": "deleted"}]
    assert renamed["digests"] == {"src/app.py": None, "src/util.py": "2" * 64}


@pytest.mark.parametrize("citation", ["/etc/passwd", "../outside.py", "src/../x.py", "src\\app.py", "", "src//app.py", "app.py#L0", "app.py#Lx", "a\x00b"])
def test_unsafe_citations_are_rejected(citation):
    with pytest.raises(ValidationError):
        MemoryCreate(project_id="p", kind="lesson", content="Lesson", source_commit=SOURCE, source_work_id="w", citations=[citation])


def test_citation_lines_group_by_path():
    request = MemoryCreate(project_id="p", kind="lesson", content="Lesson", source_commit=SOURCE, source_work_id="w",
                           citations=["src/app.py#L4", "src/app.py", "src/app.py#L2", "src/app.py#L4"])
    assert cited_paths(request.citations) == {"src/app.py": [4, 2]}


def test_identity_of_a_legacy_shaped_proposal_is_unchanged():
    legacy = {"project_id": "p", "kind": "lesson", "content": "Lesson", "source_commit": SOURCE, "source_work_id": "w", "evidence_digest": None}
    request = MemoryCreate(**legacy)
    assert digest(memory_identity(request)) == digest(legacy)
    assert digest(memory_identity(request.model_copy(update={"scope": "project"}))) != digest(legacy)


def delivered_work():
    work = WorkOrder(project_id="project-one", mode="patch", objective="Correct parser behavior", acceptance=["Correct output"], budget=Budget(max_cost_usd=1), idempotency_key="validity")
    work.status = Status.COMPLETED
    work.evidence = DeliveryEvidence(commit=SOURCE, snapshot_digest="b" * 64, profile_digest="c" * 64, rules_version="fixture", gates=[], findings=[], review="Reviewed")
    return work


def test_verified_fact_is_english():
    assert verified_fact(delivered_work()) == f"Commit {SOURCE}: 0 checks passed; snapshot {'b' * 64}."


@pytest.mark.parametrize("update", [{"scope": "project"}, {"citations": ["src/app.py"]}, {"supersedes": "older"}])
async def test_only_the_plain_commit_scoped_template_fact_activates_itself(update):
    work = delivered_work()
    repository = SimpleNamespace(work=AsyncMock(return_value=work), create_memory=AsyncMock(side_effect=lambda item, embedding: item))
    request = MemoryCreate(project_id=work.project_id, kind="fact", content=verified_fact(work), source_commit=SOURCE,
                           source_work_id=work.id, evidence_digest=work.evidence.snapshot_digest)
    service = MemoryService(repository, SecretGuard())
    assert (await service.propose(request)).active
    assert not (await service.propose(request.model_copy(update=update))).active


def stored(scope, source=SOURCE):
    return MemoryItem(id="memory-1", project_id="project-one", kind="lesson", content="Keep empty input", source_commit=source,
                      source_work_id="work", scope=scope, active=True)


def reference(item):
    return {"id": item.id, "project_id": item.project_id, "source_commit": item.source_commit,
            "content_digest": hashlib.sha256(item.content.encode()).hexdigest()}


async def test_validator_accepts_a_project_memory_the_repository_finds_valid_at_a_later_commit():
    item = stored("project")
    repository = SimpleNamespace(memory_for_context=AsyncMock(return_value=item))
    await MemoryService(repository, SecretGuard()).context_validator("project-one", LATER)([reference(item)])
    repository.memory_for_context.assert_awaited_once_with("project-one", LATER, item.id)


@pytest.mark.parametrize("change", ["commit_scope", "other_source", "stale"])
async def test_validator_refuses_commit_scoped_moved_or_stale_memories(change):
    item = stored("commit" if change == "commit_scope" else "project")
    ref = reference(item)
    repository = SimpleNamespace(memory_for_context=AsyncMock(return_value=item))
    if change == "other_source":
        ref["source_commit"] = "d" * 40
    if change == "stale":
        repository.memory_for_context.side_effect = DomainError("MEMORY_NOT_AVAILABLE", "Not valid here", 404)
    with pytest.raises(DomainError) as error:
        await MemoryService(repository, SecretGuard()).context_validator("project-one", LATER)([ref])
    assert error.value.code == "MEMORY_CONTEXT_CHANGED"
