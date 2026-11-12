"""Owner confirmations: high-impact MCP requests wait for the owner in the console.

An MCP client acts with the owner's authority but is not the owner. A budget increase or a
security exception requested there is stored as a proposal and changes nothing. Only a
paired browser can confirm it, and confirming runs the same service operation the console
uses, with its own revision checks. Rows are kept as the record of what was asked and decided.
"""

import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, NamedTuple

from fastapi import FastAPI, Request
from psycopg.types.json import Jsonb
from pydantic import Field, ValidationError

from sabre.budget_contracts import BudgetAmendment, BudgetReconciliation
from sabre.contracts import StrictContract
from sabre.models import (
    CallBudgetIncrease,
    CliProgressLimitsChange,
    Contract,
    DomainError,
    SecurityExceptionCreate,
    Status,
    TokenBudgetIncrease,
    new_id,
)

OWNER_CONFIRMATION_SCHEMA = """
CREATE TABLE owner_confirmations(
 id text PRIMARY KEY, kind text NOT NULL,
 work_id text NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
 source text NOT NULL, request jsonb NOT NULL, request_digest text NOT NULL, summary text NOT NULL,
 state text NOT NULL DEFAULT 'pending'
   CHECK(state IN ('pending','applying','applied','rejected','failed','expired')),
 error_code text, error_message text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL, decided_at timestamptz);
CREATE UNIQUE INDEX owner_confirmations_pending
 ON owner_confirmations(kind,work_id,request_digest) WHERE state='pending';
CREATE INDEX owner_confirmations_recent ON owner_confirmations(created_at DESC);
"""

PENDING_HOURS = 24
PENDING_LIMIT = 20
RECENT_DECIDED = 20

ConfirmationKind = Literal["budget.tokens", "budget.calls", "budget.cli_progress", "budget.amend",
                           "budget.reconcile", "security.exception"]
ConfirmationState = Literal["pending", "applying", "applied", "rejected", "failed", "expired"]


class OwnerConfirmation(StrictContract):
    version: Literal[1] = 1
    id: str
    kind: ConfirmationKind
    work_id: str
    source: Literal["mcp"]
    state: ConfirmationState
    summary: str
    request: dict[str, Any]
    request_digest: str
    created_at: datetime
    expires_at: datetime
    decided_at: datetime | None = None
    error_code: str | None = None
    error_message: str | None = None


class OwnerConfirmationPage(StrictContract):
    version: Literal[1] = 1
    pending: int
    items: list[OwnerConfirmation]


class ConfirmationDecision(StrictContract):
    """The owner decides exactly the request the console displayed."""

    version: Literal[1]
    request_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class Operation(NamedTuple):
    model: type[Contract]
    apply: Callable[[Any, str, Any], Awaitable[Any]]
    summary: Callable[[Any], str]


_METRICS = {"tokens": "token", "invocations": "model call", "active_seconds": "active time", "repairs": "repair"}


def _amendment(request: BudgetAmendment) -> str:
    policy = request.policy
    limit = "no limit" if policy.primary is None else f"{policy.primary:,}"
    if policy.reserve:
        limit += f" plus a reserve of {policy.reserve:,}"
    return f"Change the {_METRICS[request.metric]} budget to {limit}" + (", then resume the run" if request.resume else "")


def _reconciliation(request: BudgetReconciliation) -> str:
    count = len(request.usage_ids)
    return f"Reconcile {count} uncertain usage record{'' if count == 1 else 's'}"


OPERATIONS: dict[str, Operation] = {
    "budget.tokens": Operation(TokenBudgetIncrease, lambda service, work_id, request: service.increase_token_budget(work_id, request),
        lambda request: f"Raise the token limit from {request.expected_max_tokens:,} to {request.max_tokens:,}"),
    "budget.calls": Operation(CallBudgetIncrease, lambda service, work_id, request: service.increase_call_budget(work_id, request),
        lambda request: f"Raise the model call limit from {request.expected_max_calls:,} to {request.max_calls:,}"),
    "budget.cli_progress": Operation(CliProgressLimitsChange, lambda service, work_id, request: service.use_cli_progress_limits(work_id, request),
        lambda request: "Replace the cumulative quotas with CLI progress controls"),
    "budget.amend": Operation(BudgetAmendment, lambda service, work_id, request: service.amend_budget(work_id, request), _amendment),
    "budget.reconcile": Operation(BudgetReconciliation, lambda service, work_id, request: service.reconcile_budget_usage(work_id, request),
        _reconciliation),
    "security.exception": Operation(SecurityExceptionCreate, lambda service, work_id, request: service.approve_security_exception(work_id, request),
        lambda request: f"Accept security finding {request.fingerprint} until {request.expires_at.astimezone(UTC):%Y-%m-%d}"),
}


