"""Project editing, archiving and restoring against PostgreSQL."""

from types import SimpleNamespace

import pytest

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.models import (
    Budget,
    DomainError,
    Project,
    ProjectCreate,
    ProjectStateChange,
    ProjectUpdate,
    Status,
    WorkOrder,
    WorkOrderCreate,
    new_id,
)
from sabre.service import FactoryService


def service_for(repo):
    return FactoryService(repo, None, None, SimpleNamespace(), SimpleNamespace(check=lambda value: None), None)


async def registered(repository, **fields):
    repo, created = repository
    project = Project(**{"name": "Project fixture", "repository": f"https://github.com/fixture/{new_id()}", "profile": "python",
                         "gate_commands": [["python", "-m", "unittest"]], **fields})
    await repo.create_project(project)
    created.append(project.id)
    return repo, project


def edit(project, revision, **fields):
    return ProjectUpdate(**{"expected_revision": revision, "name": project.name, "profile": project.profile, "default_branch": project.default_branch,
                            "gate_commands": project.gate_commands, "browser_preview": project.browser_preview, **fields})


async def no_enqueue(conn, work_id):
    return None


async def events(repo, project_id):
    async with repo.connection() as conn:
        return await (await conn.execute("SELECT revision,action,fields FROM project_events WHERE project_id=%s ORDER BY seq", (project_id,))).fetchall()


async def test_edit_checks_the_revision_and_records_only_the_fields_that_changed(repository):
    repo, project = await registered(repository, allowed_mcp_servers=["docs"], approved_baseline=["a" * 64])
    service = service_for(repo)
    assert project.revision == 0 and project.archived_at is None

    edited = await service.update_project(project.id, edit(project, 0, name="Renamed fixture", gate_commands=[["python", "-m", "pytest", "-q"]]))
    assert (edited.revision, edited.name, edited.gate_commands) == (1, "Renamed fixture", [["python", "-m", "pytest", "-q"]])
    stored = await repo.project(project.id)
    assert stored == edited
    # What the edit does not carry is left alone.
    assert (stored.repository, stored.allowed_mcp_servers, stored.approved_baseline) == (project.repository, ["docs"], ["a" * 64])

    with pytest.raises(DomainError) as stale:
        await service.update_project(project.id, edit(project, 0, name="Lost update"))
    assert (stale.value.code, stale.value.status_code) == ("PROJECT_CHANGED", 409)
    assert (await repo.project(project.id)).name == "Renamed fixture"

    # Saving the same values is not a change: no new revision and no event.
    assert (await service.update_project(project.id, edit(edited, 1))).revision == 1
    assert await events(repo, project.id) == [{"revision": 1, "action": "update", "fields": ["gate_commands", "name"]}]

    with pytest.raises(DomainError) as missing:
        await service.update_project(new_id(), edit(project, 0))
    assert missing.value.code == "PROJECT_NOT_FOUND"


async def test_edit_waits_while_a_run_of_the_project_is_executing(repository):
    repo, project = await registered(repository)
    service = service_for(repo)
    async with repo.project_lock(project.id) as held:
        assert held
        with pytest.raises(DomainError) as busy:
            await service.update_project(project.id, edit(project, 0, name="During a run"))
        assert busy.value.code == "PROJECT_BUSY"
    assert (await repo.project(project.id)).revision == 0
    assert (await service.update_project(project.id, edit(project, 0, name="After the run"))).revision == 1


async def test_an_archived_project_leaves_the_list_refuses_runs_and_comes_back_intact(repository):
    repo, project = await registered(repository, allowed_mcp_servers=["docs"])
    _, other = await registered(repository)
    service = service_for(repo)

    archived = await service.archive_project(project.id, ProjectStateChange(expected_revision=0))
    assert archived.revision == 1 and archived.archived_at is not None
    active = {item.id for item in await repo.projects()}
    assert project.id not in active and other.id in active
    assert {project.id, other.id} <= {item.id for item in await repo.projects(archived=True)}
    # Its records stay reachable by identifier.
    assert (await repo.project(project.id)).archived_at == archived.archived_at

    request = WorkOrderCreate(project_id=project.id, mode="patch", objective="Correct fixture behavior", acceptance=["Correct output"],
                              budget=Budget(max_cost_usd=0), idempotency_key=new_id())
    with pytest.raises(DomainError) as refused:
        await service.submit(request)
    assert (refused.value.code, refused.value.status_code) == ("PROJECT_ARCHIVED", 409)
    # The repository refuses too, for callers that admit work themselves.
    with pytest.raises(DomainError) as admitted:
        await repo.admit(WorkOrder(**request.model_dump()), no_enqueue)
    assert admitted.value.code == "PROJECT_ARCHIVED"
    async with repo.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) total FROM work_orders WHERE project_id=%s", (project.id,))).fetchone())["total"] == 0

    with pytest.raises(DomainError) as duplicate:
        await service.create_project(ProjectCreate(name="Again", repository=project.repository, profile="python", gate_commands=[["true"]]))
    assert duplicate.value.code == "PROJECT_EXISTS" and "restore" in duplicate.value.message

    with pytest.raises(DomainError) as stale:
        await service.restore_project(project.id, ProjectStateChange(expected_revision=0))
    assert stale.value.code == "PROJECT_CHANGED"
    restored = await service.restore_project(project.id, ProjectStateChange(expected_revision=1))
    assert restored.revision == 2 and restored.archived_at is None and restored.allowed_mcp_servers == ["docs"]
    assert project.id in {item.id for item in await repo.projects()}
    assert (await repo.admit(WorkOrder(**request.model_dump()), no_enqueue)).project_id == project.id
    assert [(row["revision"], row["action"], row["fields"]) for row in await events(repo, project.id)] == [
        (1, "archive", ["archived_at"]), (2, "restore", ["archived_at"])]


async def test_archiving_is_refused_while_a_run_is_open_and_a_stopped_run_cannot_resume_afterwards(repository):
    repo, project, work = await fixture_work(repository)
    service = service_for(repo)
    with pytest.raises(DomainError) as open_run:
        await service.archive_project(project.id, ProjectStateChange(expected_revision=0))
    assert open_run.value.code == "PROJECT_HAS_OPEN_RUNS" and work.id[:8] in open_run.value.message
    assert (await repo.project(project.id)).archived_at is None

    # A failed run is stopped, so it does not hold the project; a scheduled security report never does.
    work.status = Status.FAILED
    await repo.save(work)
    report = WorkOrder(project_id=project.id, mode="maintain", objective="Security review scheduled", acceptance=["Propose remediations"],
                       budget=Budget(max_cost_usd=0.01), idempotency_key=new_id(), phase="security_watch", status=Status.BLOCKED)
    await repo.admit(report, no_enqueue)
    archived = await service.archive_project(project.id, ProjectStateChange(expected_revision=0))
    assert archived.archived_at is not None

    with pytest.raises(DomainError) as resume:
        await service.control(work.id, "resume")
    assert resume.value.code == "PROJECT_ARCHIVED"
    assert (await repo.work(work.id)).status == Status.FAILED


async def test_a_project_stored_before_revisions_existed_reads_as_active_at_revision_zero(repository):
    repo, project = await registered(repository)
    async with repo.connection() as conn:
        await conn.execute("UPDATE projects SET data=data - 'revision' - 'archived_at' WHERE id=%s", (project.id,))
    stored = await repo.project(project.id)
    assert (stored.revision, stored.archived_at) == (0, None)
    assert project.id in {item.id for item in await repo.projects()}
    assert (await service_for(repo).archive_project(project.id, ProjectStateChange(expected_revision=0))).revision == 1
