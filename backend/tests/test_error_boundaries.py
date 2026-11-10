from types import SimpleNamespace
from typing import TypedDict
from unittest.mock import AsyncMock

import httpx
import openai
import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from langgraph.types import RetryPolicy

from sabre.agents import GuardedCalls
from sabre.error_boundaries import guarded_call
from sabre.models import DomainError
from sabre.security import SecretGuard
from sabre.slack import ChatGuard
from sabre.tools import ToolCatalog, ToolDefinition, ToolPolicy
from sabre.workflows import FactoryState, observe_stage

SECRET = "synthetic-provider-credential-20261105"


class State(TypedDict):
    result: str


async def assert_checkpoint_clean(graph, saver, config):
    async for snapshot in graph.aget_state_history(config):
        assert SECRET not in repr(snapshot.values)
        assert SECRET not in repr(snapshot.tasks)
    for checkpoint in saver.list(config):
        assert SECRET not in repr(checkpoint.checkpoint)
        assert SECRET not in repr(checkpoint.pending_writes)


def fixture_request():
    return SimpleNamespace(messages=[HumanMessage(content="Read the fixture")], tools=[], system_message=None, response_format=None)


def fixture_config():
    return SimpleNamespace(model_max_output_tokens=128, model_input_usd_per_million=1, model_output_usd_per_million=2, monthly_budget_usd=10, chat_budget_usd=1)


@pytest.mark.parametrize("channel", ["agent", "slack"])
async def test_model_exception_never_enters_checkpoint_values_or_task_errors(channel):
    repo = SimpleNamespace(control=AsyncMock(return_value=None), reserve_usage=AsyncMock(return_value="usage"), reserve_chat_usage=AsyncMock(return_value="usage"))
    guard = SecretGuard([SECRET])
    middleware = GuardedCalls(repo, fixture_config(), SimpleNamespace(id="fixture"), guard) if channel == "agent" else ChatGuard(repo, fixture_config(), guard, "fixture-event")

    async def failed_provider(request):
        raise RuntimeError(SECRET)

    async def invoke(state):
        await middleware.awrap_model_call(fixture_request(), failed_provider)
        return {"result": "unreachable"}

    saver = InMemorySaver()
    graph = StateGraph(State).add_node("model", invoke).add_edge(START, "model").add_edge("model", END).compile(checkpointer=saver)
    config = {"configurable": {"thread_id": channel}}
    with pytest.raises(DomainError) as caught:
        await graph.ainvoke({"result": "pending"}, config, durability="sync")
    assert caught.value.code == "MODEL_PROVIDER_FAILED"
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
    await assert_checkpoint_clean(graph, saver, config)


async def test_tool_error_is_sanitized_before_toolnode_creates_a_message():
    async def failed_tool():
        raise ValueError(SECRET)

    catalog = ToolCatalog(SecretGuard([SECRET]))
    catalog.register(ToolDefinition("read_file", "Read the fixture", {"type": "object", "properties": {}, "additionalProperties": False}, ToolPolicy(frozenset({"developer"}), "read"), failed_tool))
    saver = InMemorySaver()
    graph = StateGraph(MessagesState).add_node("tools", ToolNode(catalog.for_role("developer"), handle_tool_errors=True)).add_edge(START, "tools").add_edge("tools", END).compile(checkpointer=saver)
    config = {"configurable": {"thread_id": "tool-error"}}
    result = await graph.ainvoke({"messages": [AIMessage(content="", tool_calls=[{"name": "read_file", "args": {}, "id": "fixture-call"}])]}, config, durability="sync")
    message = result["messages"][-1]
    assert message.type == "tool" and message.status == "error"
    assert SECRET not in message.content
    await assert_checkpoint_clean(graph, saver, config)


async def test_stage_constructor_failure_is_sanitized_before_outer_checkpoint():
    async def construct(state):
        raise ValueError(SECRET)

    saver = InMemorySaver()
    graph = StateGraph(FactoryState).add_node("construction", observe_stage("construction", construct, SecretGuard([SECRET]))).add_edge(START, "construction").add_edge("construction", END).compile(checkpointer=saver)
    config = {"configurable": {"thread_id": "construction"}}
    with pytest.raises(DomainError) as caught:
        await graph.ainvoke({"order": {"id": "fixture"}}, config, durability="sync")
    assert caught.value.code == "WORKFLOW_STAGE_FAILED"
    assert caught.value.__context__ is None
    await assert_checkpoint_clean(graph, saver, config)


async def test_sdk_connection_error_keeps_safe_transient_type_and_real_retry():
    calls = 0

    async def provider():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise openai.APIConnectionError(message=SECRET, request=httpx.Request("POST", "https://provider.invalid", headers={"Authorization": SECRET}))
        return "ready"

    async def invoke(state):
        return {"result": await guarded_call(provider, SecretGuard([SECRET]), "MODEL_PROVIDER_FAILED")}

    saver = InMemorySaver()
    graph = StateGraph(State).add_node("provider", invoke, retry_policy=RetryPolicy(max_attempts=2, initial_interval=0.001, retry_on=(httpx.ConnectError,))).add_edge(START, "provider").add_edge("provider", END).compile(checkpointer=saver)
    config = {"configurable": {"thread_id": "retry"}}
    result = await graph.ainvoke({"result": "pending"}, config, durability="sync")
    assert result["result"] == "ready" and calls == 2
    await assert_checkpoint_clean(graph, saver, config)


@pytest.mark.parametrize("secret", [False, True])
async def test_domain_errors_preserve_only_checked_fields_and_no_raw_context(secret):
    async def fail():
        raise DomainError("BUDGET_EXHAUSTED", SECRET if secret else "No queda presupuesto", 409)

    with pytest.raises(DomainError) as caught:
        await guarded_call(fail, SecretGuard([SECRET]), "MODEL_PROVIDER_FAILED")
    assert caught.value.code == ("SECRET_DETECTED" if secret else "BUDGET_EXHAUSTED")
    assert SECRET not in str(caught.value)
    assert caught.value.__cause__ is None and caught.value.__context__ is None
