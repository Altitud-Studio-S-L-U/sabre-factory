"""Bounded, rebuildable repository indexes with commit-scoped source evidence."""

import asyncio
from datetime import datetime
from typing import Literal

from fastapi import FastAPI
from psycopg.types.json import Jsonb
from pydantic import Field

from sabre.contracts import StrictContract
from sabre.memory_import import ImportSummary, RepositoryMemoryImport
from sabre.models import DomainError, new_id, now
from sabre.project_context import INDEX_VERSION, ProjectContext, encoded
from sabre.repository import digest

MAX_INDEX_FILES = 2000
MAX_INDEX_BYTES = 1_048_576
INGESTION_SCHEMA = """
CREATE TABLE repository_ingestions(
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 request_key text NOT NULL,request_digest text NOT NULL,data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,request_key));
CREATE INDEX repository_ingestion_project ON repository_ingestions(project_id,created_at DESC);
CREATE TABLE repository_indexes(
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,source_commit text NOT NULL,index_version integer NOT NULL,
 data jsonb NOT NULL,captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,source_commit,index_version));
"""


class IngestionRequest(StrictContract):
    version: Literal[1]
    idempotency_key: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")
    expected_source_commit: str | None = Field(default=None, pattern=r"^[a-f0-9]{40,64}$")


class IngestionJob(StrictContract):
    version: Literal[1] = 1
    id: str
    project_id: str
    index_version: int
    state: Literal["queued", "running", "completed", "failed"] = "queued"
    source_commit: str | None = Field(default=None, pattern=r"^[a-f0-9]{40,64}$")
    expected_source_commit: str | None = None
    created_at: datetime = Field(default_factory=now)
    finished_at: datetime | None = None
    error_code: str | None = None
    error_message: str | None = None
    imported: ImportSummary | None = Field(default=None, description=(
        "What reading the repository proposed to memory; null on jobs that did not read it"))


class SourceObservation(StrictContract):
    area: str
    basis: str
    path: str


class IndexedSource(StrictContract):
    path: str
    content_digest: str
    indexable: bool
    lines: int | None
    areas: list[SourceObservation]
    kind: Literal["source_fact"] = "source_fact"
    validator: Literal["bounded_source_index_v1"] = "bounded_source_index_v1"


class SourceChanges(StrictContract):
    added: list[str] = Field(default_factory=list)
    changed: list[str] = Field(default_factory=list)
    deleted: list[str] = Field(default_factory=list)


class RepositoryIndex(StrictContract):
    version: Literal[1] = 1
    project_id: str
    source_commit: str = Field(pattern=r"^[a-f0-9]{40,64}$")
    index_version: int
    snapshot_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    captured_at: datetime = Field(default_factory=now)
    files: list[IndexedSource]
    total_files: int
    omitted_files: int
    changes: SourceChanges
    previous_commit: str | None = None
    validity: Literal["current_at_capture"] = "current_at_capture"
    untrusted: Literal[True] = True


class IngestionReport(StrictContract):
    version: Literal[1] = 1
    project_id: str
    jobs: list[IngestionJob]
    latest: RepositoryIndex | None


def build_index(context: ProjectContext, project_id: str, snapshot: dict, previous: RepositoryIndex | None = None):
    """Parse recognized source metadata; never interpret repository prose as instructions."""
    if previous and previous.project_id != project_id:
        raise DomainError("INGESTION_PROJECT_MISMATCH", "Source indexes cannot cross project boundaries", 403)
    files = context._files(snapshot)
    selected = []
    for source in sorted(files.values(), key=lambda item: item.path)[:MAX_INDEX_FILES]:
        index = context._index(project_id, source) if source.indexable else None
        selected.append(IndexedSource(path=source.path, content_digest=source.content_digest,
                                      indexable=source.indexable, lines=len(index["line_starts"]) if index else None,
                                      areas=index["areas"] if index else []))
    old = {item.path: item.content_digest for item in previous.files} if previous else {}
    current = {item.path: item.content_digest for item in selected}
    changes = SourceChanges(added=sorted(current.keys() - old.keys()),
                            changed=sorted(key for key in current.keys() & old.keys() if current[key] != old[key]),
                            deleted=sorted(old.keys() - files.keys()))
    result = RepositoryIndex(project_id=project_id, source_commit=snapshot["base_commit"], index_version=INDEX_VERSION,
                             snapshot_digest=snapshot["digest"], files=selected, total_files=len(snapshot["files"]),
                             omitted_files=len(snapshot["files"]) - len(selected), changes=changes,
                             previous_commit=previous.source_commit if previous else None)
    if len(encoded(result.model_dump(mode="json"))) > MAX_INDEX_BYTES:
        raise DomainError("REPOSITORY_INDEX_LIMIT", "Repository metadata exceeds the bounded index size", 422)
    context.guard.check(result)
    return result


