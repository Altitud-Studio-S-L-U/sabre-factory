from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from sabre.models import DomainError
from sabre.supervisor import ChatGuard, conversation_window
from tests.test_slack import service


@pytest.mark.parametrize("provider", ["openai", "anthropic", "google"])
@pytest.mark.parametrize("field,value,expected", [
    ("model_input_usd_per_million", 0, "MODEL_PRICING_REQUIRED"),
    ("model_input_usd_per_million", None, "MODEL_PRICING_REQUIRED"),
    ("model_output_usd_per_million", 0, "MODEL_PRICING_REQUIRED"),
    ("model_output_usd_per_million", float("nan"), "MODEL_PRICING_REQUIRED"),
    ("monthly_budget_usd", 0, "API_BUDGET_REQUIRED"),
    ("chat_budget_usd", 0, "API_BUDGET_REQUIRED"),
])
async def test_paid_conversation_rejects_unknown_prices_or_missing_allowance_before_any_dispatch(provider, field, value, expected):
    owner = service()
    owner.config.model_provider = provider
    setattr(owner.config, field, value)
    credentials, provider_call = AsyncMock(), AsyncMock()
    guard = ChatGuard(owner.repository, owner.config, owner.guard, "message", credential_check=credentials)
    request = SimpleNamespace(messages=[HumanMessage(content="Inspect current status")], tools=[], system_message=None)
    with pytest.raises(DomainError) as error:
        await guard.awrap_model_call(request, provider_call)
    assert error.value.code == expected
    assert owner.repository.reservations == []
    credentials.assert_not_awaited()
    provider_call.assert_not_awaited()


@pytest.mark.parametrize("provider", ["codex_cli", "claude_cli"])
async def test_cli_conversation_keeps_zero_api_spend_without_paid_pricing(provider):
    owner = service()
    owner.config.model_provider = provider
    owner.config.model_input_usd_per_million = owner.config.model_output_usd_per_million = 0
    owner.config.monthly_budget_usd = owner.config.chat_budget_usd = 0
    provider_call = AsyncMock(return_value=SimpleNamespace(result=[AIMessage(content="Observed status", usage_metadata={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2})]))
    guard = ChatGuard(owner.repository, owner.config, owner.guard, "message")
    await guard.awrap_model_call(SimpleNamespace(messages=[HumanMessage(content="Inspect status")], tools=[], system_message=None), provider_call)
    assert len(owner.repository.reservations) == 1
    assert owner.repository.reservations[0][2] == 0
    assert owner.repository.settled[0][2] == 0


def turn(number, size=400):
    """One complete owner turn: question, a tool call with its result, and the reply."""
    return [HumanMessage(content=f"Question {number}: " + "q" * size, id=f"human-{number}"),
            AIMessage(content="", tool_calls=[{"name": "get_work", "args": {"work_id": "run"}, "id": f"call-{number}"}]),
            ToolMessage(content="s" * size, tool_call_id=f"call-{number}"),
            AIMessage(content=f"Reply {number}")]


def long_conversation(turns, limit):
    owner = service()
    owner.config.model_provider = "codex_cli"
    owner.config.model_input_usd_per_million = owner.config.model_output_usd_per_million = 0
    sent = []

    async def provider_call(request):
        sent.append(request)
        return SimpleNamespace(result=[AIMessage(content="Observed status")])

    messages = [item for number in range(1, turns + 1) for item in turn(number)][:-1]
    request = ModelRequest(model=SimpleNamespace(), messages=messages, system_message=SystemMessage(content="Supervisor instructions."), tools=[])
    return owner, ChatGuard(owner.repository, owner.config, owner.guard, "message", input_limit=limit), request, provider_call, sent


async def test_a_long_conversation_sends_its_most_recent_complete_turns_and_says_what_was_left_out():
    owner, guard, request, provider_call, sent = long_conversation(turns=8, limit=6000)
    await guard.awrap_model_call(request, provider_call)
    kept = sent[0].messages
    assert len(request.messages) == 31 and 0 < len(kept) < 31
    assert kept[0].type == "human" and kept[-1] is request.messages[-1]
    assert kept == request.messages[-len(kept):]
    answered = {item.tool_call_id for item in kept if item.type == "tool"}
    assert {call["id"] for item in kept if item.type == "ai" for call in item.tool_calls} == answered
    omitted = len(request.messages) - len(kept)
    assert sent[0].system_message.content.startswith("Supervisor instructions.")
    assert f"left out of this request to fit its context: {omitted} messages" in sent[0].system_message.content
    assert request.system_message.content == "Supervisor instructions."
    reserved = owner.repository.reservations[0][1]
    assert reserved <= 6000 + 2048 + owner.config.model_max_output_tokens


async def test_a_conversation_inside_its_limit_is_sent_whole_and_unchanged():
    _owner, guard, request, provider_call, sent = long_conversation(turns=3, limit=60000)
    await guard.awrap_model_call(request, provider_call)
    assert sent[0] is request


async def test_a_current_turn_that_does_not_fit_is_refused_without_calling_the_model():
    owner, guard, request, provider_call, sent = long_conversation(turns=4, limit=700)
    with pytest.raises(DomainError) as error:
        await guard.awrap_model_call(request, provider_call)
    assert error.value.code == "CONTEXT_BUDGET_EXHAUSTED"
    assert sent == [] and owner.repository.reservations == []


def test_the_window_cuts_only_before_an_owner_message():
    messages = [item for number in (1, 2, 3) for item in turn(number, 10)]
    assert conversation_window(messages, lambda recent: True) == 0
    assert conversation_window(messages, lambda recent: len(recent) <= 8) == 4
    assert conversation_window(messages, lambda recent: len(recent) <= 5) == 8
    assert conversation_window(messages, lambda recent: False) == 8
    assert conversation_window([AIMessage(content="No owner message")], lambda recent: False) == 0
