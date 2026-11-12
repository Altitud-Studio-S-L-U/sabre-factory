"""Memory validity, links and recall log against PostgreSQL."""

import hashlib

import pytest
from psycopg.types.json import Jsonb

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.memory import MemoryService
from sabre.memory_contracts import MemoryCarryForward
from sabre.models import DeliveryEvidence, DomainError, MemoryCreate, Status
from sabre.project_context import INDEX_VERSION
from sabre.security import SecretGuard

A, B, C, D, E = ("a" * 40, "b" * 40, "c" * 40, "d" * 40, "e" * 40)


async def index(repo, project_id, commit, files):
    data = {"files": [{"path": path, "content_digest": value} for path, value in files.items()]}
    async with repo.connection() as conn:
        await conn.execute("INSERT INTO repository_indexes(project_id,source_commit,index_version,data) VALUES(%s,%s,%s,%s)",
                           (project_id, commit, INDEX_VERSION, Jsonb(data)))


async def delivered(repository, commit=A):
    repo, project, work = await fixture_work(repository)
    work.status = Status.COMPLETED
    work.evidence = DeliveryEvidence(commit=commit, snapshot_digest="f" * 64, profile_digest="c" * 64,
                                     rules_version="test", gates=[], findings=[], review="Reviewed")
    await repo.save(work)
    return repo, project, work


def proposal(project, work, content, **values):
    return MemoryCreate(project_id=project.id, kind="lesson", content=content, source_commit=work.evidence.commit, source_work_id=work.id, **values)


async def test_project_memory_carries_while_cited_files_are_unchanged(repository):
    repo, project, work = await delivered(repository)
    service = MemoryService(repo, SecretGuard())
    await index(repo, project.id, A, {"src/app.py": "1" * 64, "src/util.py": "2" * 64})
    await index(repo, project.id, B, {"src/app.py": "1" * 64, "src/util.py": "3" * 64})
    await index(repo, project.id, C, {"src/app.py": "9" * 64})
    await index(repo, project.id, D, {"src/application.py": "1" * 64})
    cited = await service.propose(proposal(project, work, "Parser keeps empty input stable", scope="project", citations=["src/app.py#L3"]))
    loose = await service.propose(proposal(project, work, "Parser release notes stay in English", scope="project"))
    pinned = await service.propose(proposal(project, work, "Parser snapshot was audited at this commit"))
    for item in (cited, loose, pinned):
        await service.update(item.id, True)

    def found(results):
        return {item.content for item in results}

    assert found(await repo.search_memory(project.id, "Parser", A)) == {cited.content, loose.content, pinned.content}
    # B changed an uncited file only; the commit-scoped memory still needs its exact commit.
    assert found(await repo.search_memory(project.id, "Parser", B)) == {cited.content, loose.content}
    assert found(await repo.search_memory(project.id, "Parser", C)) == {loose.content}
    assert found(await repo.search_memory(project.id, "Parser", D)) == {loose.content}
    # E has no index: nothing is guessed, so even uncited project memories wait for indexing.
    assert found(await repo.search_memory(project.id, "Parser", E)) == set()
    assert not await repo.ensure_memory_validity(project.id, E)
    history = {row["commit"]: row for row in await repo.memory_validity_history(cited.id)}
    assert history[B]["state"] == "valid" and history[B]["basis"] == "citations_unchanged"
    assert history[C]["changed_paths"] == [{"path": "src/app.py", "change": "changed"}]
    assert history[D]["changed_paths"] == [{"path": "src/app.py", "change": "deleted"}]
    assert E not in history
    with pytest.raises(DomainError) as unavailable:
        await repo.memory_for_context(project.id, C, cited.id)
    assert unavailable.value.code == "MEMORY_NOT_AVAILABLE"
    reference = {"id": cited.id, "content_digest": hashlib.sha256(cited.content.encode()).hexdigest(), "source_commit": A}
    await service.context_validator(project.id, B)([reference])
    with pytest.raises(DomainError) as refused:
        await service.context_validator(project.id, C)([reference])
    assert refused.value.code == "MEMORY_CONTEXT_CHANGED"

    carried = await service.carry_forward(cited.id, MemoryCarryForward(commit=C))
    assert carried.state == "valid" and carried.basis == "owner" and carried.changed_paths[0].path == "src/app.py"
    assert (await service.carry_forward(cited.id, MemoryCarryForward(commit=C))).basis == "owner"
    assert found(await repo.search_memory(project.id, "Parser", C)) == {cited.content, loose.content}
    await service.context_validator(project.id, C)([reference])
    with pytest.raises(DomainError) as missing:
        await service.carry_forward(cited.id, MemoryCarryForward(commit=E))
    assert missing.value.code == "MEMORY_INDEX_MISSING"
    with pytest.raises(DomainError) as commit_scoped:
        await service.carry_forward(pinned.id, MemoryCarryForward(commit=B))
    assert commit_scoped.value.code == "MEMORY_NOT_CARRYABLE"

    # Invalidation stays final and wins over every validity record.
    await service.update(cited.id, False)
    assert found(await repo.search_memory(project.id, "Parser", C)) == {loose.content}
    with pytest.raises(DomainError) as final:
        await service.carry_forward(cited.id, MemoryCarryForward(commit=B))
    assert final.value.code == "MEMORY_INVALIDATED"
    with pytest.raises(DomainError):
        await service.context_validator(project.id, C)([reference])


