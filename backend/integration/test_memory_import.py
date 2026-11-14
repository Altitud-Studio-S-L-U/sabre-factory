"""Reading a repository into memory proposals, against PostgreSQL."""

import json
from unittest.mock import AsyncMock

import pytest

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from integration.test_repository_ingestion import SourceRunner
from sabre.artifacts import ArtifactStore
from sabre.memory import MemoryService
from sabre.memory_import import RepositoryMemoryImport
from sabre.models import DomainError, MemoryCreate, ProposedBy
from sabre.project_context import ProjectContext
from sabre.repository_ingestion import IngestionRequest, RepositoryIngestion
from sabre.security import SecretGuard

A, B, C = "a" * 40, "b" * 40, "c" * 40
PACKAGE = json.dumps({"name": "pricing", "scripts": {"test": "vitest run"}, "dependencies": {"react": "19.0.0"}}, indent=2)


def guide(**sections):
    return "".join(f"## {title}\n\n{text}\n\n" for title, text in sections.items())


async def setup(repository, tmp_path):
    repo, project, _ = await fixture_work(repository)
    runner, guard = SourceRunner(), SecretGuard()
    memory = MemoryService(repo, guard)
    ingestion = RepositoryIngestion(repo, runner, ProjectContext(ArtifactStore(tmp_path), runner, guard), guard, AsyncMock(),
                                    RepositoryMemoryImport(repo, memory))
    return ingestion, memory, repo, project, runner


async def read(ingestion, project, runner, commit, files):
    runner.commit, runner.files = commit, files
    job = await ingestion.request(project.id, IngestionRequest(version=1, idempotency_key=f"read-{commit[:4]}-{len(files)}-{id(files)}"))
    return await ingestion.process(job.id)


async def by_title(memory, project):
    page = await memory.items(project.id, limit=100)
    return {item.content.split("\n", 1)[0]: item for item in reversed(page.items)}


async def test_reading_a_repository_proposes_its_statements_with_commit_provenance_and_repeats_safely(repository, tmp_path):
    ingestion, memory, repo, project, runner = await setup(repository, tmp_path)
    files = {"AGENTS.md": guide(Verify="Run `pnpm test` before a pull request.", Rules="Never edit generated files."),
             "package.json": PACKAGE, "src/app.py": "print('source')\n"}
    job = await read(ingestion, project, runner, A, files)
    assert job.state == "completed" and job.imported.model_dump() == {
        "proposed": 4, "replaced": 0, "unchanged": 0, "declined": 0, "withdrawn": 0, "refused": 0, "omitted": 0}
    report = await ingestion.report(project.id)
    records = await by_title(memory, project)
    assert set(records) == {"AGENTS.md › Verify", "AGENTS.md › Rules", "package.json › scripts", "package.json › stack"}
    verify = records["AGENTS.md › Verify"]
    assert verify.state == "pending" and not verify.active and verify.kind == "fact" and verify.scope == "project"
    assert verify.source_work_id is None and verify.source_commit == A and verify.evidence_digest == report.latest.snapshot_digest
    assert verify.citations == ["AGENTS.md#L1"] and verify.proposed_by == ProposedBy(channel="repository", role="instructions")
    assert records["package.json › scripts"].proposed_by.role == "manifest"
    # Nothing a repository says guides a run before the owner approves it.
    assert await repo.search_memory(project.id, "pnpm", A) == []
    await memory.update(verify.id, True)
    assert [item.id for item in await repo.search_memory(project.id, "pnpm", A)] == [verify.id]

    again = await read(ingestion, project, runner, A, dict(files))
    assert again.imported.model_dump() == {"proposed": 0, "replaced": 0, "unchanged": 4, "declined": 0, "withdrawn": 0, "refused": 0, "omitted": 0}
    assert len((await memory.items(project.id, limit=100)).items) == 4

    detail = await memory.detail(verify.id)
    assert detail.provenance.work_id is None and detail.provenance.work_objective is None and detail.provenance.commit == A
    graph = await memory.graph(project.id)
    assert {node.type for node in graph.nodes} == {"memory", "file", "commit", "agent"}
    assert {"agent:repository:instructions", "agent:repository:manifest", "file:AGENTS.md", "file:package.json"} <= {node.id for node in graph.nodes}