class RepositoryIngestion:
    def __init__(self, repository, executor, context, guard, enqueue=None, memory_import: RepositoryMemoryImport | None = None):
        self.repository, self.executor, self.context, self.guard = repository, executor, context, guard
        self.enqueue = enqueue
        self.memory_import = memory_import

    async def enqueue_project(self, conn, project_id):
        return await self._request(conn, project_id, IngestionRequest(version=1, idempotency_key=f"registration:v{INDEX_VERSION}"))

    async def request(self, project_id: str, request: IngestionRequest):
        self.guard.check(request)
        await self.repository.project(project_id)
        async with self.repository.connection() as conn:
            return await self._request(conn, project_id, request)

    async def _request(self, conn, project_id, request):
        if self.enqueue is None:
            raise DomainError("INGESTION_UNAVAILABLE", "The repository indexing worker is unavailable", 503)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,4))", (f"{project_id}:{request.idempotency_key}",))
        previous = await (await conn.execute("SELECT data,request_digest FROM repository_ingestions WHERE project_id=%s AND request_key=%s", (project_id, request.idempotency_key))).fetchone()
        signature = digest({"index_version": INDEX_VERSION, **request.model_dump(mode="json")})
        if previous:
            if previous["request_digest"] != signature:
                raise DomainError("INGESTION_KEY_REUSED", "Use a new ingestion key for different source expectations", 409)
            return IngestionJob.model_validate_json(encoded(previous["data"]))
        job = IngestionJob(id=new_id(), project_id=project_id, index_version=INDEX_VERSION, expected_source_commit=request.expected_source_commit)
        await conn.execute("INSERT INTO repository_ingestions(id,project_id,request_key,request_digest,data) VALUES(%s,%s,%s,%s,%s)",
                           (job.id, project_id, request.idempotency_key, signature, Jsonb(job.model_dump(mode="json"))))
        await self.enqueue(conn, job.id, project_id)
        return job

    async def _job(self, job_id):
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT data FROM repository_ingestions WHERE id=%s", (job_id,))).fetchone()
        if not row:
            raise DomainError("INGESTION_NOT_FOUND", "The repository ingestion job does not exist", 404)
        return IngestionJob.model_validate_json(encoded(row["data"]))

    async def _save(self, job):
        self.guard.check(job)
        async with self.repository.connection() as conn:
            await conn.execute("UPDATE repository_ingestions SET data=%s WHERE id=%s AND project_id=%s", (Jsonb(job.model_dump(mode="json")), job.id, job.project_id))

    async def _latest(self, project_id):
        async with self.repository.connection() as conn:
            row = await (await conn.execute("""SELECT i.data FROM repository_ingestions j
                JOIN repository_indexes i ON i.project_id=j.project_id AND i.source_commit=j.data->>'source_commit'
                AND i.index_version=(j.data->>'index_version')::integer
                WHERE j.project_id=%s AND i.index_version=%s AND j.data->>'state'='completed'
                ORDER BY (j.data->>'finished_at')::timestamptz DESC,j.id DESC LIMIT 1""", (project_id, INDEX_VERSION))).fetchone()
        return RepositoryIndex.model_validate_json(encoded(row["data"])) if row else None

    async def _read_statements(self, job, index, snapshot):
        """Propose what the repository says to memory. The index stands even when this read fails."""
        if self.memory_import is None:
            return
        indexed = {item.path for item in index.files if item.indexable}
        files = {entry["path"]: entry["content"] for entry in snapshot["files"]
                 if entry.get("encoding", "utf-8") == "utf-8" and entry["path"] in indexed}
        try:
            job.imported = await self.memory_import.run(job.project_id, index.source_commit, files)
        except Exception:
            job.error_code = "MEMORY_IMPORT_FAILED"
            job.error_message = "The repository was indexed, but reading its statements into memory failed. Read the repository again."
        await self._save(job)

    async def _store(self, job, snapshot):
        """Index one admission-scanned snapshot for ``job`` and propose what the repository says."""
        self.guard.check_snapshot(snapshot)
        commit = snapshot.get("base_commit", "")
        if (job.expected_source_commit and commit != job.expected_source_commit) or (job.source_commit and commit != job.source_commit):
            raise DomainError("INGESTION_SOURCE_CHANGED", "The observed repository commit differs from the requested source", 409)
        job.source_commit = commit
        await self._save(job)
        previous = await self._latest(job.project_id)
        index = build_index(self.context, job.project_id, snapshot, previous)
        async with self.repository.connection() as conn:
            # The immutable index key makes repeated workers and requests
            # at one commit idempotent without promoting inferred summaries.
            await conn.execute("INSERT INTO repository_indexes(project_id,source_commit,index_version,data) VALUES(%s,%s,%s,%s) ON CONFLICT(project_id,source_commit,index_version) DO NOTHING", (job.project_id, commit, INDEX_VERSION, Jsonb(index.model_dump(mode="json"))))
            job.source_commit, job.state, job.finished_at = commit, "completed", now()
            await conn.execute("UPDATE repository_ingestions SET data=%s WHERE id=%s AND project_id=%s", (Jsonb(job.model_dump(mode="json")), job.id, job.project_id))
        await self._read_statements(job, index, snapshot)
        return job

    async def record(self, job: IngestionJob, snapshot: dict) -> IngestionJob:
        """Index a snapshot whose reader already holds the project: the fresh checkout of a run's intake.

        A run takes the project before its queued job can read the repository, so without this the run
        would find no index at its own commit and recall no project memory. The queued job then finds
        its work done. A snapshot the index cannot hold is left to that job, which reports why.
        """
        job = await self._job(job.id)
        if job.state == "completed":
            return job
        try:
            return await self._store(job, snapshot)
        except DomainError:
            return await self._job(job.id)

    async def report(self, project_id):
        await self.repository.project(project_id)
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT data FROM repository_ingestions WHERE project_id=%s ORDER BY created_at DESC,id DESC LIMIT 20", (project_id,))).fetchall()
        report = IngestionReport(project_id=project_id, jobs=[IngestionJob.model_validate_json(encoded(row["data"])) for row in rows], latest=await self._latest(project_id))
        self.guard.check(report)
        return report

    async def process(self, job_id):
        job = await self._job(job_id)
        if job.state == "completed":
            return job
        async with self.repository.project_lock(job.project_id, execution_slot=False) as acquired:
            if not acquired:
                raise DomainError("PROJECT_BUSY", "Repository indexing waits for the active project operation", 409)
            job = await self._job(job_id)
            if job.state == "completed":
                return job
            # Each ingestion has its own source-only scratch workspace. The broker
            # scans admission before exposing a snapshot and executes no repo code.
            scratch = f"ingest-{job.id}"
            job.state, job.error_code, job.error_message = "running", None, None
            await self._save(job)
            try:
                project = await self.repository.project(job.project_id)
                await self.executor.prepare(project, scratch)
                snapshot = await self.executor.snapshot(scratch)
                await self._store(job, snapshot)
            except asyncio.CancelledError:
                job.state, job.error_code, job.error_message = "queued", "INGESTION_INTERRUPTED", "Indexing was interrupted and can resume from its queued job"
                await self._save(job)
                raise
            except Exception as error:
                job.state, job.finished_at = "failed", now()
                job.error_code = error.code if isinstance(error, DomainError) else "INGESTION_FAILED"
                # Upstream exception text may contain transport details or secrets.
                job.error_message = "Repository indexing failed. Check source access, admission scanning and the bounded index limits."
                await self._save(job)
                raise DomainError(job.error_code, job.error_message, 422) from None
            finally:
                try:
                    await self.executor.cleanup(scratch)
                except Exception:
                    # Cleanup failures remain visible and retryable in the job;
                    # an already committed index is retained as immutable evidence.
                    job.error_code = "INGESTION_CLEANUP_REQUIRED"
                    job.error_message = "The ingestion scratch workspace requires cleanup; retry the job after runner recovery"
                    if job.state == "completed":
                        job.state = "failed"
                    await self._save(job)
                    raise DomainError(job.error_code, job.error_message, 503) from None
            return job


