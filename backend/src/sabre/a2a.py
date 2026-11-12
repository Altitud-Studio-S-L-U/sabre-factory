"""Official A2A 1.0 adapters; discovery does not grant execution authority."""

import asyncio
import hashlib
import json
import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

import httpx
import httpx2
from a2a.client import ClientConfig, ClientFactory
from a2a.server.context import ServerCallContext
from a2a.server.request_handlers.request_handler import RequestHandler
from a2a.server.routes.common import ServerCallContextBuilder
from a2a.server.routes.jsonrpc_dispatcher import JsonRpcDispatcher
from a2a.types import a2a_pb2 as wire
from a2a.utils.errors import InvalidParamsError, UnsupportedOperationError
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from google.protobuf.json_format import MessageToDict, ParseDict, ParseError
from psycopg.types.json import Jsonb
from pydantic import Field, ValidationError

from sabre.commands import CommandEnvelope
from sabre.contracts import StrictContract
from sabre.credentials import endpoint_digest
from sabre.delegation import (
    Delegations,
    GrantCreate,
    GrantIssued,
    GrantRevoked,
    GrantView,
    authorize_delegated_work,
)
from sabre.mcp_connections import PublicMCPTransport, normalized_endpoint
from sabre.models import DomainError
from sabre.repository import digest

MAX_BYTES = 1_048_576
SUPPORTED_VERSION = "1.0"


