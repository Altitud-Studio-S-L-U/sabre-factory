"""Revocable delegated principals. Only the owner API may issue these grants."""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from psycopg.types.json import Jsonb
from pydantic import Field

from sabre.budget_contracts import BudgetPolicy, bounded
from sabre.commands import CommandEnvelope, Control, Respond, Submit, dispatch
from sabre.contracts import StrictContract
from sabre.models import DomainError

DELEGATION_SCHEMA = """
CREATE TABLE delegated_grants(
 id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, principal text NOT NULL,
 data jsonb NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE delegated_commands(
 grant_id text NOT NULL REFERENCES delegated_grants(id), message_id text NOT NULL,
 command_id text NOT NULL, work_id text, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(grant_id,message_id));
CREATE TABLE a2a_agent_cards(
 name text PRIMARY KEY, endpoint text NOT NULL, revision integer NOT NULL,
 card jsonb NOT NULL, digest text NOT NULL, enabled boolean NOT NULL DEFAULT false,
 projects jsonb NOT NULL, roles jsonb NOT NULL, skills jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE a2a_tasks(
 attempt_key text PRIMARY KEY, work_id text NOT NULL REFERENCES work_orders(id),
 agent_name text NOT NULL REFERENCES a2a_agent_cards(name), card_digest text NOT NULL,
 request_hash text NOT NULL, message_id text NOT NULL, remote_task_id text,
 remote_context_id text, state text NOT NULL, result jsonb, cost_usd numeric,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
"""


class GrantLimits(StrictContract):
    principal: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.-]+$")
    projects: list[str] = Field(min_length=1, max_length=30)
    operations: list[Literal["work.submit", "work.query", "work.answer", "work.cancel"]] = Field(min_length=1, max_length=4)
    expires_in: int = Field(ge=60, le=86400, strict=True)
    max_calls: int = Field(ge=1, le=500, strict=True)
    max_tokens: int = Field(ge=1, le=10000000, strict=True)
    max_cost_usd: float = Field(ge=0, le=1000)
    active_seconds: int = Field(ge=60, le=86400, strict=True)
    max_runs: int = Field(ge=1, le=100, strict=True)


class GrantCreate(GrantLimits):
    version: Literal[1]
    idempotency_key: str = Field(min_length=8, max_length=200, pattern=r"^[A-Za-z0-9_.:-]+$")


class GrantIssued(StrictContract):
    version: Literal[1] = 1
    id: str
    principal: str
    token: str | None
    expires_at: datetime
    recovered: bool


class GrantView(StrictContract):
    version: Literal[1] = 1
    id: str
    principal: str
    data: GrantLimits
    expires_at: datetime
    revoked_at: datetime | None
    created_at: datetime


class GrantRevoked(StrictContract):
    version: Literal[1] = 1
    id: str
    revoked: Literal[True] = True
    revoked_at: datetime


