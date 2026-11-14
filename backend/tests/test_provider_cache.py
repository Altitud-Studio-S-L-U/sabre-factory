"""Provider prompt caching: which requests are marked, where, and that the marks come after the reservation and the guard."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool

from sabre.agents import GuardedCalls, provider_cache_middleware
from sabre.security import SecretGuard
from tests.test_agents import Repository, ScriptedModel, setup

MARK = {"type": "ephemeral", "ttl": "5m"}


async def read_file(path: str) -> str:
    """Read a source file."""
    return path


def tools():
    return [StructuredTool.from_function(coroutine=read_file, name="read_file", description="Read a source file",
                                         args_schema={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
            StructuredTool.from_function(coroutine=read_file, name="list_files", description="List files",
                                         args_schema={"type": "object", "properties": {}})]


def conversation():
    return [HumanMessage(content="Audit the repository"),
            AIMessage(content="", tool_calls=[{"name": "read_file", "args": {"path": "a.py"}, "id": "toolu_01", "type": "tool_call"}]),
            ToolMessage(content="print('a')", tool_call_id="toolu_01")]


def anthropic_request():
    model = ChatAnthropic(model="claude-opus-5-5", api_key="synthetic-key-never-sent", max_tokens=1024)
    return ModelRequest(model=model, messages=conversation(), system_message=SystemMessage(content="You are a specialist."), tools=tools())


@pytest.mark.parametrize("provider", ["openai", "google", "local", "claude_cli", "codex_cli", None])
def test_only_the_anthropic_api_needs_its_requests_marked(provider):
    # OpenAI and Gemini cache a stable prefix on their own, and a CLI session manages its cache itself.
    assert provider_cache_middleware(SimpleNamespace(model_provider=provider)) == []
    assert provider_cache_middleware(SimpleNamespace()) == []
    assert len(provider_cache_middleware(SimpleNamespace(model_provider="anthropic"))) == 1


async def test_an_anthropic_request_is_marked_after_the_tools_the_instructions_and_the_conversation():
    (cache,) = provider_cache_middleware(SimpleNamespace(model_provider="anthropic"))
    sent = AsyncMock(return_value=SimpleNamespace(result=[]))
    await cache.awrap_model_call(anthropic_request(), sent)
    request = sent.await_args.args[0]
    # What the integration turns that request into on the wire, without sending anything.
    bound = request.model.bind_tools(request.tools, **request.model_settings)
    payload = bound.bound._get_request_payload([request.system_message, *request.messages], **bound.kwargs)
    # The end of the tool definitions and the end of the instructions: the prefix that never changes within a step.
    assert [tool.get("cache_control") for tool in payload["tools"]] == [None, MARK]
    assert payload["system"] == [{"type": "text", "text": "You are a specialist.", "cache_control": MARK}]
    # The end of the conversation is marked by the request itself, so each call reads what the previous one wrote.
    assert payload["cache_control"] == MARK
    # The conversation's content is untouched.
    assert [message["role"] for message in payload["messages"]] == ["user", "assistant", "user"]
    assert all("cache_control" not in block for message in payload["messages"] for block in message["content"] if isinstance(block, dict))


async def test_a_model_that_is_not_anthropic_is_sent_as_it_was():
    (cache,) = provider_cache_middleware(SimpleNamespace(model_provider="anthropic"))
    original = ModelRequest(model=ScriptedModel(), messages=conversation(), system_message=SystemMessage(content="Instructions"), tools=tools())
    sent = AsyncMock(return_value=SimpleNamespace(result=[]))
    await cache.awrap_model_call(original, sent)
    assert sent.await_args.args[0] is original


async def test_the_marks_are_added_after_the_reservation_and_the_guard_measured_the_request():
    work, _, config = setup()
    config.model_provider, config.model_name = "anthropic", "claude-opus-5-5"
    repository = Repository()
    guarded = GuardedCalls(repository, config, work, SecretGuard())
    (cache,) = provider_cache_middleware(config)
    reached = []

    async def model(request):
        reached.append(request)
        return SimpleNamespace(result=[AIMessage(content="Observed", usage_metadata={
            "input_tokens": 1000, "output_tokens": 40, "total_tokens": 1040,
            "input_token_details": {"cache_read": 600, "cache_creation": 0, "ephemeral_5m_input_tokens": 200}})])

    original = anthropic_request()
    await guarded.awrap_model_call(original, lambda request: cache.awrap_model_call(request, model))
    (request,) = reached
    # The model received the marked request; what the factory wrote, measured and reserved for carried no mark.
    assert request.model_settings == {"cache_control": MARK} and request.system_message.content[0]["cache_control"] == MARK
    assert original.model_settings == {} and original.system_message.content == "You are a specialist."
    assert len(repository.reservations) == 1
    # What the provider then reports about its cache reaches the ledger.
    assert repository.breakdowns == [{"input_tokens": 1000, "output_tokens": 40, "cache_read_tokens": 600, "cache_write_tokens": 200}]
