"""Application metadata, command admission and effect receipts; graph state lives in LangGraph."""

import hashlib
import json
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any, Literal, TypedDict

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from sabre.budget_contracts import BudgetAuthorization, BudgetPolicy, activate_reserve
from sabre.budget_diagnostics import dispatch_denial
from sabre.context_receipts import ContextReceipt, ContextUsageSummary, aggregate_receipts, checked_receipt
from sabre.events import EventPage, ExecutionEvent, SequencedEvent
from sabre.integrations import INTEGRATIONS_SCHEMA
from sabre.mcp_connections import MCP_CONNECTIONS_SCHEMA
from sabre.memory_store import MemoryStore
from sabre.migrations import migrate
from sabre.model_configuration import MODEL_CONFIGURATION_SCHEMA
from sabre.models import (
    Budget,
    CallBudgetIncrease,
    CliProgressLimitsChange,
    DomainError,
    Project,
    ScopeChange,
    SecurityException,
    SecurityExceptionCreate,
    Status,
    TokenBudgetIncrease,
    WorkOrder,
    WorkOrderCreate,
    new_id,
    now,
)
from sabre.notifications import WebhookDestination
from sabre.project_tools import PROJECT_TOOLS_SCHEMA
from sabre.repo_creation import REPO_CREATION_SCHEMA

PANEL_SESSION_LOCK = 813784


class CheckpointInventory(TypedDict):
    count: int
    threads: int
    child_threads: list[str]
    truncated: bool


class UsageSummary(TypedDict):
    calls: int
    settled_calls: int
    unsettled_calls: int
    tokens: int
    measured_tokens: int
    unknown_reserved_tokens: int
    cost_usd: float


class UsageBreakdown(TypedDict):
    usage: UsageSummary
    measured_api_cost_usd: float | None
    reserved_api_cost_usd: float


