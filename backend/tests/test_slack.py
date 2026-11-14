from contextlib import asynccontextmanager
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import PrivateAttr, SecretStr, ValidationError

from sabre.models import Budget, DomainError, HumanQuestion, Status, WorkOrder
from sabre.security import SecretGuard
from sabre.settings import RoleModelSettings, Settings
from sabre.slack import (
    ChatGuard,
    GatewaySettings,
    SlackConversation,
    SlackMessage,
    admit_message,
    conversation_tools,
    deliver_notifications,
    explicit_budgets,
    slack_text,
)


def config():
    cfg = SimpleNamespace(
        slack_owner_id="UOWNER", slack_bot_token=SecretStr("synthetic-bot-token"),
        model_max_output_tokens=100, model_input_usd_per_million=2,
        model_output_usd_per_million=8, monthly_budget_usd=20, chat_budget_usd=0.25,
        model_ready=lambda: True,
    )
    cfg.for_role = lambda role: cfg
    return cfg


def event(**changes):
    data = dict(event_id="Ev12345678", user="UOWNER", channel="DOWNER", channel_type="im",
                ts="1234.0001", thread_ts=None, text="¿Cómo va el trabajo?")
    return SlackMessage(**(data | changes))


def work(**changes):
    return WorkOrder(project_id="project-one", mode="patch", objective="Corregir el defecto de importación",
                     acceptance=["Rechaza entradas inválidas"], budget=Budget(max_cost_usd=5),
                     idempotency_key="test-work-idempotency", **changes)


class FakeSlack:
    def __init__(self):
        self.messages = []
        self.post_calls = 0
        self.lose_next_ack = False

    async def conversations_open(self, users):
        assert users == "UOWNER"
        return {"channel": {"id": "DOWNER"}}

    async def chat_postMessage(self, **kwargs):
        self.post_calls += 1
        value = {**kwargs, "ts": f"1234.{self.post_calls:04}"}
        self.messages.append(value)
        if self.lose_next_ack:
            self.lose_next_ack = False
            raise TimeoutError("Synthetic acknowledgement loss")
        return value

    async def conversations_history(self, **kwargs):
        return {"messages": self.messages}

    async def conversations_replies(self, **kwargs):
        return {"messages": [item for item in self.messages if item.get("thread_ts") == kwargs["ts"]]}


class FakeRepository:
    def __init__(self, order=None):
        self.order = order or work()
        self.effects = {}
        self.reservations = []
        self.settled = []

    async def work(self, work_id):
        assert work_id == self.order.id
        return self.order

    async def works(self):
        return [self.order]

    async def projects(self):
        return []

    async def pending_answer(self, work_id):
        return None

    async def control(self, work_id):
        return self.order.control

    async def begin_effect(self, key, request):
        return self.effects.setdefault(key, {"state": "pending", "request": request})

    async def finish_effect(self, key, result):
        self.effects[key].update(state="completed", result=result)

    async def reserve_chat_usage(self, *args):
        self.reservations.append(args)
        return f"usage-{len(self.reservations)}"

    async def settle_usage(self, *args, breakdown=None):
        self.settled.append(args)


class FakeStore:
    def __init__(self, repository):
        self.repository = repository
        self.notices = []
        self.threads = {}
        self.admitted = []
        self.uncertain = []

    async def admit(self, message, task):
        self.admitted.append(message)
        return {"accepted": True, "event_id": message.event_id, "duplicate": False}

    @asynccontextmanager
    async def delivery_lock(self):
        yield True

    async def pending(self):
        return [item for item in self.notices if not item.get("delivered")]

    async def mark_delivered(self, ids):
        for item in self.notices:
            if item["id"] in ids:
                item["delivered"] = True

    async def mark_uncertain(self, ids):
        self.uncertain.extend(ids)

    async def effect(self, key):
        return self.repository.effects.get(key)

    async def thread(self, work_id):
        return self.threads.get(work_id)

    async def save_thread(self, work_id, channel, thread_ts):
        self.threads[work_id] = {"channel": channel, "thread_ts": thread_ts}