async def test_changed_text_replaces_a_record_and_the_owners_decisions_stand(repository, tmp_path):
    ingestion, memory, _, project, runner = await setup(repository, tmp_path)
    await read(ingestion, project, runner, A, {"AGENTS.md": guide(Verify="Run pytest.", Rules="Keep commits small.", Layout="Code lives in src.")})
    first = await by_title(memory, project)
    await memory.update(first["AGENTS.md › Verify"].id, True)
    await memory.update(first["AGENTS.md › Rules"].id, False)

    job = await read(ingestion, project, runner, B, {"AGENTS.md": guide(
        Verify="Run pytest -q and ruff.", Rules="Keep commits small.", Layout="Code lives in backend/src.", Release="Tag from main.")})
    assert job.imported.model_dump() == {"proposed": 1, "replaced": 2, "unchanged": 0, "declined": 1, "withdrawn": 0, "refused": 0, "omitted": 0}
    second = await by_title(memory, project)
    replacement = second["AGENTS.md › Verify"]
    # An approved record keeps guiding runs until the owner approves what replaces it.
    assert replacement.state == "pending" and replacement.supersedes == first["AGENTS.md › Verify"].id and replacement.source_commit == B
    assert (await memory.detail(first["AGENTS.md › Verify"].id)).item.state == "active"
    # A waiting proposal is simply brought up to date: the old text is withdrawn, never left beside the new one.
    old_layout = (await memory.detail(first["AGENTS.md › Layout"].id)).item
    assert old_layout.state == "invalidated" and old_layout.invalidated_as == "withdrawn"
    assert second["AGENTS.md › Layout"].state == "pending" and "backend/src" in second["AGENTS.md › Layout"].content
    # The rejected statement did not come back, and the review shows what the replacement overlaps.
    rejected = (await memory.detail(first["AGENTS.md › Rules"].id)).item
    assert rejected.invalidated_as == "rejected" and second["AGENTS.md › Rules"].id == rejected.id
    review = await memory.review(project.id)
    assert {entry.item.content.split("\n", 1)[0] for entry in review.pending} == {"AGENTS.md › Verify", "AGENTS.md › Layout", "AGENTS.md › Release"}
    await memory.update(replacement.id, True)
    superseded = (await memory.detail(first["AGENTS.md › Verify"].id)).item
    assert superseded.state == "invalidated" and superseded.invalidated_as == "superseded"

    job = await read(ingestion, project, runner, C, {"AGENTS.md": guide(
        Verify="Run pytest -q and ruff.", Rules="Keep commits small.", Release="Tag from main.")})
    # Layout is gone, so its waiting proposal is withdrawn; Release still waits and now cites the commit just read.
    assert job.imported.model_dump() == {"proposed": 0, "replaced": 0, "unchanged": 2, "declined": 1, "withdrawn": 1, "refused": 0, "omitted": 0}
    third = await by_title(memory, project)
    assert third["AGENTS.md › Release"].state == "pending" and third["AGENTS.md › Release"].source_commit == C
    assert third["AGENTS.md › Layout"].invalidated_as == "withdrawn"
    # The approved record's file changed, so commit validity asks for a second look instead of guessing.
    review = await memory.review(project.id)
    assert [entry.item.id for entry in review.stale] == [replacement.id]
    assert [entry.item.content.split("\n", 1)[0] for entry in review.pending] == ["AGENTS.md › Release"]


async def test_an_owner_can_anchor_a_memory_to_an_indexed_commit_and_to_nothing_else(repository, tmp_path):
    ingestion, memory, _, project, runner = await setup(repository, tmp_path)
    await read(ingestion, project, runner, A, {"src/app.py": "print('source')\n"})
    digest = (await ingestion.report(project.id)).latest.snapshot_digest
    owner = ProposedBy(channel="owner_console")

    def request(**values):
        return MemoryCreate(**{"project_id": project.id, "kind": "lesson", "content": "Prices are stored in cents", "source_commit": A, **values})

    item = await memory.propose(request(scope="project", citations=["src/app.py#L1"]), proposed_by=owner)
    assert not item.active and item.source_work_id is None and item.evidence_digest == digest and item.proposed_by == owner
    assert (await memory.propose(request(scope="project", citations=["src/app.py#L1"], evidence_digest=digest), proposed_by=owner)).id == item.id
    for refused, code in ((request(source_commit=B), "MEMORY_PROVENANCE"), (request(evidence_digest="0" * 64), "MEMORY_PROVENANCE"),
                          (request(citations=["src/missing.py"]), "MEMORY_CITATION_UNKNOWN")):
        with pytest.raises(DomainError) as error:
            await memory.propose(refused, proposed_by=owner)
        assert error.value.code == code
    _, other, _ = await fixture_work(repository)
    with pytest.raises(DomainError) as foreign:
        await memory.propose(request(project_id=other.id), proposed_by=owner)
    assert foreign.value.code == "MEMORY_PROVENANCE"