class PostgresConfirmations:
    """Durable store. Expiry is materialized lazily so an expired proposal never blocks a new one."""

    def __init__(self, repository):
        self.repository = repository

    async def add(self, kind, work_id, source, request, request_digest, summary) -> tuple[dict, bool]:
        async with self.repository.connection() as conn:
            # One writer at a time keeps the pending cap and the duplicate check exact.
            await conn.execute("SELECT pg_advisory_xact_lock(813775)")
            await conn.execute("UPDATE owner_confirmations SET state='expired' WHERE state='pending' AND expires_at<=clock_timestamp()")
            prior = await (await conn.execute(
                "SELECT * FROM owner_confirmations WHERE state='pending' AND kind=%s AND work_id=%s AND request_digest=%s",
                (kind, work_id, request_digest))).fetchone()
            if prior:
                return prior, False
            count = await (await conn.execute("SELECT count(*) AS n FROM owner_confirmations WHERE state='pending'")).fetchone()
            if count["n"] >= PENDING_LIMIT:
                raise DomainError("CONFIRMATION_QUEUE_FULL", "Too many requests are waiting for the owner; wait for a decision", 429)
            row = await (await conn.execute(
                "INSERT INTO owner_confirmations(id,kind,work_id,source,request,request_digest,summary,expires_at) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,clock_timestamp()+%s) RETURNING *",
                (new_id(), kind, work_id, source, Jsonb(request), request_digest, summary, timedelta(hours=PENDING_HOURS)))).fetchone()
            return row, True

    async def page(self) -> tuple[list[dict], int]:
        async with self.repository.connection() as conn:
            await conn.execute("UPDATE owner_confirmations SET state='expired' WHERE state='pending' AND expires_at<=clock_timestamp()")
            pending = await (await conn.execute("SELECT * FROM owner_confirmations WHERE state='pending' ORDER BY created_at")).fetchall()
            decided = await (await conn.execute(
                "SELECT * FROM owner_confirmations WHERE state<>'pending' ORDER BY COALESCE(decided_at,expires_at) DESC LIMIT %s",
                (RECENT_DECIDED,))).fetchall()
        return [*pending, *decided], len(pending)

    async def get(self, identifier) -> dict | None:
        async with self.repository.connection() as conn:
            return await (await conn.execute("SELECT * FROM owner_confirmations WHERE id=%s", (identifier,))).fetchone()

    async def claim(self, identifier, request_digest, state) -> dict | None:
        async with self.repository.connection() as conn:
            return await (await conn.execute(
                "UPDATE owner_confirmations SET state=%s,decided_at=clock_timestamp() "
                "WHERE id=%s AND request_digest=%s AND state='pending' AND expires_at>clock_timestamp() RETURNING *",
                (state, identifier, request_digest))).fetchone()

    async def finish(self, identifier, state, code, message) -> dict:
        async with self.repository.connection() as conn:
            return await (await conn.execute(
                "UPDATE owner_confirmations SET state=%s,error_code=%s,error_message=%s WHERE id=%s AND state='applying' RETURNING *",
                (state, code, message, identifier))).fetchone()