def service(order=None):
    repository = FakeRepository(order)
    store = FakeStore(repository)
    return SimpleNamespace(repository=repository, guard=SecretGuard(), config=config(),
                           slack_client=FakeSlack(), queue=SimpleNamespace(slack_store=store, slack_message=object()))


@pytest.mark.asyncio
async def test_only_owner_dm_is_admitted_and_secret_input_never_reaches_inbox():
    svc = service()
    response = await admit_message(svc, event().model_dump())
    assert response["accepted"]
    assert len(svc.queue.slack_store.admitted) == 1
    with pytest.raises(DomainError, match="Only the owner"):
        await admit_message(svc, event(user="UOTHER").model_dump())
    with pytest.raises(DomainError, match="direct message"):
        await admit_message(svc, event(channel="DOTHER").model_dump())
    with pytest.raises(DomainError) as secret:
        await admit_message(svc, event(text="sk-proj-" + "x" * 40).model_dump())
    assert secret.value.code == "SECRET_DETECTED"
    assert len(svc.queue.slack_store.admitted) == 1


@pytest.mark.asyncio
async def test_non_dm_event_is_rejected_without_persistence():
    svc = service()
    raw = event().model_dump() | {"channel": "CPUBLIC", "channel_type": "channel"}
    with pytest.raises(DomainError) as error:
        await admit_message(svc, raw)
    assert error.value.code == "INVALID_SLACK_MESSAGE"
    assert not svc.queue.slack_store.admitted


@pytest.mark.asyncio
async def test_notifications_reconcile_a_lost_ack_without_posting_twice():
    svc = service()
    store, slack = svc.queue.slack_store, svc.slack_client
    store.notices = [{"id": "reply-one", "work_id": None, "data": {"kind": "chat_reply", "channel": "DOWNER", "thread_ts": "1234.0000", "message": "El encargo está en curso"}}]
    slack.lose_next_ack = True
    with pytest.raises(TimeoutError):
        await deliver_notifications(svc.repository, svc.config, svc.guard, store=store, client=slack)
    assert slack.post_calls == 1
    assert not store.notices[0].get("delivered")
    await deliver_notifications(svc.repository, svc.config, svc.guard, store=store, client=slack)
    assert slack.post_calls == 1
    assert store.notices[0]["delivered"]


@pytest.mark.asyncio
async def test_uncertain_delivery_is_held_when_remote_evidence_cannot_be_found():
    svc = service()
    store, slack = svc.queue.slack_store, svc.slack_client
    store.notices = [{"id": "reply-one", "work_id": None, "data": {"channel": "DOWNER", "thread_ts": "1234.0000", "message": "Estado actual"}}]
    svc.repository.effects["reply-one"] = {"state": "pending"}
    await deliver_notifications(svc.repository, svc.config, svc.guard, store=store, client=slack)
    assert slack.post_calls == 0
    assert store.uncertain == ["reply-one"]
    assert not store.notices[0].get("delivered")


@pytest.mark.asyncio
async def test_each_work_uses_one_owner_thread_and_phase_notices_are_grouped():
    svc = service()
    store, slack = svc.queue.slack_store, svc.slack_client
    order = svc.repository.order
    store.notices = [{"id": f"phase-{index}", "work_id": order.id, "data": {"kind": "phase"}} for index in range(3)]
    await deliver_notifications(svc.repository, svc.config, svc.guard, store=store, client=slack)
    assert slack.post_calls == 2  # One anchor, one grouped progress message.
    thread = store.threads[order.id]["thread_ts"]
    assert slack.messages[1]["thread_ts"] == thread
    assert all(item["channel"] == "DOWNER" for item in slack.messages)
    store.notices.append({"id": "phase-extra", "work_id": order.id, "data": {"kind": "phase"}})
    await deliver_notifications(svc.repository, svc.config, svc.guard, store=store, client=slack)
    assert slack.post_calls == 2