async def test_a_failed_read_keeps_the_index_and_says_so_on_the_job(repository, tmp_path):
    ingestion, memory, _, project, runner = await setup(repository, tmp_path)
    ingestion.memory_import.run = AsyncMock(side_effect=RuntimeError("synthetic failure"))
    job = await read(ingestion, project, runner, A, {"AGENTS.md": guide(Verify="Run pytest.")})
    assert job.state == "completed" and job.error_code == "MEMORY_IMPORT_FAILED" and job.imported is None
    report = await ingestion.report(project.id)
    assert report.latest.source_commit == A and report.jobs[0].error_code == "MEMORY_IMPORT_FAILED"
    assert "synthetic failure" not in report.model_dump_json()
    assert (await memory.items(project.id)).items == []


async def test_a_run_that_holds_the_project_indexes_its_own_checkout_and_recalls_the_projects_memory(repository, tmp_path):
    ingestion, memory, repo, project, runner = await setup(repository, tmp_path)
    _, _, work = await fixture_work(repository)
    work = work.model_copy(update={"project_id": project.id})
    files = {"AGENTS.md": guide(Verify="Run pytest before a pull request."), "src/app.py": "print('one')\n"}
    await read(ingestion, project, runner, A, files)
    statement = (await by_title(memory, project))["AGENTS.md › Verify"]
    await memory.update(statement.id, True)

    # The default branch moved on; the instruction file did not change.
    runner.commit, runner.files = B, {**files, "src/app.py": "print('two')\n"}
    checkout = await runner.snapshot("run-workspace")
    prepared = runner.prepare.await_count
    async with repo.project_lock(project.id) as acquired:
        assert acquired
        job = await ingestion.request(project.id, IngestionRequest(version=1, idempotency_key="intake:run:r1", expected_source_commit=B))
        with pytest.raises(DomainError) as busy:
            await ingestion.process(job.id)
        assert busy.value.code == "PROJECT_BUSY"
        # Without an index at the run's commit the approved record cannot be evaluated, and the log says why.
        assert await memory.context_for_role(project.id, "Fix the parser", "Run pytest on the parser", B, work=work, role="analyst") == []
        assert (await memory.recalls(project.id)).items[0].index_missing
        recorded = await ingestion.record(job, checkout)
        assert recorded.state == "completed" and recorded.source_commit == B and recorded.imported.unchanged == 1
        recalled = await memory.context_for_role(project.id, "Fix the parser", "Run pytest on the parser", B, work=work, role="analyst")
        assert [item["id"] for item in recalled] == [statement.id]
        latest = (await memory.recalls(project.id)).items[0]
        assert not latest.index_missing and [entry.memory_id for entry in latest.selected] == [statement.id]
    # The queued job finds its work done and reads nothing again.
    assert (await ingestion.process(job.id)).state == "completed" and runner.prepare.await_count == prepared
    assert (await ingestion.report(project.id)).latest.source_commit == B

    # A checkout at another commit than the one requested is not recorded; the job stays for the queue.
    other = await ingestion.request(project.id, IngestionRequest(version=1, idempotency_key="intake:run:r2", expected_source_commit=C))
    assert (await ingestion.record(other, checkout)).state == "queued"
    assert (await ingestion.report(project.id)).latest.source_commit == B