async def register_ingestion_jobs(runtime):
    @runtime.queue.task(name="sabre.ingest_repository", queue="maintenance", retry=3)
    async def ingest_repository(job_id: str):
        return (await runtime.ingestion.process(job_id)).state

    async def enqueue(conn, job_id, project_id):
        await ingest_repository.configure(connection=conn, lock=f"project:{project_id}").defer_async(job_id=job_id)

    runtime.ingestion = RepositoryIngestion(runtime.repository, runtime.factory.executor, runtime.factory.project_context, runtime.service.guard, enqueue,
                                            RepositoryMemoryImport(runtime.repository, runtime.service.memory))
    runtime.enqueue_ingestion = runtime.ingestion.enqueue_project


def install_ingestion_routes(app: FastAPI, service):
    def ingestion():
        manager = getattr(service().queue, "ingestion", None)
        if manager is None:
            raise DomainError("INGESTION_UNAVAILABLE", "The repository indexing worker is unavailable", 503)
        return manager

    @app.get("/api/v1/projects/{project_id}/ingestion", response_model=IngestionReport)
    async def ingestion_report(project_id: str):
        return await ingestion().report(project_id)

    @app.post("/api/v1/projects/{project_id}/ingestion", response_model=IngestionJob, status_code=202)
    async def request_ingestion(project_id: str, body: IngestionRequest):
        return await ingestion().request(project_id, body)