@pytest.mark.asyncio
async def test_notification_cannot_redirect_to_an_arbitrary_channel():
    svc = service()
    store, slack = svc.queue.slack_store, svc.slack_client
    store.notices = [{"id": "reply-one", "work_id": None, "data": {"channel": "DOTHER", "thread_ts": "1234.0000", "message": "Estado"}}]
    with pytest.raises(DomainError, match="owner"):
        await deliver_notifications(svc.repository, svc.config, svc.guard, store=store, client=slack)
    assert slack.post_calls == 0


@pytest.mark.asyncio
async def test_notifications_request_only_questions_from_the_current_plan_revision():
    svc = service()
    order = svc.repository.order
    order.plan_revision = 2
    order.questions = [
        HumanQuestion(work_id=order.id, plan_revision=1, kind="clarification", prompt="Petición caducada"),
        HumanQuestion(work_id=order.id, plan_revision=2, kind="clarification", prompt="Decisión vigente"),
    ]
    store, slack = svc.queue.slack_store, svc.slack_client
    store.notices = [{"id": "question-notice", "work_id": order.id, "data": {"kind": "question"}}]
    await deliver_notifications(svc.repository, svc.config, svc.guard, store=store, client=slack)
    assert "Decisión vigente" in slack.messages[-1]["text"]
    assert "Petición caducada" not in slack.messages[-1]["text"]
    tools = {item.name: item for item in conversation_tools(svc, store, event())}
    listed = await tools["list_work"].ainvoke({})
    assert [question["prompt"] for question in listed[0]["questions"]] == ["Decisión vigente"]


@pytest.mark.asyncio
async def test_pre_model_guard_and_budget_reservation_precede_network_call():
    svc = service()
    middleware = ChatGuard(svc.repository, svc.config, svc.guard, "Ev12345678")
    request = SimpleNamespace(messages=[HumanMessage(content="Estado del proyecto")], tools=[], system_message=SystemMessage(content="Supervisor"))
    calls = []

    async def handler(_request):
        assert len(svc.repository.reservations) == 1
        calls.append(True)
        return SimpleNamespace(result=[AIMessage(content="En curso", usage_metadata={"input_tokens": 10, "output_tokens": 3, "total_tokens": 13})])

    await middleware.awrap_model_call(request, handler)
    assert len(svc.repository.settled) == 1
    request.messages = [HumanMessage(content="sk-proj-" + "x" * 40)]
    with pytest.raises(DomainError):
        await middleware.awrap_model_call(request, handler)
    assert calls == [True]
    assert len(svc.repository.reservations) == 1


@pytest.mark.asyncio
async def test_unknown_model_outcome_keeps_its_spending_reservation():
    svc = service()
    middleware = ChatGuard(svc.repository, svc.config, svc.guard, "Ev12345678")
    request = SimpleNamespace(messages=[HumanMessage(content="Estado del proyecto")], tools=[], system_message=None)

    calls = 0

    async def handler(_request):
        nonlocal calls
        calls += 1
        raise TimeoutError("Synthetic provider timeout")

    middleware.sleep = AsyncMock()
    # A timeout is tried again inside the same reservation, then leaves with its class.
    with pytest.raises(DomainError) as caught:
        await middleware.awrap_model_call(request, handler)
    assert caught.value.code == "MODEL_TIMEOUT" and calls == 3 and middleware.sleep.await_count == 2
    assert len(svc.repository.reservations) == 1
    assert not svc.repository.settled