def proto_json_numbers(value):
    # Protobuf Value stores every JSON number as double. Recover only exact
    # integral numbers; strings and booleans still reach strict validation intact.
    if isinstance(value, float) and value.is_integer() and abs(value) <= 2**53:
        return int(value)
    if isinstance(value, dict):
        return {key: proto_json_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [proto_json_numbers(item) for item in value]
    return value


def card_digest(card):
    return hashlib.sha256(json.dumps(card, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def checked_card(data, endpoint):
    if len(json.dumps(data).encode()) > 65536:
        raise DomainError("A2A_CARD_INVALID", "The Agent Card exceeds the size limit", 422)
    try:
        card = ParseDict(data, wire.AgentCard())
    except (ValueError, TypeError, ParseError) as error:
        raise DomainError("A2A_CARD_INVALID", "The Agent Card does not match the official SDK contract", 422) from error
    compatible = [item for item in card.supported_interfaces if item.protocol_binding == "JSONRPC" and item.protocol_version == SUPPORTED_VERSION]
    if not compatible:
        raise DomainError("A2A_VERSION_UNSUPPORTED", "Select an Agent Card advertising A2A 1.0 JSONRPC", 422)
    if not card.name or not card.skills or any(normalized_endpoint(item.url) != endpoint for item in compatible):
        raise DomainError("A2A_CARD_INVALID", "The Agent Card must advertise skills and the exact reviewed endpoint", 422)
    # Do not allow the SDK to negotiate an unreviewed interface or tenant.
    if any(item.tenant for item in compatible):
        raise DomainError("A2A_CARD_INVALID", "Tenant routing is not configured for this connection", 422)
    return card


class AgentRegistration(StrictContract):
    expected_revision: int = Field(ge=0, strict=True)
    endpoint: str = Field(min_length=1, max_length=2048)
    card: dict
    reviewed_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    enabled: bool = False
    projects: list[str] = Field(min_length=1, max_length=30)
    roles: list[str] = Field(default_factory=list, max_length=10)
    skills: list[str] = Field(default_factory=list, max_length=100)


class CardDiscovery(StrictContract):
    endpoint: str = Field(min_length=1, max_length=2048)
    card_endpoint: str = Field(min_length=1, max_length=2048)


class A2AAgentInfo(StrictContract):
    name: str
    endpoint: str
    revision: int
    card: dict
    digest: str
    enabled: bool
    projects: list[str]
    roles: list[str]
    skills: list[str]
    credential_id: str
    cost: Literal["unknown"] = "unknown"


class AgentCardDiscovery(StrictContract):
    card: dict
    reviewed_digest: str
    endpoint: str
    execution_authorized: Literal[False] = False


class A2ATaskInfo(StrictContract):
    attempt_key: str
    work_id: str
    agent_name: str
    remote_task_id: str | None
    remote_context_id: str | None
    state: str
    result: dict | None
    cost_usd: float | None
    updated_at: datetime
    input_digest: str | None = None


class A2AReceiptRequest(StrictContract):
    attempt_key: str = Field(min_length=1, max_length=256, pattern=r"^[A-Za-z0-9:._/-]+$")


class A2AInputAnswer(A2AReceiptRequest):
    answer: str = Field(min_length=1, max_length=12000)
    expected_input_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


def task_info(row):
    data = {name: row[name] for name in A2ATaskInfo.model_fields if name != "input_digest"}
    status = (row["result"] or {}).get("status", {})
    data["input_digest"] = digest(status.get("message", {})) if status.get("state") == "TASK_STATE_INPUT_REQUIRED" else None
    return A2ATaskInfo.model_validate(data)


class ProtectedA2ATransport(httpx.AsyncBaseTransport):
    """Bridge the official SDK to SABRE's DNS-pinned, bounded HTTPS boundary."""

    def __init__(self, endpoint, credential_check=None, *, protected=None):
        self.protected = protected or PublicMCPTransport(endpoint, credential_check=credential_check,
            allowed_statuses={"GET": {200}, "POST": {200, 202}, "DELETE": {200, 202, 204}})

    async def handle_async_request(self, request):
        body = await request.aread()
        if len(body) > MAX_BYTES:
            raise DomainError("A2A_REQUEST_TOO_LARGE", "The remote request exceeds its limit", 422)
        outgoing = httpx2.Request(request.method, str(request.url), headers=dict(request.headers), content=body)
        response = await self.protected.handle_async_request(outgoing)
        # Preserve incremental SDK SSE delivery while the protected stream
        # enforces the cumulative byte limit before each chunk is parsed.
        class ResponseStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                async for chunk in response.stream:
                    yield chunk

            async def aclose(self):
                await response.aclose()

        return httpx.Response(response.status_code, headers=dict(response.headers), stream=ResponseStream(), request=request)

    async def aclose(self):
        await self.protected.aclose()


class A2ARegistry:
    def __init__(self, service):
        self.service, self.repository = service, service.repository

    @staticmethod
    def credential_id(row):
        return f"a2a.{row['name']}.{endpoint_digest(row['endpoint'])}.token"

    async def list(self):
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT name,endpoint,revision,card,digest,enabled,projects,roles,skills FROM a2a_agent_cards ORDER BY name")).fetchall()
        return [{**row, "credential_id": self.credential_id(row), "cost": "unknown"} for row in rows]

    async def credential_targets(self):
        return {row["credential_id"]: "A2A · " + row["name"] for row in await self.list()}

    async def get(self, name):
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT name,endpoint,revision,card,digest,enabled,projects,roles,skills FROM a2a_agent_cards WHERE name=%s", (name,))).fetchone()
        if row is None:
            raise DomainError("A2A_AGENT_NOT_FOUND", "Register this external agent first", 404)
        return row

    async def save(self, name, request):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name):
            raise DomainError("A2A_AGENT_INVALID", "Choose an alphanumeric agent name", 422)
        endpoint = normalized_endpoint(request.endpoint)
        card = checked_card(request.card, endpoint)
        allowed_roles = {"supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security", "designer", "devops"}
        if not set(request.roles) <= allowed_roles or not set(request.skills) <= {skill.id for skill in card.skills}:
            raise DomainError("A2A_GRANT_INVALID", "Select registered roles and advertised skills", 422)
        self.service.guard.check(request.card)
        actual = card_digest(request.card)
        if request.reviewed_digest != actual:
            raise DomainError("A2A_MANIFEST_CHANGED", "Review the current Agent Card before enabling it", 409)
        for project_id in request.projects:
            await self.repository.project(project_id)
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("a2a-agent:" + name,))
            prior = await (await conn.execute("SELECT revision FROM a2a_agent_cards WHERE name=%s", (name,))).fetchone()
            if (prior["revision"] if prior else 0) != request.expected_revision:
                raise DomainError("A2A_REVISION_CONFLICT", "Refresh this external agent before changing it", 409)
            await conn.execute("""INSERT INTO a2a_agent_cards(name,endpoint,revision,card,digest,enabled,projects,roles,skills) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT(name) DO UPDATE SET endpoint=excluded.endpoint,revision=excluded.revision,card=excluded.card,digest=excluded.digest,enabled=excluded.enabled,projects=excluded.projects,roles=excluded.roles,skills=excluded.skills,updated_at=clock_timestamp()""",
                (name, endpoint, request.expected_revision + 1, Jsonb(request.card), actual, request.enabled, Jsonb(request.projects), Jsonb(request.roles), Jsonb(request.skills)))
        return {**await self.get(name), "credential_id": self.credential_id({"name": name, "endpoint": endpoint}), "cost": "unknown"}

    async def discover(self, request):
        endpoint, card_endpoint = normalized_endpoint(request.endpoint), normalized_endpoint(request.card_endpoint)
        if urlsplit(endpoint).netloc != urlsplit(card_endpoint).netloc:
            raise DomainError("A2A_DESTINATION_CHANGED", "The Agent Card must come from the reviewed origin", 422)
        if urlsplit(card_endpoint).path != "/.well-known/agent-card.json":
            raise DomainError("A2A_DISCOVERY_PATH_UNSUPPORTED", "This adapter uses the standard /.well-known/agent-card.json discovery path", 422)
        async with httpx.AsyncClient(transport=ProtectedA2ATransport(card_endpoint), timeout=15, follow_redirects=False, trust_env=False) as client:
            response = await client.get(card_endpoint)
        try:
            card = response.json()
            checked_card(card, endpoint)
            self.service.guard.check(card)
        except (ValueError, TypeError) as error:
            raise DomainError("A2A_CARD_INVALID", "The remote endpoint returned an invalid Agent Card", 502) from error
        return {"card": card, "reviewed_digest": card_digest(card), "endpoint": endpoint, "execution_authorized": False}

    @asynccontextmanager
    async def client(self, row, project_id, *, work_id=None):
        parsed = urlsplit(row["endpoint"])
        discovered = await self.discover(CardDiscovery(endpoint=row["endpoint"],
            card_endpoint=f"https://{parsed.netloc}/.well-known/agent-card.json"))
        if discovered["reviewed_digest"] != row["digest"]:
            async with self.repository.connection() as conn:
                await conn.execute("UPDATE a2a_agent_cards SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE name=%s AND revision=%s", (row["name"], row["revision"]))
            raise DomainError("A2A_MANIFEST_CHANGED", "The remote Agent Card changed; review it before delegating again", 409)
        credentials = self.service.queue.credentials
        target = self.credential_id(row)
        token = await credentials.resolve(target)
        initial = token.get_secret_value()
        if row["card"].get("securityRequirements") and not initial:
            raise DomainError("A2A_CREDENTIAL_MISSING", "Configure this destination's credential before delegating", 409)

        async def check():
            if work_id is not None:
                await authorize_delegated_work(self.repository, await self.repository.work(work_id))
            current = await self.get(row["name"])
            if not current["enabled"] or current["digest"] != row["digest"] or current["endpoint"] != row["endpoint"] or project_id not in current["projects"]:
                raise DomainError("A2A_ACCESS_DENIED", "The external agent connection or project permission changed", 403)
            value = await credentials.resolve(target)
            if value.get_secret_value() != initial:
                raise DomainError("A2A_CREDENTIAL_CHANGED", "The external agent credential changed; reconcile the remote task", 409)

        await check()
        card = checked_card(row["card"], row["endpoint"])
        # Restrict negotiation to the reviewed 1.0 endpoint even if a card advertises more.
        del card.supported_interfaces[:]
        card.supported_interfaces.append(wire.AgentInterface(url=row["endpoint"], protocol_binding="JSONRPC", protocol_version=SUPPORTED_VERSION))
        headers = {"Authorization": "Bearer " + initial} if initial else {}
        async with httpx.AsyncClient(transport=ProtectedA2ATransport(row["endpoint"], check), headers=headers,
                timeout=30, follow_redirects=False, trust_env=False) as http:
            client = ClientFactory(ClientConfig(httpx_client=http, streaming=card.capabilities.streaming,
                polling=True, supported_protocol_bindings=["JSONRPC"])).create(card)
            try:
                yield client
            finally:
                await client.close()


class OutboundA2A:
    def __init__(self, registry):
        self.registry, self.repository = registry, registry.repository

    async def receipt(self, attempt_key):
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT * FROM a2a_tasks WHERE attempt_key=%s", (attempt_key,))).fetchone()
        if row is None:
            raise DomainError("A2A_TASK_NOT_FOUND", "No external receipt exists for this attempt", 404)
        return row

    async def record(self, key, task, *, state="received"):
        if not task.id or not task.context_id or len(task.id) > 256 or len(task.context_id) > 256:
            raise DomainError("A2A_TASK_INVALID", "The external agent returned invalid task identifiers", 502)
        prior = await self.receipt(key)
        if prior["remote_task_id"] and (task.id != prior["remote_task_id"] or task.context_id != prior["remote_context_id"]):
            raise DomainError("A2A_TASK_MISMATCH", "The remote update belongs to another task or context", 502)
        data = MessageToDict(task)
        self.registry.service.guard.check(data)
        if len(json.dumps(data).encode()) > MAX_BYTES:
            raise DomainError("A2A_RESPONSE_TOO_LARGE", "The external task exceeds its receipt limit", 502)
        async with self.repository.connection() as conn:
            await conn.execute("UPDATE a2a_tasks SET remote_task_id=%s,remote_context_id=%s,state=%s,result=%s,updated_at=clock_timestamp() WHERE attempt_key=%s",
                (task.id, task.context_id, state, Jsonb(data), key))
        return data

    async def send(self, name, work_id, attempt_key, request: wire.SendMessageRequest):
        work, row = await self.repository.work(work_id), await self.registry.get(name)
        if not row["enabled"] or work.project_id not in row["projects"]:
            raise DomainError("A2A_ACCESS_DENIED", "Enable the external agent for this project first", 403)
        if not request.message.message_id or len(request.message.message_id) > 128:
            raise DomainError("A2A_MESSAGE_ID_REQUIRED", "Use a stable message ID for this step attempt", 422)
        request = wire.SendMessageRequest().FromString(request.SerializeToString())
        if not request.message.context_id:
            request.message.context_id = "sabre-attempt:" + digest({"work": work_id, "attempt": attempt_key})
        data = MessageToDict(request)
        self.registry.service.guard.check(data)
        request_hash = digest(data)
        async with self.repository.connection() as conn:
            inserted = await (await conn.execute("""INSERT INTO a2a_tasks(attempt_key,work_id,agent_name,card_digest,request_hash,message_id,remote_context_id,state)
                VALUES(%s,%s,%s,%s,%s,%s,%s,'sending') ON CONFLICT DO NOTHING RETURNING attempt_key""",
                (attempt_key, work_id, name, row["digest"], request_hash, request.message.message_id, request.message.context_id))).fetchone()
        prior = await self.receipt(attempt_key)
        if prior["request_hash"] != request_hash or prior["agent_name"] != name or prior["work_id"] != work_id:
            raise DomainError("IDEMPOTENCY_CONFLICT", "This attempt belongs to a different delegation", 409)
        if not inserted:
            return await self.reconcile(attempt_key)
        async with self.registry.client(row, work.project_id, work_id=work.id) as client:
            try:
                async for event in client.send_message(request):
                    if event.HasField("task"):
                        await self.record(attempt_key, event.task)
                    elif event.HasField("status_update") or event.HasField("artifact_update"):
                        task_id = event.status_update.task_id if event.HasField("status_update") else event.artifact_update.task_id
                        await self.record(attempt_key, await client.get_task(wire.GetTaskRequest(id=task_id)))
                    elif event.HasField("message"):
                        raise DomainError("A2A_TASK_REQUIRED", "This delegation requires a durable remote task receipt", 502)
            except (Exception, asyncio.CancelledError) as error:
                async with self.repository.connection() as conn:
                    await conn.execute("UPDATE a2a_tasks SET state='uncertain' WHERE attempt_key=%s", (attempt_key,))
                if isinstance(error, asyncio.CancelledError):
                    raise
                raise DomainError("A2A_OUTCOME_UNCERTAIN", "The remote outcome requires reconciliation before retry", 409) from None
        return await self.receipt(attempt_key)

    async def reconcile(self, attempt_key, *, cancel=False):
        try:
            return await self._reconcile(attempt_key, cancel=cancel)
        except DomainError:
            raise
        except Exception:
            async with self.repository.connection() as conn:
                await conn.execute("UPDATE a2a_tasks SET state='uncertain' WHERE attempt_key=%s", (attempt_key,))
            raise DomainError("A2A_RECONCILIATION_FAILED", "Remote status is unavailable; do not repeat its effect", 409) from None

    async def _reconcile(self, attempt_key, *, cancel=False):
        prior = await self.receipt(attempt_key)
        work, row = await self.repository.work(prior["work_id"]), await self.registry.get(prior["agent_name"])
        if row["digest"] != prior["card_digest"]:
            raise DomainError("A2A_MANIFEST_CHANGED", "Review changed remote capabilities before reconciliation", 409)
        async with self.registry.client(row, work.project_id, work_id=None if cancel else work.id) as client:
            if not prior["remote_task_id"]:
                # Poll for the persisted context and original message receipt. Never
                # assume remote message IDs are globally idempotent or resend a mutation.
                try:
                    page = await client.list_tasks(wire.ListTasksRequest(context_id=prior["remote_context_id"], page_size=100, history_length=100))
                    matching = [task for task in page.tasks if task.context_id == prior["remote_context_id"]
                        and any(message.message_id == prior["message_id"] for message in task.history)]
                except Exception:
                    matching = []
                if len(matching) != 1:
                    raise DomainError("A2A_OUTCOME_UNCERTAIN", "No unique remote receipt was found; inspect the remote agent before retry", 409)
                await self.record(attempt_key, matching[0])
                prior = await self.receipt(attempt_key)
            task = await client.get_task(wire.GetTaskRequest(id=prior["remote_task_id"]))
            if task.id != prior["remote_task_id"] or (prior["remote_context_id"] and task.context_id != prior["remote_context_id"]):
                raise DomainError("A2A_TASK_MISMATCH", "The remote response belongs to another task or context", 502)
            await self.record(attempt_key, task)
            if cancel and task.status.state not in {wire.TASK_STATE_COMPLETED, wire.TASK_STATE_CANCELED, wire.TASK_STATE_FAILED, wire.TASK_STATE_REJECTED}:
                task = await client.cancel_task(wire.CancelTaskRequest(id=task.id))
                await self.record(attempt_key, task, state="cancel_requested")
        return await self.receipt(attempt_key)

    async def answer(self, attempt_key, answer: str, expected_input_digest: str):
        prior = await self.receipt(attempt_key)
        answer_key = "a2a-answer:" + digest({"attempt": attempt_key, "subject": expected_input_digest})
        try:
            await self.receipt(answer_key)
            existing = True
        except DomainError as error:
            if error.code != "A2A_TASK_NOT_FOUND":
                raise
            existing = False
        if not existing:
            prior = await self.reconcile(attempt_key)
        task = ParseDict(prior["result"] or {}, wire.Task())
        if not existing and (task.status.state != wire.TASK_STATE_INPUT_REQUIRED or not prior["remote_task_id"]):
            raise DomainError("A2A_INPUT_NOT_PENDING", "Reconcile a remote input-required task before answering it", 409)
        if not existing and digest(MessageToDict(task.status.message)) != expected_input_digest:
            raise DomainError("A2A_INPUT_CHANGED", "The external input request changed. Inspect the current question before answering", 409)
        # One answer slot belongs to this precise remote input request. Changed
        # answers conflict rather than replaying an approval against another request.
        request = wire.SendMessageRequest(message=wire.Message(message_id=answer_key,
            task_id=prior["remote_task_id"], context_id=prior["remote_context_id"], role=wire.ROLE_USER,
            parts=[wire.Part(text=answer)]))
        result = await self.send(prior["agent_name"], prior["work_id"], answer_key, request)
        if result["result"]:
            await self.record(attempt_key, ParseDict(result["result"], wire.Task()))
        return await self.receipt(attempt_key)

    async def cancel_work(self, work_id):
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT attempt_key FROM a2a_tasks WHERE work_id=%s ORDER BY updated_at DESC LIMIT 100", (work_id,))).fetchall()
        outcomes = []
        for row in rows:
            try:
                receipt = await self.reconcile(row["attempt_key"], cancel=True)
                outcomes.append({"attempt_key": row["attempt_key"], "state": receipt["state"]})
            except DomainError as error:
                async with self.repository.connection() as conn:
                    await conn.execute("UPDATE a2a_tasks SET state='cancel_uncertain' WHERE attempt_key=%s", (row["attempt_key"],))
                outcomes.append({"attempt_key": row["attempt_key"], "state": "cancel_uncertain", "error_code": error.code})
        return outcomes


def local_card(origin):
    return wire.AgentCard(name="SABRE", description="Private software factory. Delegated credentials are required; discovery grants no execution rights.",
        version="1", supported_interfaces=[wire.AgentInterface(url=origin + "/a2a", protocol_binding="JSONRPC", protocol_version=SUPPORTED_VERSION)],
        capabilities=wire.AgentCapabilities(streaming=False, push_notifications=False),
        default_input_modes=["application/json"], default_output_modes=["application/json"],
        security_schemes={"delegatedBearer": wire.SecurityScheme(http_auth_security_scheme=wire.HTTPAuthSecurityScheme(scheme="bearer"))},
        security_requirements=[wire.SecurityRequirement(schemes={"delegatedBearer": wire.StringList()})],
        skills=[wire.AgentSkill(id="work", name="Delegated work", description="Send a SABRE CommandEnvelope in a JSON data part. Submit, query, answer and cancel use scoped grants and durable receipts.", tags=["software", "private"])])


def work_task(work):
    states = {"queued": wire.TASK_STATE_SUBMITTED, "running": wire.TASK_STATE_WORKING,
        "waiting_input": wire.TASK_STATE_INPUT_REQUIRED, "paused": wire.TASK_STATE_INPUT_REQUIRED,
        "blocked": wire.TASK_STATE_INPUT_REQUIRED, "failed": wire.TASK_STATE_FAILED,
        "cancelled": wire.TASK_STATE_CANCELED, "completed": wire.TASK_STATE_COMPLETED}
    data = {"work_id": work.id, "phase": work.phase, "revision": work.plan_revision,
        "questions": [q.model_dump(mode="json") for q in work.questions], "summary": work.summary,
        "cost_usd": None}
    part = ParseDict({"data": data}, wire.Part())
    return wire.Task(id=work.id, context_id="sabre:" + work.id,
        status=wire.TaskStatus(state=states[str(work.status)], message=wire.Message(message_id="status:" + work.id,
            role=wire.ROLE_AGENT, parts=[part])),
        artifacts=[wire.Artifact(artifact_id="work-result", name="Run result", parts=[part])] if str(work.status) == "completed" else [])


class InboundA2A(RequestHandler):
    def __init__(self, service_accessor):
        self.service_accessor = service_accessor

    def delegates(self):
        return Delegations(self.service_accessor())

    async def on_get_task(self, params, context):
        return work_task(await self.delegates().query(context.state["grant_id"], params.id))

    async def on_message_send(self, params, context):
        message = params.message
        if message.role != wire.ROLE_USER or not message.message_id or len(message.message_id) > 128 or len(message.parts) != 1 or not message.parts[0].HasField("data"):
            raise InvalidParamsError("Use one JSON data part with a stable message ID and a SABRE CommandEnvelope")
        try:
            envelope = CommandEnvelope.model_validate(proto_json_numbers(MessageToDict(message.parts[0].data)), strict=True)
        except ValidationError:
            raise InvalidParamsError("The data part must contain a valid SABRE CommandEnvelope") from None
        target = getattr(envelope.payload, "work_id", None)
        if (message.task_id and message.task_id != target) or (message.context_id and target and message.context_id != "sabre:" + target):
            raise InvalidParamsError("The command, task and context must refer to the same run")
        result = await self.delegates().execute(context.state["grant_id"], message.message_id, envelope)
        return work_task(result.work)

    async def on_cancel_task(self, params, context):
        delegates = self.delegates()
        work = await delegates.query(context.state["grant_id"], params.id)
        metadata = MessageToDict(params.metadata)
        key = metadata.get("idempotencyKey")
        if not isinstance(key, str):
            raise InvalidParamsError("Cancellation requires metadata.idempotencyKey")
        try:
            command = CommandEnvelope.model_validate({"version": 1, "idempotency_key": key,
                "correlation_id": key, "payload": {"type": "work.control", "work_id": work.id,
                    "expected_revision": work.plan_revision, "action": "cancel"}}, strict=True)
        except ValidationError:
            raise InvalidParamsError("Use a valid cancellation idempotency key") from None
        result = await delegates.execute(context.state["grant_id"], "cancel:" + key, command)
        return work_task(result.work)

    async def on_list_tasks(self, params, context):
        raise UnsupportedOperationError("Query explicitly assigned task IDs")

    async def on_get_extended_agent_card(self, params, context):
        raise UnsupportedOperationError()

    async def on_create_task_push_notification_config(self, params, context):
        raise UnsupportedOperationError()

    async def on_get_task_push_notification_config(self, params, context):
        raise UnsupportedOperationError()

    async def on_list_task_push_notification_configs(self, params, context):
        raise UnsupportedOperationError()

    async def on_delete_task_push_notification_config(self, params, context):
        raise UnsupportedOperationError()

    async def on_message_send_stream(self, params, context):
        raise UnsupportedOperationError("Use polling for SABRE tasks")
        yield

    async def on_subscribe_to_task(self, params, context):
        raise UnsupportedOperationError("Use polling for SABRE tasks")
        yield


class DelegatedContext(ServerCallContextBuilder):
    def build(self, request):
        return ServerCallContext(state={"grant_id": request.state.delegated_grant["id"],
            "headers": {"a2a-version": request.headers.get("a2a-version", "")}})


def a2a_services(service):
    registry = A2ARegistry(service)
    credentials = getattr(service.queue, "credentials", None)
    if credentials is not None:
        credentials.a2a_connections = registry
    return registry, OutboundA2A(registry)


def install_a2a(application, service_accessor):
    """Install before the SPA mount. Owner API middleware protects administration."""
    router = APIRouter()
    handler = InboundA2A(service_accessor)
    dispatcher = JsonRpcDispatcher(handler, context_builder=DelegatedContext(), enable_v0_3_compat=False)

    def registry():
        return a2a_services(service_accessor())[0]

    @router.get("/.well-known/agent-card.json")
    async def discovery():
        origin = getattr(service_accessor().config, "panel_origin", "http://127.0.0.1:8000")
        return MessageToDict(local_card(origin))

    @router.post("/a2a")
    async def ingress(request: Request):
        if request.headers.get("origin"):
            raise DomainError("A2A_ORIGIN_DENIED", "Use an authenticated agent client", 403)
        size = 0
        chunks = []
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BYTES:
                raise DomainError("A2A_REQUEST_TOO_LARGE", "The A2A request exceeds its limit", 413)
            chunks.append(chunk)
        request._body = b"".join(chunks)
        grant = await Delegations(service_accessor()).authenticate(request.headers.get("authorization", ""))
        request.state.delegated_grant = grant
        # The SDK builds protocol error envelopes and validates the version header.
        try:
            async with asyncio.timeout(45):
                response = await dispatcher.handle_requests(request)
        except DomainError as error:
            return JSONResponse({"code": error.code, "message": error.message}, status_code=error.status_code)
        response.headers["Cache-Control"] = "no-store"
        return response

    @router.post("/api/v1/delegations", response_model=GrantIssued)
    async def issue(request: GrantCreate):
        return await Delegations(service_accessor()).issue(request)

    @router.get("/api/v1/delegations", response_model=list[GrantView])
    async def grants():
        return await Delegations(service_accessor()).list()

    @router.delete("/api/v1/delegations/{identifier}", response_model=GrantRevoked)
    async def revoke(identifier: str):
        return await Delegations(service_accessor()).revoke(identifier)

    @router.get("/api/v1/a2a/agents", response_model=list[A2AAgentInfo])
    async def agents():
        return await registry().list()

    @router.put("/api/v1/a2a/agents/{name}", response_model=A2AAgentInfo)
    async def register(name: str, request: AgentRegistration):
        return await registry().save(name, request)

    @router.post("/api/v1/a2a/agents/{name}/discover", response_model=AgentCardDiscovery)
    async def inspect(name: str, request: CardDiscovery):
        return await registry().discover(request)

    @router.get("/api/v1/work/{work_id}/a2a-tasks", response_model=list[A2ATaskInfo])
    async def remote_tasks(work_id: str):
        await service_accessor().repository.work(work_id)
        async with service_accessor().repository.connection() as conn:
            rows = await (await conn.execute("SELECT attempt_key,work_id,agent_name,remote_task_id,remote_context_id,state,result,cost_usd,updated_at FROM a2a_tasks WHERE work_id=%s ORDER BY updated_at DESC LIMIT 100", (work_id,))).fetchall()
        return [task_info(row) for row in rows]

    async def bound_outbound(work_id, attempt_key):
        service = service_accessor()
        await service.repository.work(work_id)
        outbound = a2a_services(service)[1]
        receipt = await outbound.receipt(attempt_key)
        if receipt["work_id"] != work_id:
            raise DomainError("A2A_TASK_SCOPE_DENIED", "This remote receipt belongs to another run", 403)
        return outbound

    @router.post("/api/v1/work/{work_id}/a2a-tasks/poll", response_model=A2ATaskInfo)
    async def poll_remote(work_id: str, request: A2AReceiptRequest):
        outbound = await bound_outbound(work_id, request.attempt_key)
        return task_info(await outbound.reconcile(request.attempt_key))

    @router.post("/api/v1/work/{work_id}/a2a-tasks/answer", response_model=A2ATaskInfo)
    async def answer_remote(work_id: str, request: A2AInputAnswer):
        outbound = await bound_outbound(work_id, request.attempt_key)
        return task_info(await outbound.answer(request.attempt_key, request.answer, request.expected_input_digest))

    @router.post("/api/v1/work/{work_id}/a2a-tasks/cancel", response_model=A2ATaskInfo)
    async def cancel_remote(work_id: str, request: A2AReceiptRequest):
        outbound = await bound_outbound(work_id, request.attempt_key)
        return task_info(await outbound.reconcile(request.attempt_key, cancel=True))

    application.include_router(router)