class OwnerConfirmations:
    def __init__(self, service, store=None):
        self.service = service
        self.store = store or PostgresConfirmations(service.repository)

    @staticmethod
    def _view(row: dict) -> OwnerConfirmation:
        values = {key: row[key] for key in OwnerConfirmation.model_fields if key in row}
        if values["state"] == "pending" and values["expires_at"] <= datetime.now(UTC):
            values["state"] = "expired"
        return OwnerConfirmation(**values)

    async def request(self, kind: ConfirmationKind, work_id: str, request: Contract, source: Literal["mcp"] = "mcp") -> OwnerConfirmation:
        """Store a proposal. Nothing about the run changes here."""
        from sabre.repository import digest

        operation = OPERATIONS[kind]
        if not isinstance(request, operation.model):
            raise DomainError("CONFIRMATION_INVALID", "The request does not match this operation", 422)
        data = request.model_dump(mode="json")
        self.service.guard.check(data)
        work = await self.service.repository.work(work_id)
        if work.status in {Status.COMPLETED, Status.CANCELLED}:
            raise DomainError("WORK_TERMINAL", "The work order has already finished")
        summary = operation.summary(request)
        row, created = await self.store.add(kind, work_id, source, data, digest({"kind": kind, "work_id": work_id, "request": data}), summary)
        if created:
            await self.service.repository.event(work, "owner_confirmation_requested",
                f"An MCP client asked the owner to confirm: {summary}. Decide it in the console")
        return self._view(row)

    async def list(self) -> OwnerConfirmationPage:
        rows, pending = await self.store.page()
        return OwnerConfirmationPage(pending=pending, items=[self._view(row) for row in rows])

    async def get(self, identifier: str) -> OwnerConfirmation:
        row = await self.store.get(identifier)
        if row is None:
            raise DomainError("CONFIRMATION_NOT_FOUND", "This confirmation request does not exist", 404)
        return self._view(row)

    async def _claim(self, identifier: str, decision: ConfirmationDecision, state: str) -> dict:
        row = await self.store.claim(identifier, decision.request_digest, state)
        if row is not None:
            return row
        current = await self.get(identifier)
        if current.request_digest != decision.request_digest:
            raise DomainError("CONFIRMATION_CHANGED", "This is not the request that was displayed; refresh before deciding", 409)
        raise DomainError("CONFIRMATION_CLOSED", "This request was already decided or has expired", 409)

    async def reject(self, identifier: str, decision: ConfirmationDecision) -> OwnerConfirmation:
        return self._view(await self._claim(identifier, decision, "rejected"))

    async def confirm(self, identifier: str, decision: ConfirmationDecision) -> OwnerConfirmation:
        """Apply the stored request once. The claim precedes the effect, so a second click cannot repeat it."""
        row = await self._claim(identifier, decision, "applying")
        operation = OPERATIONS[row["kind"]]
        try:
            request = operation.model.model_validate_json(json.dumps(row["request"]))
            await operation.apply(self.service, row["work_id"], request)
        except ValidationError:
            return self._view(await self.store.finish(identifier, "failed", "CONFIRMATION_INVALID", "The stored request is no longer valid"))
        except DomainError as error:
            return self._view(await self.store.finish(identifier, "failed", error.code, error.message))
        # Any other failure leaves the row in "applying": the outcome is unknown and is never retried.
        return self._view(await self.store.finish(identifier, "applied", None, None))


def install_confirmation_routes(app: FastAPI, service):
    def manager() -> OwnerConfirmations:
        return service().owner_confirmations()

    def paired_browser(request: Request):
        # The owner credential alone is what an agent may hold; a decision needs the console.
        if not hasattr(request.state, "panel_session"):
            raise DomainError("CONSOLE_CONFIRMATION_REQUIRED", "Decide this request in the SABRE console", 403)

    @app.get("/api/v1/confirmations", response_model=OwnerConfirmationPage)
    async def confirmations():
        return await manager().list()

    @app.post("/api/v1/confirmations/{confirmation_id}/confirm", response_model=OwnerConfirmation)
    async def confirm(request: Request, confirmation_id: str, body: ConfirmationDecision):
        paired_browser(request)
        return await manager().confirm(confirmation_id, body)

    @app.post("/api/v1/confirmations/{confirmation_id}/reject", response_model=OwnerConfirmation)
    async def reject(request: Request, confirmation_id: str, body: ConfirmationDecision):
        paired_browser(request)
        return await manager().reject(confirmation_id, body)