@pytest.mark.parametrize("provider", ["codex_cli", "claude_cli"])
async def test_cli_chat_overrun_keeps_actual_usage_and_no_api_charge(provider):
    svc = service()
    svc.config.model_provider = provider
    middleware = ChatGuard(svc.repository, svc.config, svc.guard, "Ev12345678")
    request = SimpleNamespace(messages=[HumanMessage(content="Estado del proyecto")], tools=[], system_message=None)

    async def handler(_request):
        return SimpleNamespace(result=[AIMessage(content="En curso", usage_metadata={"input_tokens": 1_000_000, "output_tokens": 3, "total_tokens": 1_000_003})])

    with pytest.raises(DomainError) as error:
        await middleware.awrap_model_call(request, handler)
    assert error.value.code == "CLI_USAGE_EXCEEDED"
    assert svc.repository.reservations[0][2] == 0
    assert svc.repository.settled == [("usage-1", 1_000_003, 0)]


@pytest.mark.asyncio
async def test_model_secret_output_is_stopped_before_it_can_be_saved_or_sent():
    svc = service()
    middleware = ChatGuard(svc.repository, svc.config, svc.guard, "Ev12345678")
    request = SimpleNamespace(messages=[HumanMessage(content="Estado del proyecto")], tools=[], system_message=None)

    async def handler(_request):
        return SimpleNamespace(result=[AIMessage(content="sk-proj-" + "x" * 40)])

    with pytest.raises(DomainError) as error:
        await middleware.awrap_model_call(request, handler)
    assert error.value.code == "SECRET_DETECTED"
    assert len(svc.repository.reservations) == 1
    assert not svc.repository.settled


@pytest.mark.asyncio
async def test_submit_requires_explicit_currency_budget_and_binds_channel_and_idempotency():
    svc = service()
    submitted = []

    async def submit(request):
        submitted.append(request)
        return WorkOrder(**request.model_dump())

    svc.submit = submit
    args = {"request": {"project_id": "project-one", "mode": "patch", "objective": "Corregir el defecto", "acceptance": ["Pasa la regresión"], "budget": {"max_cost_usd": 5}, "idempotency_key": "model-supplied-key", "channel": "web"}}
    tools = {item.name: item for item in conversation_tools(svc, svc.queue.slack_store, event())}
    with pytest.raises(DomainError) as error:
        await tools["submit_work"].ainvoke(args)
    assert error.value.code == "BUDGET_CONFIRMATION_REQUIRED"
    assert not submitted
    tools = {item.name: item for item in conversation_tools(svc, svc.queue.slack_store, event(text="Corrige el defecto con un máximo de 5 USD"))}
    await tools["submit_work"].ainvoke(args)
    assert submitted[0].idempotency_key == "slack:Ev12345678"
    assert submitted[0].channel == "slack"
    assert submitted[0].channel_thread == "DOWNER/1234.0001"
    args["request"]["budget"]["max_cost_usd"] = 0
    tools = {item.name: item for item in conversation_tools(svc, svc.queue.slack_store, event(text="Corrige el defecto con Codex"))}
    await tools["submit_work"].ainvoke(args)
    assert submitted[-1].budget.max_cost_usd == 0


@pytest.mark.asyncio
async def test_control_requires_a_bound_work_thread_or_explicit_work_id():
    svc = service()
    controls = []

    async def control(work_id, command):
        controls.append(command)
        svc.repository.order.status = Status.PAUSED
        return svc.repository.order

    svc.control = control
    tools = {item.name: item for item in conversation_tools(svc, svc.queue.slack_store, event(text="Páusalo"))}
    with pytest.raises(DomainError) as error:
        await tools["control_work"].ainvoke({"work_id": svc.repository.order.id, "command": "pause"})
    assert error.value.code == "WORK_CONTEXT_REQUIRED"
    assert not controls
    svc.queue.slack_store.threads[svc.repository.order.id] = {"channel": "DOWNER", "thread_ts": "1234.0001"}
    await tools["control_work"].ainvoke({"work_id": svc.repository.order.id, "command": "pause"})
    await tools["control_work"].ainvoke({"work_id": svc.repository.order.id, "command": "pause"})
    assert controls == ["pause"]