async def test_validity_and_recall_never_cross_projects(repository):
    repo, project, work = await delivered(repository)
    other_repo, other, _ = await delivered(repository)
    service = MemoryService(repo, SecretGuard())
    await index(repo, project.id, A, {"src/app.py": "1" * 64})
    await index(repo, project.id, B, {"src/app.py": "1" * 64})
    await index(repo, other.id, B, {"src/app.py": "1" * 64})
    item = await service.propose(proposal(project, work, "Isolation keeps memories private", scope="project", citations=["src/app.py"]))
    await service.update(item.id, True)
    assert len(await repo.search_memory(project.id, "Isolation", B)) == 1
    assert await repo.search_memory(other.id, "Isolation", B) == []
    assert not await repo.has_embedded_memory(other.id, B)
    with pytest.raises(DomainError) as hidden:
        await repo.memory_for_context(other.id, B, item.id)
    assert hidden.value.code == "MEMORY_NOT_AVAILABLE"
    async with repo.connection() as conn:
        rows = await (await conn.execute("SELECT count(*) n FROM memory_validity WHERE project_id=%s", (other.id,))).fetchone()
    assert rows["n"] == 0


async def test_citations_are_checked_against_the_source_index(repository):
    repo, project, work = await delivered(repository)
    service = MemoryService(repo, SecretGuard())
    with pytest.raises(DomainError) as unindexed:
        await service.propose(proposal(project, work, "Cites before indexing", citations=["src/app.py"]))
    assert unindexed.value.code == "MEMORY_INDEX_MISSING"
    await index(repo, project.id, A, {"src/app.py": "1" * 64})
    with pytest.raises(DomainError) as unknown:
        await service.propose(proposal(project, work, "Cites an unknown file", citations=["src/missing.py"]))
    assert unknown.value.code == "MEMORY_CITATION_UNKNOWN"
    async with repo.connection() as conn:
        count = await (await conn.execute("SELECT count(*) n FROM memories WHERE project_id=%s", (project.id,))).fetchone()
    assert count["n"] == 0
    item = await service.propose(proposal(project, work, "Cites a known file", citations=["src/app.py#L7", "src/app.py#L2"]))
    async with repo.connection() as conn:
        link = await (await conn.execute("SELECT kind,target_type,target_id,attrs FROM memory_links WHERE source_id=%s", (item.id,))).fetchone()
    assert (link["kind"], link["target_type"], link["target_id"]) == ("cites", "file", "src/app.py")
    assert link["attrs"] == {"digest": "1" * 64, "lines": [2, 7], "commit": A}
