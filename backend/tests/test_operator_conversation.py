import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from sabre.api import create_app
from sabre.models import DomainError
from sabre.operator_contracts import OperatorContext, OperatorMessageRequest
from sabre.security import SecretGuard
from sabre.slack import conversation_tools
from sabre.supervisor import SupervisorConversation


def request(**changes):
    return {"version": 1, "text": "Inspect the current run", "idempotency_key": "synthetic-request-000", **changes}


def test_identity_and_authority_are_not_accepted_from_message_content():
    for change in ({"principal": "owner"}, {"sender": "owner"}, {"source": "mcp"}, {"allowed_actions": ["increase_token_budget"]},
                   {"version": True}, {"work_id": "run-a", "allowed_actions": ["submit_work"]}):
        with pytest.raises(ValidationError):
            OperatorMessageRequest.model_validate(request(**change))


def test_conversation_is_read_only_without_explicit_action_grants():
    service = SimpleNamespace(repository=SimpleNamespace(), guard=SecretGuard())
    event = OperatorContext.model_validate({**request(), "id": "message-1"})
    names = {tool.name for tool in conversation_tools(service, None, event)}
    assert names == {"list_projects", "list_work", "get_work", "get_work_budget", "security_findings", "search_memory"}
    event = OperatorContext.model_validate({**request(work_id="run-a", allowed_actions=["control_work"]), "id": "message-1"})
    names = {tool.name for tool in conversation_tools(service, None, event)}
    assert names == {"get_work", "get_work_budget", "control_work"}


async def test_missing_explicit_model_blocks_before_model_construction_or_network():
    config = SimpleNamespace(model_name="", model_ready=lambda: True)
    service = SimpleNamespace(config=SimpleNamespace(for_role=lambda _: config), guard=SecretGuard(), repository=object())
    model = Mock()
    conversation = SupervisorConversation(service, None, None, model_factory=model)
    event = OperatorContext.model_validate({**request(), "id": "message-1"})
    with pytest.raises(DomainError) as caught:
        await conversation.reply(event)
    assert caught.value.code == "MODEL_NOT_READY"
    model.assert_not_called()


async def test_run_scope_cannot_control_another_run_even_when_message_names_it():
    repository = SimpleNamespace(work=AsyncMock(return_value=SimpleNamespace(id="run-b")))
    service = SimpleNamespace(repository=repository, guard=SecretGuard(), control=AsyncMock())
    event = OperatorContext.model_validate({**request(work_id="run-a", text="Pause run-b", allowed_actions=["control_work"]), "id": "message-1"})
    control = next(tool for tool in conversation_tools(service, None, event) if tool.name == "control_work")
    with pytest.raises(DomainError) as caught:
        await control.ainvoke({"work_id": "run-b", "command": "pause"})
    assert caught.value.code == "OPERATOR_RUN_SCOPE"
    repository.work.assert_not_awaited()
    service.control.assert_not_awaited()


async def test_operator_endpoint_requires_owner_auth_and_rejects_claimed_identity():
    store = SimpleNamespace(admit=AsyncMock())
    service = SimpleNamespace(queue=SimpleNamespace(operator_conversation=store))
    config = SimpleNamespace(auth_token=SecretStr("synthetic-owner-authentication"),
        gateway_token=SecretStr("synthetic-slack-gateway-authentication"), allowed_origins=["http://localhost:8000"])
    app = create_app(service, config)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        assert (await client.post("/api/v1/operator/messages", json=request())).status_code == 401
        assert (await client.post("/api/v1/operator/messages", headers={"Authorization": "Bearer synthetic-slack-gateway-authentication"}, json=request())).status_code == 401
        response = await client.post("/api/v1/operator/messages", headers={"Authorization": "Bearer synthetic-owner-authentication"}, json=request(principal="owner"))
        assert response.status_code == 422
    store.admit.assert_not_awaited()


@pytest.mark.parametrize("failure", ["provider", "interrupted"])
async def test_worker_preserves_message_when_provider_is_unavailable_or_worker_stops(monkeypatch, failure):
    from sabre.operator_conversation import register_operator_job
    row = {"id": "message-1", "state": "queued", "data": request()}
    store = SimpleNamespace(get=AsyncMock(return_value=row), transition=AsyncMock())
    monkeypatch.setattr("sabre.operator_conversation.OperatorConversationStore", lambda *_: store)
    reply = AsyncMock(side_effect=DomainError("MODEL_NOT_READY", "Choose a model first") if failure == "provider" else asyncio.CancelledError())
    monkeypatch.setattr("sabre.supervisor.SupervisorConversation", lambda *_: SimpleNamespace(reply=reply))
    jobs = {}

    class Queue:
        def task(self, **options):
            assert options["retry"] == 0
            def register(function):
                jobs[options["name"]] = function
                return function
            return register

    runtime = SimpleNamespace(queue=Queue(), repository=object(), service=SimpleNamespace(guard=SecretGuard()), checkpointer=object())
    await register_operator_job(runtime)
    if failure == "interrupted":
        with pytest.raises(asyncio.CancelledError):
            await jobs["sabre.operator_message"]("message-1")
    else:
        await jobs["sabre.operator_message"]("message-1")
    store.transition.assert_any_await("message-1", "running")
    store.transition.assert_any_await("message-1", "blocked", error_code="MODEL_NOT_READY" if failure == "provider" else "OPERATOR_INTERRUPTED")
    assert row["data"]["text"] == "Inspect the current run"
