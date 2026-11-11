from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import PrivateAttr

from sabre.api import create_app
from sabre.models import Budget, DomainError, WorkOrder
from sabre.operator_contracts import OperatorContext
from sabre.operator_inspection import inspect_operator_tools, recorded_tools
from sabre.security import SecretGuard
from sabre.settings import Settings
from sabre.supervisor import SupervisorConversation, conversation_tools


class BudgetModel(BaseChatModel):
    _calls: int = PrivateAttr(default=0)

    @property
    def _llm_type(self):
        return "synthetic-budget-tool-loop"

    def bind_tools(self, tools, **kwargs):
        assert {tool.name for tool in tools} == {"get_work", "get_work_budget", "get_factory_readiness"}
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._calls += 1
        if isinstance(messages[-1], ToolMessage):
            assert '"remaining": 850.0' in messages[-1].content
            message = AIMessage(content="The selected run allows 1,000 tokens; 100 are measured and 50 remain reserved.")
        else:
            message = AIMessage(content="", tool_calls=[{"name": "get_work_budget", "args": {"work_id": "run-a"}, "id": "budget-call", "type": "tool_call"}])
        return ChatResult(generations=[ChatGeneration(message=message)])


def setup():
    work = WorkOrder(id="run-a", project_id="project-a", mode="audit", objective="Inspect the example",
        acceptance=["Report evidence"], idempotency_key="synthetic-work-000", status="blocked",
        budget=Budget(max_tokens=1000, max_calls=10, active_seconds=3600, max_cost_usd=3),
        budget_revision=5, error_code="BUDGET_EXHAUSTED", limiting_metric="tokens")
    usage = {"calls": 2, "settled_calls": 1, "unsettled_calls": 1, "tokens": 150,
        "measured_tokens": 100, "unknown_reserved_tokens": 50, "cost_usd": 0.02}
    conn = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(fetchall=AsyncMock(return_value=[]))))

    @asynccontextmanager
    async def connection():
        yield conn

    repository = SimpleNamespace(work=AsyncMock(return_value=work), works=AsyncMock(return_value=[work]),
        audit_usage=AsyncMock(return_value=usage), unreconciled_usage=AsyncMock(return_value=[{"id": "pending-call"}]),
        audit_usage_breakdown=AsyncMock(return_value={"usage": usage, "measured_api_cost_usd": None, "reserved_api_cost_usd": 0.02}),
        connection=connection, reserve_chat_usage=AsyncMock(return_value="chat-call"), settle_usage=AsyncMock())
    cfg = Settings(database_url="postgresql://unused", auth_token="synthetic-auth-token-000000",
        executor_token="synthetic-executor-token-000", model_provider="codex_cli", model_name="synthetic-model")
    service = SimpleNamespace(repository=repository, guard=SecretGuard(), config=cfg, queue=SimpleNamespace())
    event = OperatorContext(version=1, id="message-a", text="What is this project's budget?",
        work_id="run-a", idempotency_key="synthetic-message-000")
    return service, event


async def test_readonly_supervisor_budget_uses_live_ledger_and_preserves_unknown_cost():
    service, event = setup()
    tools = {item.name: item for item in conversation_tools(service, None, event)}
    assert set(tools) == {"get_work", "get_work_budget", "get_factory_readiness"}
    result = await tools["get_work_budget"].ainvoke({"work_id": "run-a"})
    assert result["scope"] == "run" and result["project_id"] == "project-a"
    assert result["budget_revision"] == 5 and result["error_code"] == "BUDGET_EXHAUSTED"
    assert result["limits"]["metrics"]["tokens"] == {
        "policy": {"primary": 1000, "reserve": 0, "absolute": 1000},
        "used": 100.0, "reserved": 50.0, "remaining": 850.0, "unknown": True}
    assert result["usage"]["usage"]["calls"] == 2
    assert result["usage"]["measured_api_cost_usd"] is None
    assert result["api_spend_limit_usd"] == 3
    assert "checkpoint" not in result and "credentials" not in result
    service.repository.reserve_chat_usage.assert_not_awaited()


async def test_budget_read_cannot_cross_selected_run_even_if_the_owner_message_names_it():
    service, event = setup()
    event.text = "What is run-b's budget?"
    definition = next(item for item in conversation_tools(service, None, event) if item.name == "get_work_budget")
    with pytest.raises(DomainError) as caught:
        await definition.ainvoke({"work_id": "run-b"})
    assert caught.value.code == "OPERATOR_RUN_SCOPE"
    service.repository.work.assert_not_awaited()
    service.repository.audit_usage_breakdown.assert_not_awaited()