class KnowledgeInventory(TypedDict):
    memories: dict[str, int]
    checkpoints: dict[str, int]
    work_ids: list[str]
    truncated: bool

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS sabre_schema(version integer PRIMARY KEY);
INSERT INTO sabre_schema VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS projects(id text PRIMARY KEY, data jsonb NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS project_repository ON projects(lower(data->>'repository'));
CREATE TABLE IF NOT EXISTS work_orders(
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id),
 idem text NOT NULL UNIQUE, request_hash text NOT NULL, data jsonb NOT NULL,
 control text, scope jsonb, accepted_answer jsonb, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS work_events(
 seq bigserial PRIMARY KEY, id text UNIQUE NOT NULL, work_id text NOT NULL REFERENCES work_orders(id),
 kind text NOT NULL, message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS effects(
 operation_key text PRIMARY KEY, request_hash text NOT NULL, state text NOT NULL, result jsonb);
CREATE TABLE IF NOT EXISTS model_usage(
 id text PRIMARY KEY, work_id text REFERENCES work_orders(id), reserved_tokens bigint NOT NULL,
 reserved_usd numeric NOT NULL, actual_tokens bigint, actual_usd numeric,
 created_at timestamptz NOT NULL DEFAULT now(), context_key text);
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS context_receipt jsonb;
CREATE TABLE IF NOT EXISTS memories(
 id text PRIMARY KEY, project_id text REFERENCES projects(id), data jsonb NOT NULL,
 embedding vector(1536), document tsvector GENERATED ALWAYS AS
 (to_tsvector('simple',data->>'content')) STORED);
CREATE INDEX IF NOT EXISTS memory_document ON memories USING gin(document);
CREATE TABLE IF NOT EXISTS security_reports(
 id text PRIMARY KEY, project_id text REFERENCES projects(id), work_id text REFERENCES work_orders(id),
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS security_exceptions(
 id text PRIMARY KEY, work_id text NOT NULL REFERENCES work_orders(id),
 project_id text NOT NULL REFERENCES projects(id), data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS security_exceptions_work ON security_exceptions(work_id);
CREATE TABLE IF NOT EXISTS notifications(
 id text PRIMARY KEY, work_id text REFERENCES work_orders(id), data jsonb NOT NULL,
 delivered boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS panel_tickets(
 ticket_hash text PRIMARY KEY, origin text NOT NULL, epoch text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS panel_sessions(
 session_hash text PRIMARY KEY, origin text NOT NULL, epoch text NOT NULL, expires_at timestamptz NOT NULL);
""" + INTEGRATIONS_SCHEMA + MCP_CONNECTIONS_SCHEMA + REPO_CREATION_SCHEMA + PROJECT_TOOLS_SCHEMA + MODEL_CONFIGURATION_SCHEMA


def payload(model) -> dict:
    return json.loads(model.model_dump_json())


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class Repository(MemoryStore):
    def __init__(self, dsn: str, *, pool_size: int = 0, execution_slots: int = 2):
        self.dsn = dsn
        self.execution_slots = execution_slots
        self.notification_destinations: dict[str, WebhookDestination] = {}
        self.pool = AsyncConnectionPool(dsn, open=False, min_size=1, max_size=pool_size,
            kwargs={"row_factory": dict_row, "connect_timeout": 5}, reset=self._reset_connection) if pool_size else None

    @staticmethod
    async def _reset_connection(conn):
        await conn.execute("SELECT pg_advisory_unlock_all()")
        await conn.commit()

    async def close(self):
        if self.pool:
            await self.pool.close()

    @asynccontextmanager
    async def connection(self):
        if self.pool:
            async with self.pool.connection(timeout=10) as conn:
                yield conn
        else:
            async with await psycopg.AsyncConnection.connect(self.dsn, row_factory=dict_row, connect_timeout=5) as conn:
                yield conn

    async def initialize(self):
        if self.pool:
            await self.pool.open(wait=True)
        async with self.connection() as conn:
            await migrate(conn, SCHEMA)

    async def healthy(self) -> bool:
        try:
            async with self.connection() as conn:
                await conn.execute("SELECT 1")
            return True
        except psycopg.Error:
            return False

    async def issue_panel_ticket(self, ticket_hash: str, origin: str, epoch: str):
        async with self.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(%s)", (PANEL_SESSION_LOCK,))
            await conn.execute("DELETE FROM panel_tickets WHERE expires_at<=clock_timestamp() OR epoch<>%s", (epoch,))
            count = await (await conn.execute("SELECT count(*) AS n FROM panel_tickets")).fetchone()
            if count["n"] >= 32:
                raise DomainError("PANEL_TICKET_LIMIT", "Wait one minute before opening another panel access link", 429)
            await conn.execute("INSERT INTO panel_tickets VALUES(%s,%s,%s,clock_timestamp()+interval '60 seconds')", (ticket_hash, origin, epoch))

    async def exchange_panel_ticket(self, ticket_hash: str, session_hash: str, origin: str, epoch: str,
                                    *, lifetime_seconds: int = 8 * 3600, client: str = ""):
        async with self.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(%s)", (PANEL_SESSION_LOCK,))
            await conn.execute("DELETE FROM panel_sessions WHERE expires_at<=clock_timestamp() OR epoch<>%s", (epoch,))
            count = await (await conn.execute("SELECT count(*) AS n FROM panel_sessions")).fetchone()
            if count["n"] >= 128:
                raise DomainError("PANEL_SESSION_LIMIT", "Close a panel session before opening another", 429)
            ticket = await (await conn.execute("DELETE FROM panel_tickets WHERE ticket_hash=%s AND origin=%s AND epoch=%s AND expires_at>clock_timestamp() RETURNING ticket_hash", (ticket_hash, origin, epoch))).fetchone()
            if ticket is None:
                return None
            row = await (await conn.execute(
                "INSERT INTO panel_sessions(session_hash,origin,epoch,expires_at,client) "
                "VALUES(%s,%s,%s,clock_timestamp()+make_interval(secs=>%s),%s) RETURNING expires_at",
                (session_hash, origin, epoch, lifetime_seconds, client[:80]))).fetchone()
            return row["expires_at"]

    async def panel_session(self, session_hash: str, origin: str, epoch: str, *, renew_seconds: int | None = None):
        """Returns the session expiry; with ``renew_seconds`` the expiry slides, written at most once per hour."""
        async with self.connection() as conn:
            row = await (await conn.execute(
                "SELECT expires_at,last_used_at<clock_timestamp()-interval '1 hour' AS stale FROM panel_sessions "
                "WHERE session_hash=%s AND origin=%s AND epoch=%s AND expires_at>clock_timestamp()",
                (session_hash, origin, epoch))).fetchone()
            if row is None:
                return None
            if renew_seconds is None or not row["stale"]:
                return row["expires_at"]
            renewed = await (await conn.execute(
                "UPDATE panel_sessions SET last_used_at=clock_timestamp(),"
                " expires_at=GREATEST(expires_at,clock_timestamp()+make_interval(secs=>%s))"
                " WHERE session_hash=%s AND expires_at>clock_timestamp() RETURNING expires_at",
                (renew_seconds, session_hash))).fetchone()
            return renewed["expires_at"] if renewed else None

    async def revoke_panel_session(self, session_hash: str):
        async with self.connection() as conn:
            await conn.execute("DELETE FROM panel_sessions WHERE session_hash=%s", (session_hash,))

    async def list_panel_sessions(self, origin: str, epoch: str) -> list[dict]:
        async with self.connection() as conn:
            return await (await conn.execute(
                "SELECT id,session_hash,client,created_at,last_used_at,expires_at FROM panel_sessions"
                " WHERE origin=%s AND epoch=%s AND expires_at>clock_timestamp() ORDER BY last_used_at DESC",
                (origin, epoch))).fetchall()

    async def revoke_panel_session_by_id(self, session_id: str, origin: str, epoch: str) -> bool:
        async with self.connection() as conn:
            row = await (await conn.execute(
                "DELETE FROM panel_sessions WHERE id=%s AND origin=%s AND epoch=%s RETURNING id",
                (session_id, origin, epoch))).fetchone()
            return row is not None

    async def create_project(self, project: Project, enqueue=None):
        async with self.connection() as conn:
            created = await (await conn.execute("INSERT INTO projects VALUES(%s,%s) ON CONFLICT DO NOTHING RETURNING id", (project.id, Jsonb(payload(project))))).fetchone()
            if created is None:
                raise DomainError("PROJECT_EXISTS", "This repository is already registered")
            if enqueue is not None:
                await enqueue(conn, project.id)
        return project

    async def projects(self, *, archived: bool = False) -> list[Project]:
        """Active projects; with archived=True, every project."""
        async with self.connection() as conn:
            cursor = await conn.execute("SELECT data FROM projects WHERE %s OR data->>'archived_at' IS NULL ORDER BY data->>'name'", (archived,))
            return [Project.model_validate(row["data"]) async for row in cursor]

    async def change_project(self, project_id: str, expected_revision: int, action: str, change) -> Project:
        """Apply one revision-checked change to a project and record it. `change` returns the fields to replace."""
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM projects WHERE id=%s FOR UPDATE", (project_id,))).fetchone()
            if not row:
                raise DomainError("PROJECT_NOT_FOUND", "Project not found", 404)
            project = Project.model_validate(row["data"])
            if project.revision != expected_revision:
                raise DomainError("PROJECT_CHANGED", "The project changed; refresh it before continuing", 409)
            if action == "archive":
                # A scheduled security report has no controls of its own, so it never holds a project open.
                open_run = await (await conn.execute(
                    """SELECT id FROM work_orders WHERE project_id=%s AND data->>'phase' IS DISTINCT FROM 'security_watch'
                       AND data->>'status' NOT IN ('completed','cancelled','failed') ORDER BY updated_at DESC LIMIT 1""",
                    (project_id,))).fetchone()
                if open_run:
                    raise DomainError("PROJECT_HAS_OPEN_RUNS", f"Run {open_run['id'][:8]} is not finished; cancel it or let it finish before archiving", 409)
            values = change(project)
            fields = sorted(key for key, value in values.items() if getattr(project, key) != value)
            if not fields:
                return project
            changed = Project.model_validate({**payload(project), **values, "revision": project.revision + 1})
            await conn.execute("UPDATE projects SET data=%s WHERE id=%s", (Jsonb(payload(changed)), project_id))
            await conn.execute("INSERT INTO project_events(project_id,revision,action,fields) VALUES(%s,%s,%s,%s)",
                               (project_id, changed.revision, action, Jsonb(fields)))
        return changed

    async def project(self, project_id: str) -> Project:
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM projects WHERE id=%s", (project_id,))).fetchone()
        if not row:
            raise DomainError("PROJECT_NOT_FOUND", "Project not found", 404)
        return Project.model_validate(row["data"])

    async def reconcile_admission(self, request: WorkOrderCreate) -> WorkOrder | None:
        async with self.connection() as conn:
            prior = await (await conn.execute("SELECT data,request_hash FROM work_orders WHERE idem=%s", (request.idempotency_key,))).fetchone()
        if prior is None:
            return None
        if prior["request_hash"] != digest(request.model_dump(mode="json")):
            raise DomainError("IDEMPOTENCY_CONFLICT", "The key already identifies another work order")
        return WorkOrder.model_validate(prior["data"])

    async def admit(self, work: WorkOrder, enqueue) -> WorkOrder:
        request = payload(work.model_copy())
        # The key is bound to the submitted request, not timestamps allocated by the server.
        for key in set(request) - set(WorkOrderCreate.model_fields):
            request.pop(key)
        request_hash = work.admission_request_digest or digest(request)
        async with self.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (work.idempotency_key,))
            prior = await (await conn.execute("SELECT data,request_hash FROM work_orders WHERE idem=%s", (work.idempotency_key,))).fetchone()
            if prior:
                if prior["request_hash"] != request_hash:
                    raise DomainError("IDEMPOTENCY_CONFLICT", "The key already identifies another work order")
                return WorkOrder.model_validate(prior["data"])
            # Shares the row with archiving, which takes it for update: one of the two sees the other.
            project = await (await conn.execute("SELECT data->>'archived_at' AS archived_at FROM projects WHERE id=%s FOR SHARE", (work.project_id,))).fetchone()
            if project and project["archived_at"]:
                raise DomainError("PROJECT_ARCHIVED", "This project is archived; restore it before launching a run", 409)
            await conn.execute("INSERT INTO work_orders(id,project_id,idem,request_hash,data) VALUES(%s,%s,%s,%s,%s)",
                               (work.id, work.project_id, work.idempotency_key, request_hash, Jsonb(payload(work))))
            # Enqueue in this same PostgreSQL transaction to avoid accepted-but-lost work.
            await enqueue(conn, work.id)
        return work

    async def work(self, work_id: str) -> WorkOrder:
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data,control FROM work_orders WHERE id=%s", (work_id,))).fetchone()
        if not row:
            raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
        work = WorkOrder.model_validate(row["data"])
        work.control = row["control"]
        return work

    async def works(self) -> list[WorkOrder]:
        async with self.connection() as conn:
            cursor = await conn.execute("SELECT data,control FROM work_orders ORDER BY updated_at DESC LIMIT 200")
            works = []
            async for row in cursor:
                work = WorkOrder.model_validate(row["data"])
                # The pending pause or cancel that the detail reports, so the list does not offer it again.
                work.control = row["control"]
                works.append(work)
            return works

    async def save(self, work: WorkOrder):
        async with self.connection() as conn:
            await conn.execute("""UPDATE work_orders SET data=%s::jsonb || CASE
                WHEN coalesce((data->>'budget_revision')::integer,0)>%s THEN
                jsonb_build_object('budget_revision',data->'budget_revision','effective_budget_policy',data->'effective_budget_policy')
                ELSE '{}'::jsonb END,updated_at=now() WHERE id=%s""", (Jsonb(payload(work)), work.budget_revision, work.id))

    async def _budget_authorization(self, conn, work, metric, before, after, operation, reason, usage_ids=None):
        work.budget_revision += 1
        setattr(work.effective_budget_policy, metric, after)
        receipt = BudgetAuthorization(revision=work.budget_revision, metric=metric, operation=operation,
                                      before=before, after=after, reason=reason, usage_ids=usage_ids or [])
        await conn.execute("INSERT INTO work_budget_authorizations(work_id,revision,data) VALUES(%s,%s,%s)",
            (work.id, work.budget_revision, Jsonb(receipt.model_dump(mode="json"))))
        await conn.execute("UPDATE work_orders SET data=%s,updated_at=now() WHERE id=%s", (Jsonb(payload(work)), work.id))
        event_id = new_id()
        message = f"Budget {operation}: {metric}; authorization revision {work.budget_revision}"
        await conn.execute("INSERT INTO work_events(id,work_id,kind,message) VALUES(%s,%s,'budget_authorization',%s)", (event_id, work.id, message))
        await conn.execute("INSERT INTO notifications VALUES(%s,%s,%s,false)", (event_id, work.id, Jsonb({"kind": "budget_authorization", "message": message})))

    async def _activate_budget(self, conn, work, metric, required, *, denial=None):
        before = getattr(work.effective_budget_policy, metric)
        after = activate_reserve(before, required)
        if after is None:
            if denial is None:
                used = {"active_seconds": work.active_seconds_used, "repairs": work.repair_cycles_used}.get(metric)
                denial = dispatch_denial(metric, used if used is not None else required,
                    max(0, required - used) if used is not None else 0, before.absolute, used=used,
                    reserved=0 if used is not None else None)
            raise DomainError("BUDGET_" + metric.upper(), f"The {metric} ceiling blocks the pending step", 409, budget_denial=denial)
        if after != before:
            await self._budget_authorization(conn, work, metric, before, after, "reserve_activation", "Activated the finite reserve authorized at launch")

    async def _check_budget_revision(self, conn, current, work):
        if current.budget_revision == work.budget_revision:
            return
        changed = await (await conn.execute("""SELECT 1 FROM work_budget_authorizations
            WHERE work_id=%s AND revision>%s AND data->>'operation' IN ('amend','usage_reconciliation') LIMIT 1""", (work.id, work.budget_revision))).fetchone()
        if changed:
            raise DomainError("STALE_BUDGET", "The budget changed during this invocation; resume from the preserved checkpoint", 409)

    async def ensure_budget_metric(self, work, metric, required):
        if work.effective_budget_policy is None:
            return
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM work_orders WHERE id=%s FOR UPDATE", (work.id,))).fetchone()
            current = WorkOrder.model_validate(row["data"])
            await self._check_budget_revision(conn, current, work)
            await self._activate_budget(conn, current, metric, required)
        work.effective_budget_policy, work.budget_revision = current.effective_budget_policy, current.budget_revision

    async def amend_budget(self, work_id, request):
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data,control FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            if row is None:
                raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
            work = WorkOrder.model_validate(row["data"])
            if work.status not in {Status.BLOCKED, Status.PAUSED} or row["control"] == "cancel":
                raise DomainError("PAUSE_REQUIRED", "Pause the run before amending its budget", 409)
            if work.budget_revision != request.expected_revision:
                raise DomainError("STALE_BUDGET", "The budget authorization changed; refresh before saving", 409)
            if work.effective_budget_policy is None:
                from sabre.budget_contracts import bounded
                work.effective_budget_policy = BudgetPolicy(version=1, tokens=bounded(work.budget.max_tokens),
                    invocations=bounded(work.budget.max_calls), active_seconds=bounded(work.budget.active_seconds),
                    repairs=bounded(work.flow_config.repair_cycles))
            before = getattr(work.effective_budget_policy, request.metric)
            await self._budget_authorization(conn, work, request.metric, before, request.policy, "amend", request.reason)
            return work

    async def unreconciled_usage(self, work_id):
        async with self.connection() as conn:
            return await (await conn.execute("""SELECT u.id FROM model_usage u WHERE u.work_id=%s AND u.actual_tokens IS NULL
                AND NOT EXISTS(SELECT 1 FROM work_budget_authorizations a WHERE a.work_id=u.work_id
                    AND a.data->>'operation'='usage_reconciliation' AND a.data->'usage_ids' ? u.id)
                ORDER BY u.created_at,u.id""", (work_id,))).fetchall()

    async def reconcile_budget_usage(self, work_id, request):
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            if row is None:
                raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
            work = WorkOrder.model_validate(row["data"])
            if work.status not in {Status.PAUSED, Status.BLOCKED}:
                raise DomainError("PAUSE_REQUIRED", "Pause the run before reconciling unknown usage", 409)
            if work.budget_revision != request.expected_revision:
                raise DomainError("STALE_BUDGET", "The authorization revision changed", 409)
            rows = await (await conn.execute("SELECT id FROM model_usage WHERE work_id=%s AND id=ANY(%s) AND actual_tokens IS NULL FOR UPDATE", (work_id, request.usage_ids))).fetchall()
            if {item["id"] for item in rows} != set(request.usage_ids) or len(set(request.usage_ids)) != len(request.usage_ids):
                raise DomainError("USAGE_RECONCILIATION_INVALID", "Select only current unsettled reservations of this run", 422)
            if work.effective_budget_policy is None:
                from sabre.budget_contracts import bounded
                work.effective_budget_policy = BudgetPolicy(version=1, tokens=bounded(work.budget.max_tokens), invocations=bounded(work.budget.max_calls), active_seconds=bounded(work.budget.active_seconds), repairs=bounded(work.flow_config.repair_cycles))
            selected = work.effective_budget_policy.tokens
            await self._budget_authorization(conn, work, "tokens", selected, selected, "usage_reconciliation",
                "Owner retained the complete reservations as unknown usage: " + request.reason, request.usage_ids)
            return work

    async def revise_scope(self, work_id: str, change: ScopeChange) -> WorkOrder:
        # The service holds the project lock; this row lock also serializes owner controls.
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data,control FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            if row is None:
                raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
            work = WorkOrder.model_validate(row["data"])
            if work.plan_revision != change.expected_revision:
                raise DomainError("STALE_PLAN", "The plan changed")
            if row["control"] == "cancel":
                raise DomainError("CANCEL_REQUESTED", "Requested cancellation must finish before changing the work order")
            if work.status not in {Status.PAUSED, Status.BLOCKED}:
                raise DomainError("PAUSE_REQUIRED", "Pause the work order before changing its scope")
            work.objective, work.acceptance = change.objective, change.acceptance
            work.plan_revision += 1
            work.tasks, work.questions, work.findings = [], [], []
            work.evidence, work.error_code, work.control = None, None, None
            work.security_snapshot_digest, work.security_rules_version = None, None
            work.phase, work.status, work.updated_at = "intake", Status.PAUSED, now()
            work.summary = "New revision saved; resume to prepare the workspace"
            await conn.execute("UPDATE work_orders SET data=%s,scope=%s,accepted_answer=NULL,control=NULL,updated_at=now() WHERE id=%s",
                               (Jsonb(payload(work)), Jsonb({"revision": work.plan_revision}), work_id))
            event_id, message = new_id(), f"New scope, revision {work.plan_revision}"
            await conn.execute("INSERT INTO work_events(id,work_id,kind,message) VALUES(%s,%s,'scope_changed',%s)", (event_id, work_id, message))
            await conn.execute("INSERT INTO notifications VALUES(%s,%s,%s,false)", (event_id, work_id, Jsonb({"kind": "scope_changed", "message": message})))
            return work

    async def pending_scope(self, work_id: str) -> int | None:
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT scope FROM work_orders WHERE id=%s", (work_id,))).fetchone()
        if row is None or row["scope"] is None:
            return None
        marker = row["scope"]
        if not isinstance(marker, dict) or set(marker) != {"revision"} or type(marker["revision"]) is not int or marker["revision"] < 1:
            raise DomainError("SCOPE_STATE_INVALID", "The pending revision is invalid")
        return marker["revision"]

    async def increase_token_budget(self, work_id: str, change: TokenBudgetIncrease) -> WorkOrder:
        return await self._increase_budget(work_id, "max_tokens", change.expected_revision, change.expected_max_tokens, change.max_tokens)

    async def increase_call_budget(self, work_id: str, change: CallBudgetIncrease) -> WorkOrder:
        return await self._increase_budget(work_id, "max_calls", change.expected_revision, change.expected_max_calls, change.max_calls)

    async def use_cli_progress_limits(self, work_id: str, change: CliProgressLimitsChange, model_revision: int) -> WorkOrder:
        async with self.connection() as conn:
            # Serialize with destination edits so the validated CLI selection is still current.
            await conn.execute("SELECT pg_advisory_xact_lock(813788)")
            selection = await (await conn.execute("SELECT revision FROM model_configuration WHERE singleton=true")).fetchone()
            if (selection["revision"] if selection else 0) != model_revision:
                raise DomainError("MODEL_CONFIGURATION_CHANGED", "Model configuration changed; refresh before continuing", 409)
            row = await (await conn.execute("SELECT data,control FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            if row is None:
                raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
            work = WorkOrder.model_validate(row["data"])
            if work.effective_budget_policy is not None:
                raise DomainError("VERSIONED_BUDGET_REQUIRED", "Use a revision-checked metric amendment for this run", 409)
            if work.plan_revision != change.expected_revision:
                raise DomainError("STALE_PLAN", "The plan changed")
            if work.budget != change.expected_budget:
                raise DomainError("STALE_BUDGET", "Limits changed; inspect the work order before retrying")
            if row["control"] == "cancel":
                raise DomainError("CANCEL_REQUESTED", "Requested cancellation must finish before changing limits")
            if work.status not in {Status.PAUSED, Status.BLOCKED}:
                raise DomainError("PAUSE_REQUIRED", "Pause the work order before changing its limit policy")
            if work.budget.max_cost_usd != 0 or work.cost_usd > 0:
                raise DomainError("MODEL_LIMITS_REQUIRED", "CLI progress controls require a work order without API budget or spend; retain its explicit quotas", 409)
            if work.budget.progress_limits:
                raise DomainError("CLI_PROGRESS_LIMITS_ACTIVE", "The work order already uses CLI progress controls")
            work.budget = Budget(max_calls=None, max_tokens=None, active_seconds=None, max_cost_usd=0)
            message = "The owner enabled CLI progress controls without cumulative quotas; all recorded usage is preserved"
            work.summary, work.updated_at = message + "; resuming is independent", now()
            work.control = row["control"]
            await conn.execute("UPDATE work_orders SET data=%s,updated_at=now() WHERE id=%s", (Jsonb(payload(work)), work_id))
            event_id = new_id()
            await conn.execute("INSERT INTO work_events(id,work_id,kind,message) VALUES(%s,%s,'cli_progress_limits',%s)", (event_id, work_id, message))
            await conn.execute("INSERT INTO notifications VALUES(%s,%s,%s,false)", (event_id, work_id, Jsonb({"kind": "cli_progress_limits", "message": message})))
            return work

    async def _increase_budget(self, work_id: str, field: Literal["max_tokens", "max_calls"], expected_revision: int, expected_limit: int, new_limit: int) -> WorkOrder:
        label = {"max_tokens": "tokens", "max_calls": "model calls"}[field]
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data,control FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            if row is None:
                raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
            work = WorkOrder.model_validate(row["data"])
            if work.plan_revision != expected_revision:
                raise DomainError("STALE_PLAN", "The plan changed")
            if work.effective_budget_policy is not None:
                raise DomainError("VERSIONED_BUDGET_REQUIRED", "Use a revision-checked metric amendment for this run", 409)
            if work.budget.progress_limits:
                raise DomainError("CLI_PROGRESS_LIMITS_ACTIVE", "Cumulative quotas are disabled; a nonexistent limit cannot be extended")
            if getattr(work.budget, field) != expected_limit:
                raise DomainError("STALE_BUDGET", f"The limit for {label} changed; inspect the work order before retrying")
            if row["control"] == "cancel":
                raise DomainError("CANCEL_REQUESTED", "Requested cancellation must finish before extending the limit")
            if work.status not in {Status.PAUSED, Status.BLOCKED}:
                raise DomainError("PAUSE_REQUIRED", f"Pause the work order before extending the limit for {label}")
            if new_limit <= expected_limit:
                raise DomainError("BUDGET_INCREASE_REQUIRED", f"The new limit for {label} must be higher", 422)
            setattr(work.budget, field, new_limit)
            message = f"Limit for {label} extended by the owner: {expected_limit} → {new_limit}"
            work.summary, work.updated_at = message + "; the state is preserved and resuming is independent", now()
            work.control = row["control"]
            await conn.execute("UPDATE work_orders SET data=%s,updated_at=now() WHERE id=%s", (Jsonb(payload(work)), work_id))
            event_id = new_id()
            await conn.execute("INSERT INTO work_events(id,work_id,kind,message) VALUES(%s,%s,'budget_increased',%s)", (event_id, work_id, message))
            await conn.execute("INSERT INTO notifications VALUES(%s,%s,%s,false)", (event_id, work_id, Jsonb({"kind": "budget_increased", "message": message})))
            return work

    async def acknowledge_scope(self, work_id: str, revision: int):
        async with self.connection() as conn:
            cursor = await conn.execute("UPDATE work_orders SET scope=NULL WHERE id=%s AND scope=%s AND data->>'plan_revision'=%s",
                                        (work_id, Jsonb({"revision": revision}), str(revision)))
            if cursor.rowcount != 1:
                raise DomainError("STALE_PLAN", "The pending revision changed")

    async def add_active_seconds(self, work_id: str, seconds: float):
        async with self.connection() as conn:
            await conn.execute("UPDATE work_orders SET data=jsonb_set(data,'{active_seconds_used}',to_jsonb(coalesce((data->>'active_seconds_used')::numeric,0)+%s::numeric)) WHERE id=%s", (seconds, work_id))

    async def event(self, work: WorkOrder, kind: str, message: str):
        async with self.connection() as conn:
            await self._record_event(conn, work, kind, message)

    async def _record_event(self, conn, work: WorkOrder, kind: str, message: str):
        event_id = new_id()
        await conn.execute("INSERT INTO work_events(id,work_id,kind,message) VALUES(%s,%s,%s,%s)", (event_id, work.id, kind, message))
        await conn.execute("INSERT INTO notifications VALUES(%s,%s,%s,false)", (event_id, work.id, Jsonb({"kind": kind, "message": message})))
        from sabre.notifications import enqueue_notifications
        await enqueue_notifications(conn, self.notification_destinations, event_id, work)

    async def record_execution_event(self, event: ExecutionEvent):
        async with self.connection() as conn:
            await conn.execute("INSERT INTO run_events(id,work_id,data) VALUES(%s,%s,%s) ON CONFLICT(id) DO NOTHING",
                (event.id, event.work_id, Jsonb(event.model_dump(mode="json"))))

    async def execution_events(self, work_id: str, after: int = 0, limit: int = 100) -> EventPage:
        if after < 0 or not 1 <= limit <= 200:
            raise DomainError("INVALID_CURSOR", "Use a non-negative cursor and a limit between 1 and 200", 422)
        async with self.connection() as conn:
            rows = await (await conn.execute("SELECT seq,data FROM run_events WHERE work_id=%s AND seq>%s ORDER BY seq LIMIT %s",
                (work_id, after, limit + 1))).fetchall()
        selected = rows[:limit]
        return EventPage(items=[SequencedEvent(sequence=row["seq"], event=ExecutionEvent.model_validate_json(json.dumps(row["data"]))) for row in selected],
                         next_cursor=selected[-1]["seq"] if selected else after, has_more=len(rows) > limit)

    async def events(self, work_id: str):
        async with self.connection() as conn:
            return await (await conn.execute("SELECT id,work_id,kind,message,created_at FROM work_events WHERE work_id=%s ORDER BY seq", (work_id,))).fetchall()

    async def command(self, work_id: str, command: str | None):
        async with self.connection() as conn:
            await conn.execute("UPDATE work_orders SET control=%s WHERE id=%s", (command, work_id))

    async def request_control(self, work_id: str, command: str):
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            if not row:
                raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
            work = WorkOrder.model_validate(row["data"])
            if work.status in {Status.COMPLETED, Status.CANCELLED}:
                raise DomainError("WORK_TERMINAL", "The work order has already finished")
            await conn.execute("UPDATE work_orders SET control=%s,updated_at=now() WHERE id=%s", (command, work_id))

    async def finalize_idle_control(self, work_id: str, command: str) -> bool:
        # The caller holds the project execution lock, so no workspace writer can race this transition.
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data,control FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            work = WorkOrder.model_validate(row["data"])
            if row["control"] != command or work.status in {Status.COMPLETED, Status.CANCELLED}:
                return False
            previous = work.status
            work.status = Status.PAUSED if command == "pause" else Status.CANCELLED
            work.control, work.updated_at = "pause" if command == "pause" else "cancel", now()
            work.summary = "Work order paused" if command == "pause" else "Work order cancelled"
            await conn.execute("UPDATE work_orders SET data=%s,updated_at=now() WHERE id=%s", (Jsonb(payload(work)), work_id))
            # Earlier error evidence is retained; record the owner's control in the same transaction, once.
            if work.status != previous:
                await self._record_event(conn, work, work.status.value, work.summary)
            return True

    async def control(self, work_id: str):
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT control FROM work_orders WHERE id=%s", (work_id,))).fetchone()
            return row["control"] if row else None

    async def idle_controls(self, project_id: str, running_id: str) -> list[tuple[str, str]]:
        """Pause and cancel requests still waiting on a project's resting runs, other than the one being driven.

        A request that arrives while another run of the project holds its lock is only recorded, and a resting
        run has no queued job that would apply it later."""
        async with self.connection() as conn:
            rows = await (await conn.execute(
                "SELECT id,control FROM work_orders WHERE project_id=%s AND id<>%s AND "
                "((control='cancel' AND data->>'status' IN ('blocked','failed','waiting_input','paused')) OR "
                "(control='pause' AND data->>'status' IN ('blocked','failed','waiting_input'))) ORDER BY updated_at,id",
                (project_id, running_id))).fetchall()
        return [(row["id"], row["control"]) for row in rows]

    async def answer(self, work_id: str, answer: dict, enqueue):
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data,accepted_answer FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            if not row:
                raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
            work = WorkOrder.model_validate(row["data"])
            question = next((q for q in work.questions if q.id == answer["question_id"]), None)
            if work.status != "waiting_input" or not question or question.answer is not None or row["accepted_answer"]:
                raise DomainError("QUESTION_CLOSED", "The question no longer accepts answers")
            if question.plan_revision != answer["plan_revision"] or work.plan_revision != answer["plan_revision"]:
                raise DomainError("STALE_PLAN", "The response belongs to another plan revision")
            question.answer, question.answered_at = answer["answer"], now()
            work.status, work.summary = Status.QUEUED, "Response received; resume queued"
            await conn.execute("UPDATE work_orders SET accepted_answer=%s,data=%s,updated_at=now() WHERE id=%s", (Jsonb(answer), Jsonb(payload(work)), work_id))
            await enqueue(conn, work_id)

    async def pending_answer(self, work_id: str):
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT accepted_answer FROM work_orders WHERE id=%s", (work_id,))).fetchone()
            return row["accepted_answer"] if row else None

    async def clear_answer(self, work_id: str, question_id: str | None = None):
        async with self.connection() as conn:
            await conn.execute("UPDATE work_orders SET accepted_answer=NULL WHERE id=%s AND (%s::text IS NULL OR accepted_answer->>'question_id'=%s)", (work_id, question_id, question_id))

    async def resume(self, work_id: str, enqueue):
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            if not row:
                raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
            work = WorkOrder.model_validate(row["data"])
            if work.status not in {Status.PAUSED, Status.BLOCKED, Status.FAILED}:
                raise DomainError("RESUME_NOT_ALLOWED", "The work order is not paused or blocked")
            work.status, work.error_code, work.summary = Status.QUEUED, None, "Resume queued"
            work.budget_denial, work.limiting_metric = None, None
            await conn.execute("UPDATE work_orders SET control=NULL,data=%s,updated_at=now() WHERE id=%s", (Jsonb(payload(work)), work_id))
            await enqueue(conn, work_id)
        return work

    @asynccontextmanager
    async def project_lock(self, project_id: str, *, execution_slot: bool = True):
        # Session locks are released by PostgreSQL when a dead worker disconnects.
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT pg_try_advisory_lock(hashtextextended(%s,1)) AS held", (project_id,))).fetchone()
            slot = None
            try:
                if row["held"] and execution_slot:
                    for candidate in range(913775, 913775 + self.execution_slots):
                        acquired = await (await conn.execute("SELECT pg_try_advisory_lock(%s) AS held", (candidate,))).fetchone()
                        if acquired["held"]:
                            slot = candidate
                            break
                yield bool(row["held"] and (not execution_slot or slot is not None))
            finally:
                if slot is not None:
                    await conn.execute("SELECT pg_advisory_unlock(%s)", (slot,))
                if row["held"]:
                    await conn.execute("SELECT pg_advisory_unlock(hashtextextended(%s,1))", (project_id,))

    async def reserve_usage(self, work: WorkOrder, tokens: int, usd: float, monthly_limit: float, *, context_receipt: ContextReceipt | dict | None = None):
        receipt = checked_receipt(context_receipt, work) if context_receipt is not None else None
        async with self.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(813772)")
            scope = await (await conn.execute("SELECT project_id,data->>'plan_revision' AS revision,data->'budget' AS budget,data FROM work_orders WHERE id=%s FOR UPDATE", (work.id,))).fetchone()
            if receipt is not None:
                if scope is None or scope["project_id"] != receipt.project_id or scope["revision"] != str(receipt.plan_revision):
                    raise DomainError("CONTEXT_RECEIPT_SCOPE", "The context reference does not belong to the current work order", 409)
            current_budget = Budget.model_validate(scope["budget"]) if scope is not None else None
            current = WorkOrder.model_validate(scope["data"]) if scope else None
            policy = current.effective_budget_policy if current else None
            missing_caps = any(cap is None for cap in (work.budget.max_calls, work.budget.max_tokens, work.budget.active_seconds))
            if policy is None and (missing_caps or (current_budget is not None and current_budget.progress_limits)):
                # A stale checkpoint or unpersisted object cannot authorize unlimited use.
                if current_budget != work.budget:
                    raise DomainError("STALE_BUDGET", "The limit policy changed; retrieve the current work order", 409)
                if receipt is None or receipt.model_provider not in {"codex_cli", "claude_cli"} or usd != 0:
                    raise DomainError("MODEL_LIMITS_REQUIRED", "This provider requires explicit quotas; progress mode only allows verified CLI sessions", 409)
            totals = await (await conn.execute("""SELECT count(*) calls,
                count(*) FILTER (WHERE actual_tokens IS NOT NULL) settled_calls,
                count(*) FILTER (WHERE actual_tokens IS NULL) unsettled_calls,
                coalesce(sum(coalesce(actual_tokens,reserved_tokens)),0) tokens,
                coalesce(sum(actual_tokens),0) measured_tokens,
                coalesce(sum(reserved_tokens) FILTER (WHERE actual_tokens IS NULL),0) reserved_tokens,
                coalesce(sum(coalesce(actual_usd,reserved_usd)),0) usd,
                coalesce(sum(actual_usd),0) measured_usd,
                coalesce(sum(reserved_usd) FILTER (WHERE actual_usd IS NULL),0) reserved_usd
                FROM model_usage WHERE work_id=%s""", (work.id,))).fetchone()
            monthly = await (await conn.execute("SELECT coalesce(sum(coalesce(actual_usd,reserved_usd)),0) usd FROM model_usage WHERE created_at>=date_trunc('month',now())")).fetchone()
            def token_denial(limit):
                return dispatch_denial("tokens", int(totals["tokens"]), tokens, limit,
                    used=int(totals["measured_tokens"]), reserved=int(totals["reserved_tokens"]))

            def call_denial(limit):
                return dispatch_denial("invocations", int(totals["calls"]), 1, limit,
                    used=int(totals["settled_calls"]), reserved=int(totals["unsettled_calls"]))

            def spend_denial():
                return dispatch_denial("api_spend", float(totals["usd"]), usd, work.budget.max_cost_usd,
                    used=float(totals["measured_usd"]), reserved=float(totals["reserved_usd"]))

            def factory_denial():
                return dispatch_denial("factory_spend", float(monthly["usd"]), usd, monthly_limit)
            if current is not None and policy is not None:
                await self._check_budget_revision(conn, current, work)
                await self._activate_budget(conn, current, "invocations", int(totals["calls"]) + 1,
                    denial=call_denial(policy.invocations.absolute) if policy.invocations.absolute is not None else None)
                await self._activate_budget(conn, current, "tokens", int(totals["tokens"]) + tokens,
                    denial=token_denial(policy.tokens.absolute) if policy.tokens.absolute is not None else None)
                await self._activate_budget(conn, current, "active_seconds", current.active_seconds_used + 0.001)
                if float(totals["usd"]) + usd > work.budget.max_cost_usd:
                    raise DomainError("BUDGET_API_SPEND", "The authorized API spend does not permit this invocation", 409, budget_denial=spend_denial())
                if usd > 0 and float(monthly["usd"]) + usd > monthly_limit:
                    raise DomainError("BUDGET_FACTORY_SPEND", "The factory spending ceiling does not permit this invocation", 409, budget_denial=factory_denial())
            denial = None
            if policy is None and work.budget.max_calls is not None and totals["calls"] >= work.budget.max_calls:
                denial = call_denial(work.budget.max_calls)
            elif policy is None and work.budget.max_tokens is not None and totals["tokens"] + tokens > work.budget.max_tokens:
                denial = token_denial(work.budget.max_tokens)
            elif float(totals["usd"]) + usd > work.budget.max_cost_usd:
                denial = spend_denial()
            elif usd > 0 and float(monthly["usd"]) + usd > monthly_limit:
                denial = factory_denial()
            if denial is not None:
                raise DomainError("BUDGET_EXHAUSTED", "The pending model-call reservation does not fit the authorized budget", budget_denial=denial)
            usage_id = new_id()
            await conn.execute("INSERT INTO model_usage(id,work_id,reserved_tokens,reserved_usd,context_receipt) VALUES(%s,%s,%s,%s,%s)", (usage_id, work.id, tokens, usd, Jsonb(payload(receipt)) if receipt is not None else None))
            if current is not None and policy is not None:
                work.effective_budget_policy, work.budget_revision = current.effective_budget_policy, current.budget_revision
            return usage_id

    async def check_dispatch_budget(self, work):
        current = await self.work(work.id)
        if current.effective_budget_policy is None:
            return
        async with self.connection() as conn:
            await self._check_budget_revision(conn, current, work)
        work.effective_budget_policy, work.budget_revision = current.effective_budget_policy, current.budget_revision
        totals = await self.usage(work.id)
        for metric, required in (("tokens", totals["tokens"]), ("invocations", totals["calls"]),
                                 ("active_seconds", current.active_seconds_used + 0.001)):
            await self.ensure_budget_metric(work, metric, required)

    async def settle_usage(self, usage_id: str, tokens: int, usd: float, *, breakdown: dict[str, int] | None = None):
        split = breakdown or {}
        async with self.connection() as conn:
            await conn.execute("""UPDATE model_usage SET actual_tokens=%s,actual_usd=%s,input_tokens=%s,output_tokens=%s,
                cache_read_tokens=%s,settled_at=clock_timestamp() WHERE id=%s""",
                (tokens, usd, split.get("input_tokens"), split.get("output_tokens"), split.get("cache_read_tokens"), usage_id))

    async def reserve_chat_usage(self, context_key: str, tokens: int, usd: float, monthly_limit: float, context_limit: float = 0.25):
        async with self.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(813772)")
            totals = await (await conn.execute("SELECT count(*) calls,coalesce(sum(coalesce(actual_tokens,reserved_tokens)),0) tokens,coalesce(sum(coalesce(actual_usd,reserved_usd)),0) usd FROM model_usage WHERE context_key=%s", (context_key,))).fetchone()
            monthly = await (await conn.execute("SELECT coalesce(sum(coalesce(actual_usd,reserved_usd)),0) usd FROM model_usage WHERE created_at>=date_trunc('month',now())")).fetchone()
            if totals["calls"] >= 8 or totals["tokens"] + tokens > 100000 or float(totals["usd"]) + usd > context_limit or (usd > 0 and float(monthly["usd"]) + usd > monthly_limit):
                raise DomainError("BUDGET_EXHAUSTED", "The budget does not allow another conversation or memory call")
            usage_id = new_id()
            await conn.execute("INSERT INTO model_usage(id,work_id,reserved_tokens,reserved_usd,context_key) VALUES(%s,NULL,%s,%s,%s)", (usage_id, tokens, usd, context_key))
            return usage_id

    async def usage(self, work_id: str):
        async with self.connection() as conn:
            return await (await conn.execute("SELECT count(*) calls,coalesce(sum(coalesce(actual_tokens,reserved_tokens)),0) tokens,coalesce(sum(coalesce(actual_usd,reserved_usd)),0) usd FROM model_usage WHERE work_id=%s", (work_id,))).fetchone()

    async def audit_usage(self, work_id: str) -> UsageSummary:
        return (await self.audit_usage_breakdown(work_id))["usage"]

    async def audit_usage_breakdown(self, work_id: str) -> UsageBreakdown:
        async with self.connection() as conn:
            row = await (await conn.execute("""
                SELECT count(*) calls,count(actual_tokens) settled_calls,
                    count(*) FILTER(WHERE actual_tokens IS NULL) unsettled_calls,
                    coalesce(sum(coalesce(actual_tokens,reserved_tokens)),0) tokens,
                    coalesce(sum(actual_tokens),0) measured_tokens,
                    coalesce(sum(reserved_tokens) FILTER(WHERE actual_tokens IS NULL),0) unknown_reserved_tokens,
                    coalesce(sum(coalesce(actual_usd,reserved_usd)),0) cost_usd,
                    sum(actual_usd) measured_api_cost_usd,
                    coalesce(sum(reserved_usd) FILTER(WHERE actual_usd IS NULL),0) reserved_api_cost_usd
                FROM model_usage WHERE work_id=%s
            """, (work_id,))).fetchone()
            usage = UsageSummary(calls=int(row["calls"]), settled_calls=int(row["settled_calls"]),
                unsettled_calls=int(row["unsettled_calls"]), tokens=int(row["tokens"]),
                measured_tokens=int(row["measured_tokens"]), unknown_reserved_tokens=int(row["unknown_reserved_tokens"]),
                cost_usd=float(row["cost_usd"]))
            return UsageBreakdown(usage=usage,
                measured_api_cost_usd=float(row["measured_api_cost_usd"]) if row["measured_api_cost_usd"] is not None else None,
                reserved_api_cost_usd=float(row["reserved_api_cost_usd"]))

    async def audit_calls(self, work_id: str, limit: int = 500) -> tuple[list[dict], bool]:
        """Per-call measurements in reservation order; unknown values stay NULL."""
        async with self.connection() as conn:
            rows = await (await conn.execute("""
                SELECT context_receipt->>'role' AS role,
                    context_receipt->>'model_provider' AS model_provider,
                    context_receipt->>'model_name' AS model_name,
                    reserved_tokens, actual_tokens, input_tokens, output_tokens, cache_read_tokens,
                    (context_receipt->>'sent_bytes')::bigint AS sent_bytes,
                    (context_receipt->>'original_bytes')::bigint AS original_bytes,
                    CASE WHEN settled_at IS NULL THEN NULL
                        ELSE greatest(0, (extract(epoch FROM settled_at-created_at)*1000)::bigint) END AS call_ms
                FROM model_usage WHERE work_id=%s ORDER BY created_at,id LIMIT %s
            """, (work_id, limit + 1))).fetchall()
        return [dict(row) for row in rows[:limit]], len(rows) > limit

    async def audit_execution_timings(self, work_id: str) -> list[dict]:
        """Measured agent and tool boundaries from content-free execution events."""
        async with self.connection() as conn:
            rows = await (await conn.execute("""
                SELECT data->>'kind' AS kind, data->>'agent_id' AS agent_id, data->>'name' AS name,
                    count(*) AS count,
                    count(*) FILTER(WHERE data->>'state'='failed') AS failed,
                    coalesce(sum((data->>'duration_ms')::bigint),0) AS total_ms,
                    coalesce(max((data->>'duration_ms')::bigint),0) AS max_ms,
                    sum((data->>'output_bytes')::bigint) AS output_bytes
                FROM run_events
                WHERE work_id=%s AND data->>'kind' IN ('agent','tool') AND data->>'state'<>'started'
                    AND data->>'agent_id' IS NOT NULL
                GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 1000
            """, (work_id,))).fetchall()
        return [dict(row) for row in rows]

    async def audit_context_usage(self, work_id: str) -> ContextUsageSummary | None:
        async with self.connection() as conn:
            rows = await (await conn.execute("SELECT context_receipt FROM model_usage WHERE work_id=%s", (work_id,))).fetchall()
        return aggregate_receipts([row["context_receipt"] for row in rows], work_id)

    async def audit_checkpoints(self, work_id: str, limit: int = 100) -> CheckpointInventory:
        # Only metadata is queried here; the official saver decodes checkpoint values.
        limit = min(max(limit, 1), 100)
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT count(*) count,count(DISTINCT thread_id) threads FROM checkpoints WHERE checkpoint_ns='' AND split_part(thread_id,'/',1)=%s", (work_id,))).fetchone()
            children = await (await conn.execute("SELECT thread_id FROM checkpoints WHERE checkpoint_ns='' AND split_part(thread_id,'/',1)=%s AND thread_id<>%s GROUP BY thread_id ORDER BY max(checkpoint_id) DESC LIMIT %s", (work_id, work_id, limit + 1))).fetchall()
            return {"count": int(row["count"]), "threads": int(row["threads"]), "child_threads": [r["thread_id"] for r in children[:limit]], "truncated": len(children) > limit}

    async def knowledge_inventory(self, project_id: str) -> KnowledgeInventory:
        async with self.connection() as conn:
            memories = await (await conn.execute("""SELECT count(*) total,
                count(*) FILTER(WHERE (data->>'active')::boolean AND data->>'invalidated_at' IS NULL) active,
                count(*) FILTER(WHERE NOT (data->>'active')::boolean AND data->>'invalidated_at' IS NULL) pending,
                count(*) FILTER(WHERE data->>'invalidated_at' IS NOT NULL) invalidated
                FROM memories WHERE project_id=%s""", (project_id,))).fetchone()
            checkpoints = await (await conn.execute("SELECT count(*) count,count(DISTINCT c.thread_id) threads FROM checkpoints c JOIN work_orders w ON split_part(c.thread_id,'/',1)=w.id WHERE c.checkpoint_ns='' AND w.project_id=%s", (project_id,))).fetchone()
            works = await (await conn.execute("SELECT id FROM work_orders WHERE project_id=%s ORDER BY updated_at DESC,id LIMIT 6", (project_id,))).fetchall()
            return {"memories": {k: int(v) for k, v in memories.items()}, "checkpoints": {k: int(v) for k, v in checkpoints.items()}, "work_ids": [r["id"] for r in works[:5]], "truncated": len(works) > 5}

    async def get_effect(self, key: str):
        async with self.connection() as conn:
            return await (await conn.execute("SELECT * FROM effects WHERE operation_key=%s", (key,))).fetchone()

    async def begin_command(self, key: str, request: dict):
        async with self.connection() as conn:
            created = await (await conn.execute("""INSERT INTO effects(operation_key,request_hash,state,result)
                VALUES(%s,%s,'pending',NULL) ON CONFLICT DO NOTHING RETURNING operation_key""", (key, digest(request)))).fetchone()
            if created:
                return None
            return await (await conn.execute("SELECT * FROM effects WHERE operation_key=%s", (key,))).fetchone()

    async def begin_effect(self, key: str, request: dict):
        async with self.connection() as conn:
            await conn.execute("INSERT INTO effects VALUES(%s,%s,'pending',NULL) ON CONFLICT DO NOTHING", (key, digest(request)))
            row = await (await conn.execute("SELECT * FROM effects WHERE operation_key=%s", (key,))).fetchone()
            if row["request_hash"] != digest(request):
                raise DomainError("EFFECT_CONFLICT", "The operation is bound to other data")
            return row

    async def finish_effect(self, key: str, result: dict):
        async with self.connection() as conn:
            await conn.execute("UPDATE effects SET state='completed',result=%s WHERE operation_key=%s", (Jsonb(result), key))

    async def report_security(self, work: WorkOrder):
        async with self.connection() as conn:
            for finding in work.findings:
                data = payload(finding) | {"work_id": work.id, "project_id": work.project_id}
                key = digest({"work": work.id, "revision": work.plan_revision, "finding": finding.fingerprint})
                await conn.execute("INSERT INTO security_reports(id,project_id,work_id,data) VALUES(%s,%s,%s,%s) ON CONFLICT(id) DO UPDATE SET data=excluded.data", (key, work.project_id, work.id, Jsonb(data)))

    async def security(self, project_id: str | None = None):
        async with self.connection() as conn:
            cursor = await conn.execute("SELECT data FROM security_reports WHERE (%s::text IS NULL OR project_id=%s) ORDER BY created_at DESC LIMIT 500", (project_id, project_id))
            return [r["data"] async for r in cursor]

    async def create_security_exception(self, work_id: str, request: SecurityExceptionCreate) -> SecurityException:
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM work_orders WHERE id=%s FOR UPDATE", (work_id,))).fetchone()
            if not row:
                raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
            work = WorkOrder.model_validate(row["data"])
            if work.status not in {Status.BLOCKED, Status.PAUSED}:
                raise DomainError("PAUSE_REQUIRED", "The exception requires a blocked or paused work order")
            if work.plan_revision != request.plan_revision or work.security_snapshot_digest != request.snapshot_digest or work.security_rules_version != request.rules_version:
                raise DomainError("STALE_SECURITY", "The exception does not match the current plan and security report")
            matches = [finding for finding in work.findings if finding.fingerprint == request.fingerprint]
            if not matches:
                raise DomainError("FINDING_NOT_FOUND", "The finding does not belong to the current report", 404)
            if any(finding.category in {"secret", "scanner_error"} for finding in matches):
                raise DomainError("SECURITY_EXCEPTION_FORBIDDEN", "Secrets and incomplete checks cannot be exempted", 422)
            moment = now()
            if not moment < request.expires_at <= moment + timedelta(days=30):
                raise DomainError("SECURITY_EXCEPTION_EXPIRY", "Expiration must be in the future and within thirty days", 422)
            exception_id = digest({"work_id": work_id, "request": payload(request)})
            prior = await (await conn.execute("SELECT data FROM security_exceptions WHERE id=%s", (exception_id,))).fetchone()
            if prior:
                existing = SecurityException.model_validate(prior["data"])
                if existing.revoked_at:
                    raise DomainError("SECURITY_EXCEPTION_REVOKED", "This approval was revoked; renewal requires a new decision")
                return existing
            existing_rows = await conn.execute("SELECT data FROM security_exceptions WHERE work_id=%s", (work_id,))
            async for existing_row in existing_rows:
                existing = SecurityException.model_validate(existing_row["data"])
                if existing.fingerprint == request.fingerprint and existing.plan_revision == request.plan_revision and existing.snapshot_digest == request.snapshot_digest and existing.rules_version == request.rules_version and not existing.revoked_at and existing.expires_at > moment:
                    raise DomainError("SECURITY_EXCEPTION_EXISTS", "The finding already has an active exception; revoke it before replacing it")
            exception = SecurityException(**request.model_dump(), id=exception_id, work_id=work_id, project_id=work.project_id, approved_at=moment)
            await conn.execute("INSERT INTO security_exceptions(id,work_id,project_id,data) VALUES(%s,%s,%s,%s)", (exception.id, work_id, work.project_id, Jsonb(payload(exception))))
            return exception

    async def security_exceptions(self, work_id: str) -> list[SecurityException]:
        await self.work(work_id)
        async with self.connection() as conn:
            cursor = await conn.execute("SELECT data FROM security_exceptions WHERE work_id=%s ORDER BY id", (work_id,))
            return [SecurityException.model_validate(row["data"]) async for row in cursor]

    async def revoke_security_exception(self, work_id: str, exception_id: str) -> SecurityException:
        async with self.connection() as conn:
            row = await (await conn.execute("SELECT data FROM security_exceptions WHERE id=%s AND work_id=%s FOR UPDATE", (exception_id, work_id))).fetchone()
            if not row:
                raise DomainError("SECURITY_EXCEPTION_NOT_FOUND", "Exception not found in this work order", 404)
            exception = SecurityException.model_validate(row["data"])
            if exception.revoked_at is None:
                exception.revoked_at = now()
                await conn.execute("UPDATE security_exceptions SET data=%s WHERE id=%s", (Jsonb(payload(exception)), exception.id))
            return exception

    async def audit_model_usage(self, work_id: str) -> list[dict]:
        async with self.connection() as conn:
            rows = await (await conn.execute("""
                SELECT context_receipt->>'model_provider' AS model_provider,
                    context_receipt->>'model_name' AS model_name,
                    context_receipt->>'role' AS role,
                    (context_receipt->>'model_configuration_revision')::bigint AS configuration_revision,
                    count(*) AS calls, count(actual_tokens) AS settled_calls,
                    coalesce(sum(actual_tokens),0) AS measured_tokens,
                    coalesce(sum(reserved_tokens) FILTER(WHERE actual_tokens IS NULL),0) AS unknown_reserved_tokens,
                    coalesce(sum(coalesce(actual_usd,reserved_usd)),0) AS cost_usd,
                    sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
                    sum(cache_read_tokens) AS cache_read_tokens,
                    count(*) FILTER(WHERE actual_tokens IS NOT NULL AND input_tokens IS NULL) AS unsplit_calls
                FROM model_usage WHERE work_id=%s GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
            """, (work_id,))).fetchall()
        return [{**row, "cost_usd": float(row["cost_usd"]),
                 **{key: int(row[key]) if row[key] is not None else None for key in ("input_tokens", "output_tokens", "cache_read_tokens")},
                 "unsplit_calls": int(row["unsplit_calls"])} for row in rows]