async def test_a_run_that_never_delivers_leaves_what_its_specialists_established(repository, tmp_path):
    from sabre.memory import MAX_RUN_PROPOSALS

    ingestion, memory, repo, project, runner = await setup(repository, tmp_path)
    _, _, work = await fixture_work(repository)
    work = work.model_copy(update={"project_id": project.id})
    await repo.admit(work.model_copy(update={"id": "run-with-proposals", "idempotency_key": "run-with-proposals"}), AsyncMock())
    work = await repo.work("run-with-proposals")
    await read(ingestion, project, runner, A, {"src/pricing.py": "def total(items):\n    return sum(items)\n", "README.md": "# Pricing\n"})
    digest = (await ingestion.report(project.id)).latest.snapshot_digest
    assert work.evidence is None

    propose = memory.proposer(work, "analyst", A)
    result = await propose(statement="Totals are computed by total() in the pricing module.", why="A change to rounding belongs there.",
                           citations=["src/pricing.py#L1"])
    assert result["proposed"] is True and result["remaining_in_assignment"] == 2
    item = (await memory.detail(result["memory_id"])).item
    assert item.state == "pending" and not item.active and item.scope == "project"
    assert (item.source_work_id, item.source_commit, item.evidence_digest) == (work.id, A, digest)
    assert item.proposed_by == ProposedBy(channel="factory", role="analyst", work_id=work.id)
    assert item.content.split("\n") == ["Totals are computed by total() in the pricing module.", "Why it matters: A change to rounding belongs there."]
    # The same statement again is the same record, not a second proposal.
    assert (await propose(statement="Totals are computed by total() in the pricing module.", why="A change to rounding belongs there.",
                          citations=["src/pricing.py#L1"]))["memory_id"] == item.id
    assert await repo.run_proposal_count(work.id) == 1

    # Citations are checked against the commit the run started from: the file and the line must exist there.
    for citations in (["src/missing.py"], ["src/pricing.py#L40"]):
        refused = await memory.proposer(work, "reviewer", A)(statement="The pricing module has a second entry point.",
                                                             why="It would need the same change.", citations=citations)
        assert refused["proposed"] is False and refused["code"] == "MEMORY_CITATION_UNKNOWN"
    unindexed = await memory.proposer(work, "analyst", B)(statement="Totals are computed by total() in the pricing module.",
                                                          why="A change to rounding belongs there.", citations=["src/pricing.py"])
    assert unindexed["code"] == "MEMORY_PROVENANCE"
    assert await repo.run_proposal_count(work.id) == 1

    # Nothing a specialist wrote guides a run until the owner approves it.
    assert await repo.search_memory(project.id, "total", A) == []
    review = await memory.review(project.id)
    assert [entry.item.id for entry in review.pending] == [item.id]
    await memory.update(item.id, True)
    assert [found.id for found in await repo.search_memory(project.id, "total", A)] == [item.id]
    detail = await memory.detail(item.id)
    assert detail.provenance.work_id == work.id and detail.provenance.work_status == "queued"

    # One run cannot flood the queue, however many assignments it has.
    for number in range(1, MAX_RUN_PROPOSALS):
        accepted = await memory.proposer(work, "developer", A)(statement=f"Observation number {number} about the pricing module.",
                                                               why="Kept for the bound of one run.", citations=["README.md"])
        assert accepted["proposed"] is True
    over = await memory.proposer(work, "developer", A)(statement="One observation more than the run may propose.",
                                                       why="It must be refused.", citations=["README.md"])
    assert over["proposed"] is False and over["code"] == "MEMORY_PROPOSAL_LIMIT"
    assert await repo.run_proposal_count(work.id) == MAX_RUN_PROPOSALS


async def test_an_owner_citation_of_a_line_past_the_end_of_the_file_is_refused(repository, tmp_path):
    ingestion, memory, _, project, runner = await setup(repository, tmp_path)
    await read(ingestion, project, runner, A, {"src/app.py": "one\ntwo\n"})
    owner = ProposedBy(channel="owner_console")

    def request(citation):
        return MemoryCreate(project_id=project.id, kind="lesson", content="Line two holds the second value", source_commit=A, citations=[citation])

    assert (await memory.propose(request("src/app.py#L2"), proposed_by=owner)).citations == ["src/app.py#L2"]
    with pytest.raises(DomainError) as error:
        await memory.propose(request("src/app.py#L3"), proposed_by=owner)
    assert error.value.code == "MEMORY_CITATION_UNKNOWN" and "src/app.py#L3" in error.value.message
