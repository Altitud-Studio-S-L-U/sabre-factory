import asyncio
from unittest.mock import AsyncMock

import pytest

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.artifacts import ArtifactStore
from sabre.executor import snapshot_digest
from sabre.models import DomainError
from sabre.project_context import ProjectContext
from sabre.repository_ingestion import IngestionRequest, RepositoryIngestion
from sabre.security import SecretGuard


class SourceRunner:
    def __init__(self):
        self.files = {"src/app.py": "print('source')\n"}
        self.commit = "a" * 40
        self.prepare = AsyncMock()
        self.cleanup = AsyncMock()
        self.interrupt = False

    async def snapshot(self, work_id):
        if self.interrupt:
            self.interrupt = False
            raise asyncio.CancelledError()
        entries = [{"path": path, "content": content, "encoding": "utf-8"} for path, content in self.files.items()]
        return {"base_commit": self.commit, "digest": snapshot_digest(entries), "files": entries}


async def setup(repository, tmp_path):
    repo, project, _ = await fixture_work(repository)
    runner = SourceRunner()
    guard = SecretGuard()
    context = ProjectContext(ArtifactStore(tmp_path), runner, guard)
    enqueue = AsyncMock()
    return RepositoryIngestion(repo, runner, context, guard, enqueue), repo, project, runner, enqueue


async def test_request_is_transactional_idempotent_and_commit_index_survives_retry(repository, tmp_path):
    service, repo, project, runner, enqueue = await setup(repository, tmp_path)
    request = IngestionRequest(version=1, idempotency_key="synthetic-request")
    first, replay = await asyncio.gather(service.request(project.id, request), service.request(project.id, request))
    assert first.id == replay.id and enqueue.await_count == 1
    assert (await service.process(first.id)).state == "completed"
    assert (await service.process(first.id)).state == "completed"
    assert runner.prepare.await_count == 1 and runner.cleanup.await_count == 1
    duplicate = await service.request(project.id, IngestionRequest(version=1, idempotency_key="another-request"))
    await service.process(duplicate.id)
    async with repo.connection() as conn:
        row = await (await conn.execute("SELECT count(*) total FROM repository_indexes WHERE project_id=%s", (project.id,))).fetchone()
    assert row["total"] == 1
    report = await service.report(project.id)
    assert report.latest.source_commit == runner.commit and len(report.jobs) == 2
    with pytest.raises(DomainError) as conflict:
        await service.request(project.id, IngestionRequest(version=1, idempotency_key="synthetic-request", expected_source_commit="b" * 40))
    assert conflict.value.code == "INGESTION_KEY_REUSED"


async def test_delta_is_project_scoped_and_active_project_lock_prevents_source_race(repository, tmp_path):
    service, repo, project, runner, _ = await setup(repository, tmp_path)
    _, other, _ = await fixture_work(repository)
    first = await service.request(project.id, IngestionRequest(version=1, idempotency_key="first"))
    async with repo.project_lock(project.id) as acquired:
        assert acquired
        with pytest.raises(DomainError) as busy:
            await service.process(first.id)
        assert busy.value.code == "PROJECT_BUSY" and not runner.prepare.called
    await service.process(first.id)
    runner.commit, runner.files = "b" * 40, {"src/renamed.py": "new\n"}
    second = await service.request(project.id, IngestionRequest(version=1, idempotency_key="second"))
    await service.process(second.id)
    report = await service.report(project.id)
    assert report.latest.changes.deleted == ["src/app.py"] and report.latest.changes.added == ["src/renamed.py"]
    assert (await service.report(other.id)).latest is None
    assert (await service.report(other.id)).jobs == []


async def test_interrupted_job_recovers_and_admission_failure_retains_no_source_index(repository, tmp_path):
    service, _, project, runner, _ = await setup(repository, tmp_path)
    request = await service.request(project.id, IngestionRequest(version=1, idempotency_key="interrupted"))
    runner.interrupt = True
    with pytest.raises(asyncio.CancelledError):
        await service.process(request.id)
    assert (await service.report(project.id)).jobs[0].state == "queued"
    assert (await service.process(request.id)).state == "completed"
    runner.files = {"unsafe.py": "ghp_" + "a" * 30}
    runner.commit = "c" * 40
    secret_job = await service.request(project.id, IngestionRequest(version=1, idempotency_key="secret"))
    with pytest.raises(DomainError):
        await service.process(secret_job.id)
    report = await service.report(project.id)
    assert report.latest.source_commit == "a" * 40
    assert "ghp_" not in report.model_dump_json()
    assert next(job for job in report.jobs if job.id == secret_job.id).state == "failed"
    assert runner.cleanup.await_count == 3


async def test_queue_failure_rolls_back_registration_and_ingestion_request(repository, tmp_path):
    service, repo, project, _, enqueue = await setup(repository, tmp_path)
    enqueue.side_effect = RuntimeError("synthetic queue failure")
    with pytest.raises(RuntimeError):
        await service.request(project.id, IngestionRequest(version=1, idempotency_key="rollback"))
    assert (await service.report(project.id)).jobs == []
    replacement = project.model_copy(update={"id":"synthetic-rollback-project", "repository":"https://github.com/example/rollback"})
    with pytest.raises(RuntimeError):
        await repo.create_project(replacement, service.enqueue_project)
    with pytest.raises(DomainError):
        await repo.project(replacement.id)