class ScriptedModel(BaseChatModel):
    _script: list = PrivateAttr()
    _calls: int = PrivateAttr(default=0)

    def __init__(self, script):
        super().__init__()
        self._script = script

    @property
    def _llm_type(self):
        return "synthetic-slack-conversation-test"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        result = self._script[min(self._calls, len(self._script) - 1)]
        self._calls += 1
        return ChatResult(generations=[ChatGeneration(message=result)])


@pytest.mark.asyncio
async def test_natural_language_runs_a_real_langchain_tool_loop_and_recovers_checkpoint():
    svc = service()
    model = ScriptedModel([
        AIMessage(content="", tool_calls=[{"name": "get_work", "args": {"work_id": svc.repository.order.id}, "id": "call-1", "type": "tool_call"}]),
        AIMessage(content="El encargo está en cola. Aún no se ha iniciado."),
        AIMessage(content="Necesita que el worker esté disponible."),
    ])
    conversation = SlackConversation(svc, svc.queue.slack_store, InMemorySaver(), model_factory=lambda: model)
    reply = await conversation.reply(event())
    assert "en cola" in reply
    assert model._calls == 2
    assert await conversation.reply(event()) == reply
    assert model._calls == 2
    assert len(svc.repository.reservations) == 2
    follow_up = event(event_id="Ev99999999", text="¿Y qué necesita?")
    assert "worker" in await conversation.reply(follow_up)
    assert model._calls == 3
    assert await conversation.reply(event()) == reply
    assert model._calls == 3


def test_budget_parser_requires_currency_and_slack_output_escapes_mentions():
    assert explicit_budgets("Tengo 5 tareas") == set()
    assert explicit_budgets("máximo 1,50 USD") == {Decimal("1.50")}
    assert slack_text("<!channel> <@UOTHER> & texto") == "&lt;!channel&gt; &lt;@UOTHER&gt; &amp; texto"


@pytest.mark.asyncio
async def test_conversation_uses_supervisor_model_limits_and_prices(monkeypatch):
    svc = service()
    svc.config = Settings(database_url="postgresql://synthetic", auth_token="synthetic-auth-token-123456", executor_token="synthetic-executor-token-000", model_name="global-model", model_provider="local", model_base_url="http://global-model:8000", model_max_output_tokens=256, model_input_usd_per_million=1, model_output_usd_per_million=2, monthly_budget_usd=20, role_models={"supervisor": RoleModelSettings(model_provider="local", model_name="supervisor-model", model_base_url="http://supervisor-model:8000", model_max_output_tokens=128, model_input_usd_per_million=3, model_output_usd_per_million=9)})
    model = ScriptedModel([AIMessage(content="El encargo está en cola.", usage_metadata={"input_tokens": 10, "output_tokens": 3, "total_tokens": 13})])
    configured = {}

    def local_model(**kwargs):
        configured.update(kwargs)
        return model

    monkeypatch.setattr("sabre.model_providers.ChatOpenAI", local_model)
    conversation = SlackConversation(svc, svc.queue.slack_store, InMemorySaver())
    assert "en cola" in await conversation.reply(event())
    assert configured["model"] == "supervisor-model"
    assert configured["base_url"] == "http://supervisor-model:8000"
    assert configured["max_completion_tokens"] == 128
    _, reserved_tokens, reserved_cost, _, _ = svc.repository.reservations[0]
    assert reserved_cost == pytest.approx(((reserved_tokens - 128) * 3 + 128 * 9) / 1_000_000)
    assert svc.repository.settled[0][2] == pytest.approx((10 * 3 + 3 * 9) / 1_000_000)


def test_gateway_validation_does_not_echo_configuration_inputs(monkeypatch):
    monkeypatch.delenv("SABRE_BOOTSTRAP_FILE", raising=False)
    with pytest.raises(ValidationError) as error:
        GatewaySettings(_env_file=None, gateway_token={"private": "synthetic-private-value"}, slack_bot_token="synthetic-bot", slack_app_token="synthetic-app", slack_owner_id="UOWNER")
    assert "synthetic-private-value" not in str(error.value)
