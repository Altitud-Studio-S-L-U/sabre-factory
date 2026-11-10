"""Immutable repository proposals, owner approval and at-most-once GitHub creation."""

import asyncio
import hashlib
import json
from typing import Literal

import httpx
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import Field, ValidationError, field_validator

from sabre.integrations import OWNER_PATTERN, REPO_PATTERN
from sabre.models import AwareTimestamp, Contract, DomainError, new_id

REPO_CREATION_SCHEMA = """
CREATE TABLE IF NOT EXISTS repository_proposals (
    id text PRIMARY KEY,
    request_key text NOT NULL UNIQUE,
    target_key text NOT NULL,
    request_digest text NOT NULL,
    request jsonb NOT NULL,
    status text NOT NULL DEFAULT 'proposed',
    revision integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    approved_at timestamptz,
    started_at timestamptz,
    receipt jsonb,
    candidate jsonb,
    error_code text
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_proposals_active_target ON repository_proposals(target_key)
    WHERE status IN ('proposed','approved','executing','reconciliation_required');
"""


class RepoCreationRequest(Contract):
    owner_type: Literal["user", "org"]
    owner: str = Field(pattern=OWNER_PATTERN)
    name: str = Field(pattern=REPO_PATTERN)
    visibility: Literal["private", "public"] = "private"
    description: str = Field(default="", max_length=350)
    initialize: bool = Field(default=False, strict=True)
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        if value in {".", ".."}:
            raise ValueError("Invalid repository name")
        return value

    @field_validator("description")
    @classmethod
    def single_line(cls, value):
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("Use a single-line description")
        return value.strip()


class RepoCreationDecision(Contract):
    expected_revision: int = Field(ge=0, strict=True)
    request_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    decision: Literal["approve", "reject"]


class CreatedRepository(Contract):
    id: int = Field(gt=0, strict=True)
    full_name: str
    url: str
    visibility: Literal["private", "public"]
    created_at: AwareTimestamp
    default_branch: str | None = None


class RepoCreationProposal(Contract):
    id: str
    request: RepoCreationRequest
    request_digest: str
    status: Literal["proposed", "approved", "rejected", "executing", "created", "conflict", "failed", "reconciliation_required"]
    revision: int
    created_at: AwareTimestamp
    updated_at: AwareTimestamp
    approved_at: AwareTimestamp | None
    started_at: AwareTimestamp | None
    receipt: CreatedRepository | None
    candidate: CreatedRepository | None
    error_code: str | None


class RepoCreationPage(Contract):
    items: list[RepoCreationProposal]
    truncated: bool


