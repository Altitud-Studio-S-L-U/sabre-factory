"""Memory validity, links and recall log against PostgreSQL."""

import hashlib

import pytest
from psycopg.types.json import Jsonb

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.memory import MemoryService
from sabre.memory_contracts import MemoryApproval, MemoryCarryForward
from sabre.models import DeliveryEvidence, DomainError, MemoryCreate, ProposedBy, Status
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


async def test_supersession_invalidates_on_approval_and_graph_stays_bounded(repository):
    repo, project, work = await delivered(repository)
    _, other, other_work = await delivered(repository)
    service = MemoryService(repo, SecretGuard())
    await index(repo, project.id, A, {"src/app.py": "1" * 64})
    older = await service.update((await service.propose(proposal(project, work, "Graph uses breadth first order"), proposed_by=ProposedBy(channel="owner_console"))).id, True)
    neighbour = await service.propose(proposal(project, work, "Graph labels stay short"))
    foreign = await MemoryService(repo, SecretGuard()).propose(proposal(other, other_work, "Foreign memory"))
    with pytest.raises(DomainError) as cross:
        await service.propose(proposal(project, work, "Replaces a foreign memory", supersedes=foreign.id))
    assert cross.value.code == "MEMORY_LINK_INVALID"
    newer = await service.propose(proposal(project, work, "Graph uses depth first order", supersedes=older.id, citations=["src/app.py#L4"]),
                                  proposed_by=ProposedBy(channel="supervisor_chat", role="analyst"))
    assert (await repo.memory(older.id)).active, "Proposing a replacement must not invalidate before approval"
    with pytest.raises(DomainError) as self_link:
        await service.update(newer.id, True, MemoryApproval(related=[newer.id]))
    assert self_link.value.code == "MEMORY_LINK_INVALID"
    assert (await repo.memory(older.id)).invalidated_at is None, "A rejected approval must roll back the supersession"
    approved = await service.update(newer.id, True, MemoryApproval(related=[neighbour.id], scope="project"))
    assert approved.active and approved.scope == "project"
    replaced = await repo.memory(older.id)
    assert replaced.invalidated_at is not None and not replaced.active
    assert await repo.search_memory(project.id, "breadth", A) == []

    graph = await service.graph(project.id, newer.id, 1, 100)
    ids = {node.id for node in graph.nodes}
    assert {f"memory:{newer.id}", f"memory:{older.id}", f"memory:{neighbour.id}", "file:src/app.py", f"run:{work.id}", f"commit:{A}",
            "agent:supervisor_chat:analyst"} <= ids
    assert f"memory:{foreign.id}" not in ids
    kinds = {(edge.source, edge.kind, edge.target) for edge in graph.edges}
    assert (f"memory:{newer.id}", "supersedes", f"memory:{older.id}") in kinds
    assert (f"memory:{newer.id}", "related", f"memory:{neighbour.id}") in kinds
    assert (f"memory:{newer.id}", "cites", "file:src/app.py") in kinds
    assert (f"memory:{newer.id}", "proposed_by", "agent:supervisor_chat:analyst") in kinds
    assert all(edge.source in ids and edge.target in ids for edge in graph.edges)
    assert not graph.truncated
    nodes = {node.id: node for node in graph.nodes}
    assert nodes[f"memory:{older.id}"].attrs["state"] == "invalidated"
    small = await service.graph(project.id, newer.id, 2, 2)
    assert len(small.nodes) == 2 and small.truncated
    overview = await service.graph(project.id, None, 1, 9)
    assert len([node for node in overview.nodes if node.type == "memory"]) == 3 and len(overview.nodes) <= 9
    with pytest.raises(DomainError) as hidden:
        await service.graph(project.id, foreign.id, 1, 50)
    assert hidden.value.code == "MEMORY_NOT_FOUND"


async def test_overlaps_are_recorded_against_active_and_pending_memories_only(repository):
    repo, project, work = await delivered(repository)
    service = MemoryService(repo, SecretGuard())
    approved = await service.update((await service.propose(proposal(project, work, "Parser keeps empty input returning zero"))).id, True)
    pending = await service.propose(proposal(project, work, "The parser keeps empty input returning zero values"))
    invalidated = await service.propose(proposal(project, work, "Parser keeps empty input returning zero always"))
    await service.update(invalidated.id, False)
    await service.propose(proposal(project, work, "Deployment uses a draft pull request"))
    fresh = await service.propose(proposal(project, work, "Parser must keep empty input returning zero"))
    async with repo.connection() as conn:
        rows = await (await conn.execute("SELECT target_id,attrs FROM memory_links WHERE source_id=%s AND kind='overlaps' ORDER BY target_id", (fresh.id,))).fetchall()
    targets = {row["target_id"]: row["attrs"] for row in rows}
    assert set(targets) == {approved.id, pending.id}
    assert targets[approved.id]["only_source"] == ["keep", "must"] and targets[approved.id]["method"] == "shingle_jaccard_v1"


async def test_recall_log_pages_filters_and_stays_in_its_project(repository):
    repo, project, work = await delivered(repository)
    _, other, other_work = await delivered(repository)
    service = MemoryService(repo, SecretGuard())
    first = await service.update((await service.propose(proposal(project, work, "Recall arithmetic carefully"))).id, True)
    second = await service.update((await service.propose(proposal(project, work, "Recall boundaries for arithmetic overflow"))).id, True)
    work.phase = "analysis"
    for role in ("analyst", "architect", "developer"):
        selected = await service.context_for_role(project.id, "Arithmetic", "Recall arithmetic", A, work=work, role=role)
        assert {value["id"] for value in selected} == {first.id, second.id}
    reference = {"id": first.id, "content_digest": hashlib.sha256(first.content.encode()).hexdigest(), "source_commit": A}
    with pytest.raises(DomainError):
        await service.context_validator(project.id, B, work=work, role="qa")([reference])
    await MemoryService(repo, SecretGuard()).context_for_role(other.id, "Arithmetic", "Recall arithmetic", A, work=other_work, role="analyst")

    page = await service.recalls(project.id, limit=2)
    assert [item.role for item in page.items] == ["qa", "developer"] and page.next_cursor is not None
    assert page.items[0].outcome == "refused" and page.items[0].error_code == "MEMORY_CONTEXT_CHANGED" and page.items[0].refused_memory_ids == [first.id]
    recalled = page.items[1]
    assert recalled.stage == "analysis" and recalled.candidates == 2 and recalled.omitted == 0 and recalled.bytes > 0
    assert {entry.memory_id for entry in recalled.selected} == {first.id, second.id}
    assert all(entry.lexical_rank in {1, 2} and entry.vector_rank is None and entry.fused_score > 0 for entry in recalled.selected)
    rest = await service.recalls(project.id, cursor=page.next_cursor, limit=2)
    assert [item.role for item in rest.items] == ["architect", "analyst"] and rest.next_cursor is None
    assert len((await service.recalls(project.id, work_id=work.id)).items) == 4
    assert len((await service.recalls(project.id, memory_id=second.id)).items) == 3
    assert len((await service.recalls(other.id)).items) == 1
    assert (await service.recalls(project.id, work_id=other_work.id)).items == []
    stats = await repo.memory_recall_stats([first.id, second.id])
    assert stats[first.id]["recall_count"] == 3 and stats[first.id]["refused_count"] == 1 and stats[second.id]["refused_count"] == 0
    with pytest.raises(DomainError) as cursor:
        await service.recalls(project.id, cursor="0")
    assert cursor.value.code == "INVALID_CURSOR"