class Delegations:
    def __init__(self, service):
        self.service = service
        self.repository = service.repository

    async def issue(self, request: GrantCreate) -> GrantIssued:
        from sabre.repository import digest

        if request.principal.casefold() in {"owner", "supervisor", "system", "admin"}:
            raise DomainError("DELEGATION_PRINCIPAL_INVALID", "Choose a distinct external principal", 422)
        for project_id in request.projects:
            await self.repository.project(project_id)
        key = "delegation-issue-v1:" + digest(request.idempotency_key)
        request_hash = digest(request.model_dump(mode="json"))
        limits = GrantLimits.model_validate(request.model_dump(exclude={"version", "idempotency_key"}))
        async with self.repository.connection() as conn:
            # Grant insertion and the token-free receipt commit together. A lost
            # response never permits another bearer to be minted for this key.
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (key,))
            prior = await (await conn.execute("SELECT request_hash,result FROM effects WHERE operation_key=%s", (key,))).fetchone()
            if prior:
                if prior["request_hash"] != request_hash:
                    raise DomainError("IDEMPOTENCY_CONFLICT", "This key already identifies a different delegated grant", 409)
                metadata = prior["result"]
                return GrantIssued(id=metadata["id"], principal=metadata["principal"],
                    expires_at=datetime.fromisoformat(metadata["expires_at"]), token=None, recovered=True)
            identifier = secrets.token_hex(16)
            token = "sabre_d_" + secrets.token_urlsafe(32)
            expires = datetime.now(UTC) + timedelta(seconds=request.expires_in)
            await conn.execute("INSERT INTO delegated_grants(id,token_hash,principal,data,expires_at) VALUES(%s,%s,%s,%s,%s)",
                (identifier, hashlib.sha256(token.encode()).hexdigest(), request.principal, Jsonb(limits.model_dump()), expires))
            metadata = {"id": identifier, "principal": request.principal, "expires_at": expires.isoformat()}
            await conn.execute("INSERT INTO effects(operation_key,request_hash,state,result) VALUES(%s,%s,'completed',%s)",
                (key, request_hash, Jsonb(metadata)))
        # The bearer appears once in the owner's response, never in receipts or events.
        return GrantIssued(id=identifier, principal=request.principal, token=token, expires_at=expires, recovered=False)

    async def list(self) -> list[GrantView]:
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT id,principal,data,expires_at,revoked_at,created_at FROM delegated_grants ORDER BY created_at DESC LIMIT 100")).fetchall()
        return [GrantView(**row) for row in rows]

    async def revoke(self, identifier: str) -> GrantRevoked:
        async with self.repository.connection() as conn:
            row = await (await conn.execute("UPDATE delegated_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=%s RETURNING id,revoked_at", (identifier,))).fetchone()
        if row is None:
            raise DomainError("DELEGATION_NOT_FOUND", "The delegated grant does not exist", 404)
        return GrantRevoked(**row)

    async def authenticate(self, authorization: str):
        token = authorization.removeprefix("Bearer ")
        if not authorization.startswith("Bearer sabre_d_") or len(token) > 128:
            raise DomainError("DELEGATION_REQUIRED", "Use an active delegated credential", 401)
        async with self.repository.connection() as conn:
            grant = await (await conn.execute("SELECT id,principal,data FROM delegated_grants WHERE token_hash=%s AND revoked_at IS NULL AND expires_at>clock_timestamp()",
                (hashlib.sha256(token.encode()).hexdigest(),))).fetchone()
        if grant is None:
            raise DomainError("DELEGATION_EXPIRED", "The delegated credential is expired or revoked", 401)
        return grant

    async def check(self, identifier, project_id, operation):
        async with self.repository.connection() as conn:
            grant = await (await conn.execute("SELECT id,principal,data FROM delegated_grants WHERE id=%s AND revoked_at IS NULL AND expires_at>clock_timestamp()", (identifier,))).fetchone()
        if grant is None:
            raise DomainError("DELEGATION_EXPIRED", "The delegated credential is expired or revoked", 401)
        if project_id not in grant["data"]["projects"] or operation not in grant["data"]["operations"]:
            raise DomainError("DELEGATION_DENIED", "The delegated grant does not permit this project or operation", 403)
        return grant

    async def query(self, grant_id, work_id):
        work = await self.repository.work(work_id)
        await self.check(grant_id, work.project_id, "work.query")
        async with self.repository.connection() as conn:
            owned = await (await conn.execute("SELECT 1 FROM delegated_commands WHERE grant_id=%s AND work_id=%s", (grant_id, work_id))).fetchone()
        if not owned:
            raise DomainError("DELEGATION_DENIED", "This run is not assigned to this grant", 403)
        return work

    async def execute(self, grant_id, message_id, envelope: CommandEnvelope):
        from sabre.repository import digest

        payload = envelope.payload
        if not isinstance(payload, Submit | Control | Respond):
            raise DomainError("DELEGATION_DENIED", "This owner operation is outside delegated grants", 403)
        if isinstance(payload, Submit):
            project_id, operation = payload.request.project_id, "work.submit"
        else:
            work = await self.query(grant_id, payload.work_id)
            project_id = work.project_id
            if isinstance(payload, Control):
                if payload.action != "cancel":
                    raise DomainError("DELEGATION_DENIED", "Delegated control supports cancellation only", 403)
                operation = "work.cancel"
            else:
                operation = "work.answer"
                question = next((item for item in work.questions if item.id == payload.answer.question_id), None)
                if question is None or question.kind != "clarification":
                    raise DomainError("DELEGATION_APPROVAL_DENIED", "Delegated answers cannot approve architecture, publication, permissions or policy changes", 403)
        grant = await self.check(grant_id, project_id, operation)
        if isinstance(payload, Submit):
            budget = payload.request.budget
            if budget.policy is not None or payload.request.flow_config.budget_policy is not None:
                raise DomainError("DELEGATION_BUDGET_DENIED", "Delegated submission requires explicit finite cumulative limits", 403)
            if any(getattr(budget, name) is None or getattr(budget, name) > grant["data"][name]
                   for name in ("max_calls", "max_tokens", "max_cost_usd", "active_seconds")):
                raise DomainError("DELEGATION_BUDGET_DENIED", "The run exceeds its delegated limits", 403)
        # Namespace caller keys: neither a prompt nor another grant can replay owner receipts.
        request_hash = digest(envelope.model_dump(mode="json"))
        if isinstance(payload, Submit):
            policy = BudgetPolicy(version=1, tokens=bounded(budget.max_tokens), invocations=bounded(budget.max_calls),
                active_seconds=bounded(budget.active_seconds), repairs=bounded(min(payload.request.flow_config.repair_cycles, 2)))
            permissions = payload.request.flow_config.permissions.model_copy(update={"draft_pull_request": False, "dependency_changes": False, "architecture": False})
            flow = payload.request.flow_config.model_copy(update={"permissions": permissions, "budget_policy": policy})
            request = payload.request.model_copy(update={"budget": budget.model_copy(update={"policy": policy}),
                "flow_config": flow, "channel": "api", "channel_thread": "delegated:" + grant_id})
            envelope = envelope.model_copy(update={"payload": payload.model_copy(update={"request": request})})
        key = "delegated:" + digest({"grant": grant_id, "key": envelope.idempotency_key})
        envelope = envelope.model_copy(update={"idempotency_key": key})
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("grant:" + grant_id,))
            prior = await (await conn.execute("SELECT request_hash FROM delegated_commands WHERE grant_id=%s AND message_id=%s", (grant_id, message_id))).fetchone()
            if prior and prior["request_hash"] != request_hash:
                raise DomainError("IDEMPOTENCY_CONFLICT", "This message already identifies a different command", 409)
            if not prior and isinstance(payload, Submit):
                count = await (await conn.execute("SELECT count(DISTINCT work_id)+count(*) FILTER (WHERE work_id IS NULL) AS count FROM delegated_commands WHERE grant_id=%s", (grant_id,))).fetchone()
                if count["count"] >= grant["data"]["max_runs"]:
                    raise DomainError("DELEGATION_RUN_LIMIT", "This grant exhausted its run admission limit", 403)
            await conn.execute("INSERT INTO delegated_commands(grant_id,message_id,command_id,request_hash) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING", (grant_id, message_id, key, request_hash))
        await self.check(grant_id, project_id, operation)
        result = await dispatch(self.service, envelope)
        async with self.repository.connection() as conn:
            await conn.execute("UPDATE delegated_commands SET work_id=%s WHERE grant_id=%s AND message_id=%s", (result.work_id, grant_id, message_id))
        return result


async def authorize_delegated_work(repository, work):
    """Recheck the admission principal before worker/model/tool effects."""
    binding = work.channel_thread or ""
    if not binding.startswith("delegated:"):
        return
    identifier = binding.removeprefix("delegated:")
    async with repository.connection() as conn:
        row = await (await conn.execute("SELECT data FROM delegated_grants WHERE id=%s AND revoked_at IS NULL AND expires_at>clock_timestamp()", (identifier,))).fetchone()
    if row is None or work.project_id not in row["data"]["projects"] or "work.submit" not in row["data"]["operations"]:
        raise DomainError("DELEGATION_EXPIRED", "The run's originating delegated grant expired or was revoked", 403)
