"""Delegated identity and remote effects survive reconnects using PostgreSQL receipts."""

import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from a2a.client import ClientConfig, ClientFactory
from a2a.server.routes.jsonrpc_routes import create_jsonrpc_routes
from a2a.types import a2a_pb2 as wire
from fastapi import FastAPI
from google.protobuf.json_format import MessageToDict, ParseDict
from pydantic import SecretStr

from sabre.a2a import A2ARegistry, InboundA2A, OutboundA2A, install_a2a, local_card, work_task
from sabre.commands import CommandEnvelope
from sabre.delegation import Delegations, GrantCreate
from sabre.models import Budget, DomainError, Project, Status, WorkOrder, new_id
from sabre.repository import Repository
from sabre.security import SecretGuard
from sabre.settings import Settings


@pytest.fixture
async def service():
    repo = Repository(Settings().database_url.get_secret_value())
    await repo.initialize()
    project = await repo.create_project(Project(name="Synthetic A2A fixture", repository=f"https://github.com/fixture/{new_id()}",
        profile="python", gate_commands=[["python", "-m", "unittest"]]))

    async def enqueue(conn, identifier):
        pass

    async def submit(request):
        return await repo.admit(WorkOrder(**request.model_dump()), enqueue)

    async def control(identifier, action):
        work = await repo.work(identifier)
        work.status = Status.CANCELLED if action == "cancel" else Status.RUNNING
        await repo.save(work)
        return work

    svc = SimpleNamespace(repository=repo, guard=SecretGuard(), queue=SimpleNamespace(),
        submit=AsyncMock(side_effect=submit), control=AsyncMock(side_effect=control),
        config=SimpleNamespace(panel_origin="http://127.0.0.1:8000", auth_token=SecretStr("synthetic-owner")),
        project=project)
    yield svc
    async with repo.connection() as conn:
        await conn.execute("DELETE FROM a2a_tasks WHERE work_id IN (SELECT id FROM work_orders WHERE project_id=%s)", (project.id,))
        await conn.execute("DELETE FROM a2a_agent_cards WHERE projects ? %s", (project.id,))
        await conn.execute("DELETE FROM delegated_commands WHERE grant_id IN (SELECT id FROM delegated_grants WHERE data->'projects' ? %s)", (project.id,))
        await conn.execute("DELETE FROM effects WHERE operation_key LIKE 'delegation-issue-v1:%%' AND result->>'id' IN (SELECT id FROM delegated_grants WHERE data->'projects' ? %s)", (project.id,))
        await conn.execute("DELETE FROM delegated_grants WHERE data->'projects' ? %s", (project.id,))
        await conn.execute("DELETE FROM effects WHERE operation_key LIKE 'command-v1:delegated:%%'")
        await conn.execute("DELETE FROM work_orders WHERE project_id=%s", (project.id,))
        await conn.execute("DELETE FROM projects WHERE id=%s", (project.id,))
    await repo.close()


def grant_request(project_id, **changes):
    return GrantCreate(version=1, idempotency_key=changes.pop("idempotency_key", "fixture-" + new_id()),
        principal="synthetic-external", projects=[project_id],
        operations=["work.submit", "work.query", "work.answer", "work.cancel"], expires_in=300,
        max_calls=40, max_tokens=100000, max_cost_usd=0, active_seconds=3600, max_runs=5, **changes)


def command(project_id, **changes):
    request = {"project_id": project_id, "mode": "audit", "objective": "Inspect a synthetic fixture",
        "acceptance": ["Provide evidence"], "budget": Budget().model_dump(), "idempotency_key": "synthetic-request-key"}
    request.update(changes)
    return CommandEnvelope.model_validate({"version": 1, "idempotency_key": "synthetic-command-key", "correlation_id": "synthetic-correlation",
        "payload": {"type": "work.submit", "request": request}}, strict=True)


async def test_grant_issuance_concurrent_retry_recovers_metadata_without_another_token(service):
    from sabre.repository import digest

    request = grant_request(service.project.id)
    results = await asyncio.gather(*(Delegations(service).issue(request) for _ in range(5)))
    original = next(item for item in results if not item.recovered)
    assert original.token.startswith("sabre_d_")
    assert all(item.id == original.id and item.expires_at == original.expires_at for item in results)
    assert sum(item.token is not None for item in results) == 1
    recovered = await Delegations(service).issue(request)
    assert recovered.id == original.id and recovered.token is None and recovered.recovered
    async with service.repository.connection() as conn:
        rows = await (await conn.execute("SELECT id,data FROM delegated_grants WHERE data->'projects' ? %s", (service.project.id,))).fetchall()
        receipt = await (await conn.execute("SELECT * FROM effects WHERE operation_key=%s", ("delegation-issue-v1:" + digest(request.idempotency_key),))).fetchone()
    assert len(rows) == 1
    assert "idempotency_key" not in rows[0]["data"]
    assert original.token not in json.dumps(receipt)
    assert set(receipt["result"]) == {"id", "principal", "expires_at"}
    changed = request.model_copy(update={"max_calls": request.max_calls + 1})
    with pytest.raises(DomainError) as conflict:
        await Delegations(service).issue(changed)
    assert conflict.value.code == "IDEMPOTENCY_CONFLICT"
    assert (await Delegations(service).authenticate("Bearer " + original.token))["id"] == original.id