async def test_factory_project_lookup_filters_before_recent_run_limit():
    service, event = setup()
    event.work_id = None
    target = await service.repository.work("run-a")
    service.repository.works.return_value = [target.model_copy(update={"id": f"other-{index}", "project_id": "other"}) for index in range(35)] + [target]
    tool = next(item for item in conversation_tools(service, None, event) if item.name == "list_work")
    assert [item["id"] for item in await tool.ainvoke({"project_id": "project-a"})] == ["run-a"]


async def test_real_langgraph_readonly_tool_loop_persists_actual_budget_output():
    service, event = setup()
    saver = InMemorySaver()
    model = BudgetModel()
    conversation = SupervisorConversation(service, None, saver, model_factory=lambda: model)
    assert "1,000 tokens" in await conversation.reply(event)
    saved = await saver.aget_tuple({"configurable": {"thread_id": event.conversation_id}})
    page = recorded_tools(saved.checkpoint["channel_values"]["messages"], event.id, service.guard)
    assert page.available and len(page.tools) == 1
    assert page.tools[0].name == "get_work_budget" and page.tools[0].status == "completed"
    assert '"remaining": 850.0' in page.tools[0].output
    assert model._calls == 2
    assert await conversation.reply(event) == "The selected run allows 1,000 tokens; 100 are measured and 50 remain reserved."
    assert model._calls == 2


def test_tool_inspection_is_message_scoped_redacted_and_excludes_hidden_reasoning():
    guard = SecretGuard()
    messages = [
        HumanMessage(id="other-message", content="Other private context"),
        SystemMessage(content="Internal instructions"),
        HumanMessage(id="message-a", content="Budget?"),
        AIMessage(content=[{"type": "reasoning", "text": "Hidden chain of thought"}], tool_calls=[
            {"name": "get_work_budget", "args": {"work_id": "run-a"}, "id": "call-a", "type": "tool_call"}]),
        ToolMessage(tool_call_id="call-a", content="sk-proj-" + "x" * 40, status="error"),
        HumanMessage(id="later-message", content="Later request"),
        AIMessage(content="", tool_calls=[{"name": "get_work", "args": {}, "id": "later-call", "type": "tool_call"}]),
    ]
    page = recorded_tools(messages, "message-a", guard)
    assert len(page.tools) == 1 and page.tools[0].status == "error" and page.tools[0].redacted
    assert page.tools[0].output == "[Redacted by the factory secret policy]"
    assert "Hidden" not in page.model_dump_json() and "Internal instructions" not in page.model_dump_json()
    assert not recorded_tools(messages, "missing", guard).available


async def test_tool_inspection_resolves_thread_from_persisted_scope_not_request_input():
    service, _ = setup()
    service.queue.operator_conversation = SimpleNamespace(get=AsyncMock(return_value={"data": {"work_id": "run-a"}}))
    saver = SimpleNamespace(aget_tuple=AsyncMock(return_value=None))
    service.factory = SimpleNamespace(team=SimpleNamespace(checkpointer=saver))
    assert not (await inspect_operator_tools(service, "message-a")).available
    saver.aget_tuple.assert_awaited_once_with({"configurable": {"thread_id": "operator:owner:run:run-a"}})


async def test_tool_trace_endpoint_requires_owner_identity_and_404s_missing_messages():
    service, _ = setup()
    store = SimpleNamespace(get=AsyncMock(return_value=None))
    service.queue.operator_conversation = store
    app = create_app(service, service.config)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        path = "/api/v1/operator/messages/unknown-message/tools"
        assert (await client.get(path)).status_code == 401
        store.get.assert_not_awaited()
        response = await client.get(path, headers={"Authorization": "Bearer synthetic-auth-token-000000"})
        assert response.status_code == 404


def test_tool_trace_is_bounded_and_does_not_invent_results_for_pending_calls():
    messages = [HumanMessage(id="message-a", content="Inspect"),
        AIMessage(content="", tool_calls=[{"name": "get_work", "args": {}, "id": f"call-{index}", "type": "tool_call"} for index in range(51)])]
    page = recorded_tools(messages, "message-a", SecretGuard())
    assert page.truncated and len(page.tools) == 50
    assert all(call.status == "pending" and call.output is None for call in page.tools)