def request_digest(request: RepoCreationRequest) -> str:
    material = request.model_dump(exclude={"idempotency_key"})
    if not request.initialize:
        material.pop("initialize")  # Preserve existing proposal digests.
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class RepoCreationService:
    def __init__(self, repository, credentials, guard, *, enqueue=None, client: httpx.AsyncClient | None = None):
        self.repository, self.credentials, self.guard = repository, credentials, guard
        self.enqueue, self.client = enqueue, client

    async def initialize(self):
        async with self.repository.connection() as conn:
            await conn.execute(REPO_CREATION_SCHEMA)

    def _view(self, row) -> RepoCreationProposal:
        if row is None:
            raise DomainError("REPOSITORY_PROPOSAL_NOT_FOUND", "The proposal does not exist", 404)
        result = RepoCreationProposal.model_validate({key: row[key] for key in RepoCreationProposal.model_fields})
        if result.request_digest != request_digest(result.request):
            raise DomainError("REPOSITORY_PROPOSAL_INVALID", "The proposal does not match the approvable details", 409)
        self.guard.check(result.model_dump(mode="json"))
        return result

    async def propose(self, request: RepoCreationRequest) -> RepoCreationProposal:
        self.guard.check(request.model_dump())
        signature = request_digest(request)
        try:
            async with self.repository.connection() as conn:
                row = await (await conn.execute("""INSERT INTO repository_proposals
                    (id,request_key,target_key,request_digest,request) VALUES(%s,%s,%s,%s,%s)
                    ON CONFLICT(request_key) DO NOTHING RETURNING *""",
                    (new_id(), request.idempotency_key, f"{request.owner}/{request.name}".casefold(), signature, Jsonb(request.model_dump())))).fetchone()
                if row is None:
                    row = await (await conn.execute("SELECT * FROM repository_proposals WHERE request_key=%s", (request.idempotency_key,))).fetchone()
                    if row["request_digest"] != signature:
                        raise DomainError("REPOSITORY_REQUEST_CONFLICT", "This request already belongs to another proposal", 409)
                return self._view(row)
        except UniqueViolation:
            raise DomainError("REPOSITORY_PROPOSAL_EXISTS", "A proposal is already pending for this owner and name", 409) from None

    async def list(self) -> RepoCreationPage:
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT * FROM repository_proposals ORDER BY created_at DESC,id LIMIT 101")).fetchall()
        return RepoCreationPage(items=[self._view(row) for row in rows[:100]], truncated=len(rows) > 100)

    async def get(self, proposal_id: str) -> RepoCreationProposal:
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT * FROM repository_proposals WHERE id=%s", (proposal_id,))).fetchone()
        return self._view(row)

    async def decide(self, proposal_id: str, decision: RepoCreationDecision) -> RepoCreationProposal:
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT * FROM repository_proposals WHERE id=%s FOR UPDATE", (proposal_id,))).fetchone()
            current = self._view(row)
            if current.status != "proposed" or current.revision != decision.expected_revision or current.request_digest != decision.request_digest:
                raise DomainError("REPOSITORY_PROPOSAL_CHANGED", "The proposal changed or was already resolved; retrieve it again", 409)
            approved = decision.decision == "approve"
            if approved and self.enqueue is None:
                raise DomainError("REPOSITORY_QUEUE_UNAVAILABLE", "Proposal execution is not ready", 503)
            row = await (await conn.execute("""UPDATE repository_proposals SET status=%s,revision=revision+1,
                approved_at=CASE WHEN %s THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
                WHERE id=%s RETURNING *""", ("approved" if approved else "rejected", approved, proposal_id))).fetchone()
            if approved:
                await self.enqueue(conn, proposal_id)
            return self._view(row)

    async def _claim(self, proposal_id: str) -> tuple[RepoCreationProposal, bool]:
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT * FROM repository_proposals WHERE id=%s FOR UPDATE", (proposal_id,))).fetchone()
            current = self._view(row)
            if current.status != "approved":
                return current, False
            row = await (await conn.execute("""UPDATE repository_proposals SET status='executing',revision=revision+1,
                started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=%s RETURNING *""", (proposal_id,))).fetchone()
            return self._view(row), True

    async def _outcome(self, proposal: RepoCreationProposal, status: str, *, receipt=None, candidate=None, error_code=None):
        async with self.repository.connection() as conn:
            row = await (await conn.execute("""UPDATE repository_proposals SET status=%s,revision=revision+1,
                updated_at=clock_timestamp(),receipt=%s,candidate=%s,error_code=%s WHERE id=%s AND revision=%s RETURNING *""",
                (status, Jsonb(receipt.model_dump(mode="json")) if receipt else None,
                 Jsonb(candidate.model_dump(mode="json")) if candidate else None, error_code, proposal.id, proposal.revision))).fetchone()
        return self._view(row) if row else await self.get(proposal.id)

    async def _request(self, method: str, path: str, token: str, payload=None):
        self.guard.check({"path": path, "payload": payload})
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "Authorization": f"Bearer {token}"}

        async def send(client):
            async with client.stream(method, f"https://api.github.com{path}", headers=headers, json=payload, follow_redirects=False) as response:
                if response.status_code not in {200, 201}:
                    return response.status_code, {}
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 1_000_000:
                        raise DomainError("REPOSITORY_RESPONSE_INVALID", "GitHub returned an unverifiable response", 502)
                try:
                    value = json.loads(body)
                except (ValueError, RecursionError):
                    raise DomainError("REPOSITORY_RESPONSE_INVALID", "GitHub returned an unverifiable response", 502) from None
                if not isinstance(value, dict):
                    raise DomainError("REPOSITORY_RESPONSE_INVALID", "GitHub returned an unverifiable response", 502)
                return response.status_code, value
        if self.client:
            return await send(self.client)
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            return await send(client)

    def _receipt(self, data, request: RepoCreationRequest) -> CreatedRepository:
        try:
            full_name = data["full_name"]
            if not isinstance(full_name, str) or not full_name.isascii() or full_name.casefold() != f"{request.owner}/{request.name}".casefold() or type(data["private"]) is not bool or not isinstance(data["created_at"], str):
                raise ValueError
            receipt = CreatedRepository(id=data["id"], full_name=full_name, url=f"https://github.com/{full_name}",
                visibility="private" if data["private"] else "public", created_at=data["created_at"], default_branch=data.get("default_branch"))
            if request.initialize:
                from sabre.models import ProjectCreate
                ProjectCreate(name=request.name, repository=receipt.url, profile="node",
                    default_branch=receipt.default_branch, gate_commands=[["npm", "test"]])
            if receipt.visibility != request.visibility or data.get("visibility", receipt.visibility) != request.visibility:
                raise ValueError
        except (KeyError, TypeError, ValueError, ValidationError):
            raise DomainError("REPOSITORY_RESPONSE_INVALID", "GitHub did not return the approved repository", 502) from None
        self.guard.check(receipt.model_dump(mode="json"))
        return receipt

    async def execute(self, proposal_id: str) -> RepoCreationProposal:
        proposal, claimed = await self._claim(proposal_id)
        if not claimed:
            return proposal
        sent = False
        try:
            async with asyncio.timeout(30):
                token = (await self.credentials.resolve("github.create")).get_secret_value()
                credential_revision = self.credentials.revision
                if not token:
                    raise DomainError("REPOSITORY_CREDENTIAL_REQUIRED", "Configure the dedicated repository creation credential", 409)
                request = proposal.request
                if request.owner_type == "user":
                    code, account = await self._request("GET", "/user", token)
                    if code != 200 or not isinstance(account.get("login"), str) or account["login"].casefold() != request.owner.casefold():
                        raise DomainError("REPOSITORY_OWNER_MISMATCH", "The credential does not belong to the approved owner", 409)
                code, _ = await self._request("GET", f"/repos/{request.owner}/{request.name}", token)
                if code == 200:
                    return await self._outcome(proposal, "conflict", error_code="REPOSITORY_ALREADY_EXISTS")
                if code != 404:
                    raise DomainError("REPOSITORY_PREFLIGHT_FAILED", "Could not verify that the repository did not exist", 502)
                await self.credentials.ensure_enabled("github.create")
                await self.credentials.assert_current(credential_revision)
                path = "/user/repos" if request.owner_type == "user" else f"/orgs/{request.owner}/repos"
                payload = {"name": request.name, "private": request.visibility == "private", "description": request.description, "auto_init": request.initialize}
                # Reject locally before classifying the external effect as possibly sent.
                self.guard.check({"path": path, "payload": payload})
                # The durable executing claim prevents another POST after a lost response.
                sent = True
                code, data = await self._request("POST", path, token, payload)
                if code in {400, 401, 403, 404, 422, 451}:
                    return await self._outcome(proposal, "failed", error_code="REPOSITORY_CREATE_REJECTED")
                if code != 201 or (data.get("description") or "") != request.description:
                    raise DomainError("REPOSITORY_RESPONSE_INVALID", "GitHub did not confirm the creation result", 502)
                return await self._outcome(proposal, "created", receipt=self._receipt(data, request))
        except asyncio.CancelledError:
            # A worker crash may leave executing durable; explicit reconciliation handles that state.
            raise
        except (DomainError, TimeoutError, httpx.HTTPError) as error:
            allowed = {"REPOSITORY_CREDENTIAL_REQUIRED", "REPOSITORY_OWNER_MISMATCH", "REPOSITORY_PREFLIGHT_FAILED",
                       "REPOSITORY_RESPONSE_INVALID", "INTEGRATION_DISABLED", "CREDENTIALS_CHANGED", "SECRET_DETECTED"}
            error_code = error.code if isinstance(error, DomainError) and error.code in allowed else "REPOSITORY_PREFLIGHT_FAILED"
            return await self._outcome(proposal, "reconciliation_required" if sent else "failed",
                                       error_code="REPOSITORY_EFFECT_UNKNOWN" if sent else error_code)

    async def reconcile(self, proposal_id: str) -> RepoCreationProposal:
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT *,clock_timestamp() AS checked_at FROM repository_proposals WHERE id=%s FOR UPDATE", (proposal_id,))).fetchone()
            proposal = self._view(row)
            if proposal.status not in {"executing", "reconciliation_required"}:
                return proposal
            if proposal.status == "executing":
                if proposal.started_at is None:
                    raise DomainError("REPOSITORY_PROPOSAL_INVALID", "The proposal has no verifiable start date", 409)
                if (row["checked_at"] - proposal.started_at).total_seconds() < 60:
                    raise DomainError("REPOSITORY_EXECUTION_ACTIVE", "Creation may still be in progress; wait before reconciling", 409)
        candidate = None
        code = "REPOSITORY_RECONCILIATION_REQUIRED"
        try:
            async with asyncio.timeout(15):
                token = (await self.credentials.resolve("github.create")).get_secret_value()
                if token:
                    status, data = await self._request("GET", f"/repos/{proposal.request.owner}/{proposal.request.name}", token)
                    if status == 200:
                        candidate = self._receipt(data, proposal.request)
                    elif status == 404:
                        code = "REPOSITORY_NOT_OBSERVED"
        except (DomainError, TimeoutError, httpx.HTTPError):
            pass
        # A matching name/date is not proof of this POST. Never adopt an unrelated repository.
        return await self._outcome(proposal, "reconciliation_required", candidate=candidate, error_code=code)