async def test_grant_and_receipt_rollback_together_on_failed_receipt_write(service, monkeypatch):
    connection = service.repository.connection

    @asynccontextmanager
    async def fail_receipt():
        async with connection() as conn:
            class FailingConnection:
                async def execute(self, query, params=None):
                    if query.startswith("INSERT INTO effects"):
                        raise RuntimeError("Synthetic receipt write failure")
                    return await conn.execute(query, params)
            yield FailingConnection()

    request = grant_request(service.project.id)
    monkeypatch.setattr(service.repository, "connection", fail_receipt)
    with pytest.raises(RuntimeError, match="Synthetic receipt"):
        await Delegations(service).issue(request)
    monkeypatch.setattr(service.repository, "connection", connection)
    async with connection() as conn:
        row = await (await conn.execute("SELECT count(*) AS n FROM delegated_grants WHERE data->'projects' ? %s", (service.project.id,))).fetchone()
    assert row["n"] == 0
    result = await Delegations(service).issue(request)
    assert not result.recovered and result.token is not None


async def test_grant_owner_routes_are_typed_strict_and_revocation_is_truthful(service):
    from fastapi.responses import JSONResponse

    app = FastAPI()

    @app.exception_handler(DomainError)
    async def failure(request, error):
        return JSONResponse({"code": error.code}, status_code=error.status_code)

    install_a2a(app, lambda: service)
    request = grant_request(service.project.id).model_dump(mode="json")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture.test") as http:
        for invalid in [{key: value for key, value in request.items() if key != "version"},
                dict(request, version=True), dict(request, version=2),
                {key: value for key, value in request.items() if key != "idempotency_key"},
                dict(request, owner=True)]:
            assert (await http.post("/api/v1/delegations", json=invalid)).status_code == 422
        first = (await http.post("/api/v1/delegations", json=request)).json()
        assert first["version"] == 1 and first["token"] and not first["recovered"]
        retry = (await http.post("/api/v1/delegations", json=request)).json()
        assert retry["id"] == first["id"] and retry["token"] is None and retry["recovered"]
        listed = (await http.get("/api/v1/delegations")).json()
        view = next(item for item in listed if item["id"] == first["id"])
        assert view["version"] == 1 and "created_at" in view and "token" not in view
        revoked = (await http.delete("/api/v1/delegations/" + first["id"])).json()
        assert revoked["version"] == 1 and revoked["revoked"]
        again = (await http.delete("/api/v1/delegations/" + first["id"])).json()
        assert revoked == again
        assert (await http.delete("/api/v1/delegations/nonexistent-grant")).status_code == 404
    schema = app.openapi()
    assert schema["paths"]["/api/v1/delegations"]["post"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith("/GrantIssued")
    assert schema["paths"]["/api/v1/delegations"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["items"]["$ref"].endswith("/GrantView")
    assert schema["paths"]["/api/v1/delegations/{identifier}"]["delete"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith("/GrantRevoked")


async def test_sdk_inbound_repeated_message_restart_cancel_expiry_and_forged_identity(service):
    grants = Delegations(service)
    issued = await grants.issue(grant_request(service.project.id))
    app = FastAPI()
    install_a2a(app, lambda: service)
    card = local_card("http://sabre.test")
    request = wire.SendMessageRequest(message=wire.Message(message_id="synthetic-message", role=wire.ROLE_USER,
        parts=[ParseDict({"data": command(service.project.id).model_dump(mode="json")}, wire.Part())]))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://sabre.test",
            headers={"Authorization": "Bearer " + issued.token}) as http:
        sdk = ClientFactory(ClientConfig(httpx_client=http, streaming=False, polling=True)).create(card)
        first = [event async for event in sdk.send_message(request)]
        repeated = [event async for event in sdk.send_message(request)]
        assert first[0].task.id == repeated[0].task.id
        assert (await sdk.get_task(wire.GetTaskRequest(id=first[0].task.id))).status.state == wire.TASK_STATE_SUBMITTED
        # Reconstructed services read the same grant and command receipts.
        fresh = Delegations(service)
        assert (await fresh.authenticate("Bearer " + issued.token))["id"] == issued.id
        result = await fresh.execute(issued.id, "synthetic-message", command(service.project.id))
        assert result.work_id == first[0].task.id
        async with service.repository.connection() as conn:
            count = await (await conn.execute("SELECT count(*) AS n FROM work_orders WHERE project_id=%s", (service.project.id,))).fetchone()
        assert count["n"] == 1
        metadata = ParseDict({"idempotencyKey": "synthetic-cancel-key"}, wire.CancelTaskRequest().metadata)
        canceled = await sdk.cancel_task(wire.CancelTaskRequest(id=result.work_id, metadata=metadata))
        assert canceled.status.state == wire.TASK_STATE_CANCELED
        bad = await http.post("/a2a", json={"jsonrpc": "2.0", "id": "version-test", "method": "GetTask", "params": {"id": result.work_id}}, headers={"A2A-Version": "9.0"})
        assert "error" in bad.json()
        await fresh.revoke(issued.id)
        with pytest.raises(DomainError) as denied:
            await fresh.query(issued.id, result.work_id)
        assert denied.value.code == "DELEGATION_EXPIRED"
        await sdk.close()
    second = await grants.issue(grant_request(service.project.id))
    async with service.repository.connection() as conn:
        await conn.execute("UPDATE delegated_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s", (second.id,))
    with pytest.raises(DomainError):
        await grants.authenticate("Bearer " + second.token)


async def test_delegated_scope_limits_and_approval_fields_cannot_expand_grant(service):
    grants = Delegations(service)
    issued = await grants.issue(grant_request(service.project.id))
    for request in [command("another-project"), command(service.project.id, budget=Budget(max_cost_usd=1).model_dump()),
            command(service.project.id, budget=Budget(max_calls=None, max_tokens=None, active_seconds=None).model_dump())]:
        with pytest.raises(DomainError):
            await grants.execute(issued.id, "synthetic-message", request)
    service.submit.assert_not_awaited()
    with pytest.raises(DomainError):
        await grants.query(issued.id, "unknown-work")
    for name in ["owner", "OWNER", "supervisor"]:
        bad = grant_request(service.project.id).model_copy(update={"principal": name})
        with pytest.raises(DomainError):
            await grants.issue(bad)
    from sabre.budget_contracts import BudgetPolicy, MetricBudget
    policy = BudgetPolicy(version=1, tokens=MetricBudget(primary=None, absolute=None))
    request = command(service.project.id, budget=Budget(policy=policy).model_dump())
    with pytest.raises(DomainError) as denied:
        await grants.execute(issued.id, "synthetic-policy-bypass", request)
    assert denied.value.code == "DELEGATION_BUDGET_DENIED"


async def test_manifest_drift_disables_remote_approval_and_missing_credentials_block(service):
    from sabre.a2a import AgentRegistration, card_digest
    registry = A2ARegistry(service)
    card = MessageToDict(local_card("https://remote.example.com"))
    name = "fixture-" + new_id()[:8]
    await registry.save(name, AgentRegistration(expected_revision=0, endpoint="https://remote.example.com/a2a",
        card=card, reviewed_digest=card_digest(card), enabled=True, projects=[service.project.id]))
    row = await registry.get(name)
    registry.discover = AsyncMock(return_value={"reviewed_digest": row["digest"]})
    service.queue.credentials = SimpleNamespace(resolve=AsyncMock(return_value=SecretStr("")))
    with pytest.raises(DomainError) as missing:
        async with registry.client(row, service.project.id):
            pass
    assert missing.value.code == "A2A_CREDENTIAL_MISSING"
    registry.discover.return_value = {"reviewed_digest": "f" * 64}
    with pytest.raises(DomainError) as changed:
        async with registry.client(row, service.project.id):
            pass
    assert changed.value.code == "A2A_MANIFEST_CHANGED"
    current = await registry.get(name)
    assert not current["enabled"] and current["revision"] == 2


async def test_owner_remote_controls_bind_run_and_reject_changed_input_before_send(service, monkeypatch):
    from fastapi.responses import JSONResponse
    from psycopg.types.json import Jsonb

    from sabre.a2a import AgentRegistration, card_digest
    from sabre.repository import digest

    work = await service.submit(command(service.project.id).payload.request)
    other = await service.submit(command(service.project.id, idempotency_key="synthetic-other-work-request").payload.request)
    name = "fixture-" + new_id()[:8]
    card = MessageToDict(local_card("https://remote.example.com"))
    registry = A2ARegistry(service)
    await registry.save(name, AgentRegistration(expected_revision=0, endpoint="https://remote.example.com/a2a",
        card=card, reviewed_digest=card_digest(card), enabled=True, projects=[service.project.id]))
    task = work_task(work)
    task.status.state = wire.TASK_STATE_INPUT_REQUIRED
    key = "synthetic-receipt-" + work.id
    async with service.repository.connection() as conn:
        await conn.execute("""INSERT INTO a2a_tasks(attempt_key,work_id,agent_name,card_digest,request_hash,message_id,remote_task_id,remote_context_id,state,result)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'received',%s)""",
            (key, work.id, name, card_digest(card), "a" * 64, "synthetic-message", task.id, task.context_id, Jsonb(MessageToDict(task))))
    row = await OutboundA2A(registry).receipt(key)
    reconcile = AsyncMock(return_value=row)
    send = AsyncMock()
    monkeypatch.setattr(OutboundA2A, "reconcile", reconcile)
    monkeypatch.setattr(OutboundA2A, "send", send)
    app = FastAPI()

    @app.exception_handler(DomainError)
    async def failure(request, error):
        return JSONResponse({"code": error.code}, status_code=error.status_code)

    install_a2a(app, lambda: service)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture.test") as http:
        foreign = await http.post(f"/api/v1/work/{other.id}/a2a-tasks/poll", json={"attempt_key": key})
        assert foreign.status_code == 403 and foreign.json()["code"] == "A2A_TASK_SCOPE_DENIED"
        reconcile.assert_not_awaited()
        observed = await http.post(f"/api/v1/work/{work.id}/a2a-tasks/poll", json={"attempt_key": key})
        assert observed.status_code == 200
        assert observed.json()["input_digest"] == digest(MessageToDict(task.status.message))
        stale = await http.post(f"/api/v1/work/{work.id}/a2a-tasks/answer", json={"attempt_key": key,
            "expected_input_digest": "f" * 64, "answer": "An answer to an earlier question"})
        assert stale.status_code == 409 and stale.json()["code"] == "A2A_INPUT_CHANGED"
        send.assert_not_awaited()


async def test_outbound_lost_response_reconciles_without_duplicate_external_effect(service):
    work = await service.submit(command(service.project.id).payload.request)
    card = MessageToDict(local_card("https://remote.example.com"))
    name = "fixture-" + new_id()[:8]
    from sabre.a2a import AgentRegistration, card_digest
    registry = A2ARegistry(service)
    await registry.save(name, AgentRegistration(expected_revision=0, endpoint="https://remote.example.com/a2a",
        card=card, reviewed_digest=card_digest(card), enabled=True, projects=[service.project.id]))
    remote_tasks = {}
    calls = []

    class RemoteSDKAgent(InboundA2A):
        async def on_message_send(self, params, context):
            calls.append(params.message.message_id)
            task = work_task(work)
            task.context_id = params.message.context_id
            task.status.state = wire.TASK_STATE_INPUT_REQUIRED
            task.history.append(params.message)
            remote_tasks[task.id] = task
            raise RuntimeError("Synthetic response lost after committed effect")

        async def on_get_task(self, params, context):
            return remote_tasks[params.id]

        async def on_list_tasks(self, params, context):
            return wire.ListTasksResponse(tasks=list(remote_tasks.values()))

        async def on_cancel_task(self, params, context):
            remote_tasks[params.id].status.state = wire.TASK_STATE_CANCELED
            return remote_tasks[params.id]

    app = FastAPI()
    app.routes.extend(create_jsonrpc_routes(RemoteSDKAgent(lambda: None), "/a2a"))

    @asynccontextmanager
    async def client(row, project_id, *, work_id=None):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="https://remote.example.com") as http:
            sdk = ClientFactory(ClientConfig(httpx_client=http, streaming=False, polling=True)).create(local_card("https://remote.example.com"))
            try:
                yield sdk
            finally:
                await sdk.close()

    registry.client = client
    outbound = OutboundA2A(registry)
    request = wire.SendMessageRequest(message=wire.Message(message_id="synthetic-remote-message", role=wire.ROLE_USER,
        parts=[wire.Part(text="Synthetic external task")]))
    with pytest.raises(DomainError) as uncertain:
        await outbound.send(name, work.id, "fixture-attempt-" + work.id, request)
    assert uncertain.value.code == "A2A_OUTCOME_UNCERTAIN"
    restarted = OutboundA2A(registry)
    result = await restarted.send(name, work.id, "fixture-attempt-" + work.id, request)
    assert result["remote_task_id"] == work.id and result["cost_usd"] is None
    assert calls == ["synthetic-remote-message"]
    assert result["result"]["status"]["state"] == "TASK_STATE_INPUT_REQUIRED"
    canceled = await restarted.reconcile("fixture-attempt-" + work.id, cancel=True)
    assert canceled["result"]["status"]["state"] == "TASK_STATE_CANCELED"
