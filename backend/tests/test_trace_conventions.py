"""Spans in the standard GenAI vocabulary beside the factory's own, continuity between executions and executor commands."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import openai
import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, SystemMessage
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode

from sabre import executor
from sabre.agents import AgentTeam, GuardedCalls
from sabre.artifacts import ArtifactStore
from sabre.context_archive import ContextArchive
from sabre.executor import ExecutionResult, ExecutorClient
from sabre.models import DomainError
from sabre.security import SecretGuard
from sabre.telemetry import (
    GENAI_ATTRIBUTES,
    GENAI_CONVENTIONS,
    GENAI_OPERATIONS,
    GENAI_PROVIDERS,
    execution_span,
    span,
    trace_identifiers,
    traceparent,
)
from sabre.tools import ToolCatalog, ToolDefinition, ToolPolicy
from tests.test_agents import Executor, ScriptedModel
from tests.test_agents import Repository as AgentRepository
from tests.test_agents import setup as agent_fixture
from tests.test_context_archive import long_history
from tests.test_costs import cached_answer, priced
from tests.test_error_boundaries import fixture_request
from tests.test_provider_failures import sdk_error

STANDARD = ("sabre.", "gen_ai.", "error.type", "process.exit.code")


@pytest.fixture
def recorded(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr("sabre.telemetry.trace.get_tracer", lambda _: provider.get_tracer("test"))
    yield exporter
    provider.shutdown()


def test_the_names_are_those_of_the_pinned_commit_of_the_conventions():
    # Changing any of these is a decision about the conventions' version, never a rename in passing.
    assert GENAI_CONVENTIONS == "open-telemetry/semantic-conventions-genai@e6658f14c9d9ea0760825f029cb82e7673f48fab"
    assert GENAI_OPERATIONS == {"factory.work": "invoke_workflow", "agent.role": "invoke_agent", "model.call": "chat",
                                "tool.call": "execute_tool"}
    assert GENAI_ATTRIBUTES["model.call"] == {
        "work_id": "gen_ai.conversation.id", "model_provider": "gen_ai.provider.name", "model_name": "gen_ai.request.model",
        "max_output_tokens": "gen_ai.request.max_tokens", "input_tokens": "gen_ai.usage.input_tokens",
        "output_tokens": "gen_ai.usage.output_tokens", "cache_read_tokens": "gen_ai.usage.cache_read.input_tokens",
        "cache_write_tokens": "gen_ai.usage.cache_write.input_tokens", "context_compacted": "gen_ai.conversation.compacted"}
    assert GENAI_ATTRIBUTES["tool.call"] == {"work_id": "gen_ai.conversation.id", "tool": "gen_ai.tool.name",
                                             "tool_call_id": "gen_ai.tool.call.id", "role": "gen_ai.agent.name"}
    assert GENAI_ATTRIBUTES["agent.role"] == {"work_id": "gen_ai.conversation.id", "role": "gen_ai.agent.name",
                                              "model_provider": "gen_ai.provider.name"}
    assert GENAI_ATTRIBUTES["executor.command"] == {"exit_code": "process.exit.code"}
    assert "workflow.stage" not in GENAI_ATTRIBUTES
    # A CLI session reaches its vendor's models; an endpoint the operator configured keeps the factory's name.
    assert GENAI_PROVIDERS == {"openai": "openai", "codex_cli": "openai", "anthropic": "anthropic", "claude_cli": "anthropic",
                               "google": "gcp.gemini", "local": "local"}


async def test_a_run_writes_both_vocabularies_on_its_spans_and_no_content(recorded):
    work, project, config = agent_fixture()
    config.model_provider, config.model_name = "openai", "fixture-model"
    model = ScriptedModel()
    with span("factory.work", work_id=work.id):
        await AgentTeam(config, AgentRepository(), Executor(), SecretGuard(), model_factory=lambda: model).run("developer", work, project, "Implement the private task")
        settings = priced(agent_fixture()[2])
        settings.model_provider, settings.model_name = "claude_cli", "claude-opus-5-5"
        cached = GuardedCalls(AgentRepository(), settings, work, SecretGuard(), role="analyst")
        await cached.awrap_model_call(fixture_request(), AsyncMock(return_value=cached_answer(1_000)))
    spans = recorded.get_finished_spans()
    run = next(item for item in spans if item.name == "factory.work")
    assert run.attributes["gen_ai.operation.name"] == "invoke_workflow" and run.attributes["gen_ai.conversation.id"] == work.id
    agent = next(item for item in spans if item.name == "agent.role")
    assert (agent.attributes["gen_ai.operation.name"], agent.attributes["gen_ai.agent.name"], agent.attributes["gen_ai.provider.name"]) == (
        "invoke_agent", "developer", "openai")
    assert agent.attributes["sabre.role"] == "developer" and agent.kind == SpanKind.INTERNAL

    tool = next(item for item in spans if item.name == "tool.call")
    assert tool.attributes["gen_ai.operation.name"] == "execute_tool"
    assert (tool.attributes["gen_ai.tool.name"], tool.attributes["sabre.tool"]) == ("write_file", "write_file")
    # The identifier the model gave the call, and the run as the conversation.
    assert tool.attributes["gen_ai.tool.call.id"] == "write-app" and tool.attributes["sabre.tool_call_id"] == "write-app"
    assert tool.attributes["gen_ai.conversation.id"] == work.id and tool.attributes["gen_ai.agent.name"] == "developer"
    assert tool.parent.span_id == agent.context.span_id

    calls = [item for item in spans if item.name == "model.call"]
    plain = next(item for item in calls if item.attributes["gen_ai.request.model"] == "fixture-model")
    assert plain.kind == SpanKind.CLIENT
    assert (plain.attributes["gen_ai.operation.name"], plain.attributes["gen_ai.provider.name"]) == ("chat", "openai")
    assert (plain.attributes["gen_ai.usage.input_tokens"], plain.attributes["gen_ai.usage.output_tokens"]) == (10, 20)
    assert (plain.attributes["sabre.input_tokens"], plain.attributes["sabre.output_tokens"]) == (10, 20)
    assert plain.attributes["gen_ai.request.max_tokens"] == plain.attributes["sabre.max_output_tokens"] == 100
    # The convention records cached tokens only when there were some; the factory's own name keeps the zero.
    assert plain.attributes["sabre.cache_read_tokens"] == 0
    assert "gen_ai.usage.cache_read.input_tokens" not in plain.attributes and "gen_ai.usage.cache_write.input_tokens" not in plain.attributes
    assert "gen_ai.conversation.compacted" not in plain.attributes

    session = next(item for item in calls if item.attributes["gen_ai.request.model"] == "claude-opus-5-5")
    # A CLI session is named by the vendor it reaches; cached input is part of the input, as the convention asks.
    assert (session.attributes["gen_ai.provider.name"], session.attributes["sabre.model_provider"]) == ("anthropic", "claude_cli")
    assert session.attributes["gen_ai.usage.input_tokens"] == 1_000
    assert session.attributes["gen_ai.usage.cache_read.input_tokens"] == 600
    assert session.attributes["gen_ai.usage.cache_write.input_tokens"] == 200
    assert session.attributes["gen_ai.conversation.id"] == work.id

    assert all(key.startswith(STANDARD) for item in spans for key in item.attributes), sorted(
        {key for item in spans for key in item.attributes if not key.startswith(STANDARD)})
    exported = json.dumps([dict(item.attributes) for item in spans])
    assert "private" not in exported and "print(" not in exported and "app.py" not in exported


async def test_a_request_that_carries_a_compacted_view_says_so(recorded, tmp_path):
    work, _, config = agent_fixture()
    config.context_input_max_bytes = 40000
    config.context_archive_enabled, config.context_dedup_enabled, config.context_dedup_keep_model_turns = True, True, 2
    guard = SecretGuard()
    store = ArtifactStore(tmp_path, guard)
    request = ModelRequest(model=ScriptedModel(), messages=long_history(), system_message=SystemMessage(content="Instructions"))
    middleware = GuardedCalls(AgentRepository(), config, work, guard, artifacts=store, context_archive=ContextArchive(store, guard))
    await middleware.awrap_model_call(request, AsyncMock(return_value=SimpleNamespace(result=[])))
    observed = recorded.get_finished_spans()[0]
    assert observed.attributes["gen_ai.conversation.compacted"] is True and observed.attributes["sabre.context_compacted"] is True
    assert observed.attributes["sabre.context_compacted_results"] > 0


async def test_a_failed_span_names_the_class_of_its_error_in_the_standard_attribute(recorded):
    work, _, config = agent_fixture()
    failing = GuardedCalls(AgentRepository(), config, work, SecretGuard(), role="developer")
    failing.sleep = AsyncMock()
    with pytest.raises(DomainError):
        await failing.awrap_model_call(fixture_request(), AsyncMock(side_effect=[sdk_error(openai.RateLimitError, 429) for _ in range(3)]))
    limited = recorded.get_finished_spans()[0]
    assert limited.status.status_code == StatusCode.ERROR
    assert (limited.attributes["error.type"], limited.attributes["sabre.error_code"]) == ("MODEL_RATE_LIMITED", "MODEL_RATE_LIMITED")
    assert limited.attributes["sabre.failure_class"] == "rate_limit"
    recorded.clear()

    class Unlisted(Exception):
        pass

    for error, expected in ((RuntimeError("private text"), "RuntimeError"), (Unlisted("private text"), "_OTHER")):
        with pytest.raises(type(error)):
            with span("tool.call", tool="read_file"):
                raise error
        assert recorded.get_finished_spans()[-1].attributes["error.type"] == expected
    # An owner pause is control flow, not an error.
    with pytest.raises(DomainError):
        with span("workflow.stage", phase="analysis"):
            raise DomainError("PAUSE_REQUESTED", "Pause requested")
    paused = recorded.get_finished_spans()[-1]
    assert "error.type" not in paused.attributes and paused.attributes["sabre.result"] == "interrupted"
    assert "private" not in json.dumps([dict(item.attributes) for item in recorded.get_finished_spans()])


async def test_an_external_tool_is_named_only_when_the_owner_reviewed_it(recorded):
    catalog = ToolCatalog()
    policy = ToolPolicy(frozenset({"developer"}), "read")
    schema = {"type": "object", "properties": {}}
    catalog.register(ToolDefinition("docs__search", "Search", schema, policy, AsyncMock(return_value="found"), reviewed=True))
    catalog.register(ToolDefinition("lookup_customer", "Lookup", schema, policy, AsyncMock(return_value="found")))
    catalog.register(ToolDefinition("docs__odd name", "Odd", schema, policy, AsyncMock(return_value="found"), reviewed=True))
    for name in ("docs__search", "lookup_customer", "docs__odd name"):
        await catalog.invoke(name, {}, "developer")
    names = [(item.attributes["sabre.tool"], item.attributes["gen_ai.tool.name"]) for item in recorded.get_finished_spans()]
    # Reviewed by name; never reviewed; reviewed, but not a plain identifier.
    assert names == [("docs__search", "docs__search"), ("mcp", "mcp"), ("mcp", "mcp")]
    # Outside a model's tool call there is no call identifier and no run to name.
    assert all("gen_ai.tool.call.id" not in item.attributes and "gen_ai.conversation.id" not in item.attributes
               for item in recorded.get_finished_spans())


class Traces:
    """A repository that keeps the root span of each run's latest execution."""

    def __init__(self, broken=False):
        self.roots, self.broken = {}, broken

    async def trace_root(self, work_id):
        if self.broken:
            raise RuntimeError("database unavailable")
        return self.roots.get(work_id)

    async def remember_trace_root(self, work_id, identifiers):
        if self.broken:
            raise RuntimeError("database unavailable")
        self.roots[work_id] = identifiers


async def test_each_execution_of_a_run_links_to_the_root_span_of_the_one_before(recorded):
    repository = Traces()
    async with execution_span(repository, "run-1"):
        first = trace_identifiers()
    async with execution_span(repository, "run-1"):
        second = trace_identifiers()
    async with execution_span(repository, "run-2"):
        pass
    one, two, other = recorded.get_finished_spans()
    assert one.links == () and other.links == ()
    # A new execution is a new trace that points at the previous one.
    assert first["trace_id"] != second["trace_id"]
    assert [(f"{link.context.trace_id:032x}", f"{link.context.span_id:016x}") for link in two.links] == [
        (first["trace_id"], first["span_id"])]
    assert repository.roots["run-1"] == second and two.attributes["gen_ai.conversation.id"] == "run-1"


async def test_continuity_is_diagnostics_and_never_decides_an_execution(recorded):
    # A repository that cannot read or keep the root changes nothing.
    async with execution_span(Traces(broken=True), "run-1") as observation:
        observation.set(work_id="run-1")
    assert recorded.get_finished_spans()[0].links == ()
    # A stored root that is not a pair of identifiers is ignored.
    for stored in ({"trace_id": "zz", "span_id": "1"}, {"trace_id": "0" * 32, "span_id": "0" * 16}, "text", {"trace_id": None}):
        repository = Traces()
        repository.roots["run-1"] = stored
        async with execution_span(repository, "run-1"):
            pass
        assert recorded.get_finished_spans()[-1].links == ()
    # The failure of the execution itself still leaves through the span.
    with pytest.raises(DomainError):
        async with execution_span(Traces(), "run-1"):
            raise DomainError("REPAIR_LIMIT", "private diagnosis")
    assert recorded.get_finished_spans()[-1].attributes["error.type"] == "REPAIR_LIMIT"


async def test_without_a_tracer_nothing_is_kept_and_nothing_is_sent():
    repository = Traces()
    async with execution_span(repository, "run-1"):
        assert traceparent() is None
    assert repository.roots == {}


async def test_the_executor_client_sends_the_trace_context_of_the_span_it_runs_under(recorded):
    seen = []

    async def handle(request):
        seen.append(request.headers.get("traceparent"))
        return httpx.Response(200, json={"exit_code": 0, "output": "ok"})

    client = ExecutorClient("http://executor", "synthetic-broker-token", httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    await client.execute("work-1", ["python", "-V"])
    with span("tool.call", tool="execute"):
        current = trace_identifiers()
        await client.execute("work-1", ["python", "-V"])
    await client.aclose()
    assert seen == [None, f"00-{current['trace_id']}-{current['span_id']}-01"]


@pytest.fixture
def broker(monkeypatch):
    fake = SimpleNamespace(execute=AsyncMock(return_value=ExecutionResult(exit_code=3, output="private output of the command")),
                           execute_gate=AsyncMock(return_value=ExecutionResult(exit_code=0, output="ok")))
    monkeypatch.setattr(executor, "get_broker", lambda: fake)
    # No exporter is configured for the test: the recording tracer above receives the spans.
    monkeypatch.setattr(executor, "_telemetry", False)
    executor.app.dependency_overrides[executor.authenticate] = lambda: None
    yield fake
    executor.app.dependency_overrides.clear()


async def test_the_broker_records_one_span_per_command_under_the_callers_span(recorded, broker):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(executor.app), base_url="http://executor") as client:
        with span("tool.call", tool="execute"):
            caller = trace_identifiers()
            response = await client.post("/workspaces/work-1/execute", json={"argv": ["python", "private-script.py"], "timeout_s": 30},
                                         headers={"traceparent": traceparent()})
        assert response.status_code == 200 and response.json()["exit_code"] == 3
        gate = await client.post("/workspaces/work-1/gate", json={"argv": ["python", "-m", "unittest"], "digest": "a" * 64})
        assert gate.status_code == 200
        malformed = await client.post("/workspaces/work-1/execute", json={"argv": ["python", "-V"]}, headers={"traceparent": "not-a-context"})
        assert malformed.status_code == 200
    commands = [item for item in recorded.get_finished_spans() if item.name == "executor.command"]
    assert len(commands) == 3
    continued, alone, ignored = commands
    assert f"{continued.context.trace_id:032x}" == caller["trace_id"] and f"{continued.parent.span_id:016x}" == caller["span_id"]
    # How it ended and how much it printed, in the factory's names and the process convention; never what it printed.
    assert (continued.attributes["sabre.exit_code"], continued.attributes["process.exit.code"]) == (3, 3)
    assert continued.attributes["sabre.output_bytes"] == len("private output of the command")
    assert continued.attributes["sabre.work_id"] == "work-1" and "gen_ai.operation.name" not in continued.attributes
    # Without a context, or with one that is not well-formed, the command starts its own trace.
    assert alone.parent is None and ignored.parent is None
    exported = json.dumps([dict(item.attributes) for item in commands])
    assert "private" not in exported and "python" not in exported


async def test_a_command_the_broker_could_not_run_ends_its_span_in_error(recorded, broker):
    broker.execute.side_effect = DomainError("EXECUTION_LIMIT", "The command exceeded its limit", 409)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(executor.app), base_url="http://executor") as client:
        response = await client.post("/workspaces/work-1/execute", json={"argv": ["python", "-V"]})
    assert response.status_code == 409
    failed = recorded.get_finished_spans()[0]
    assert failed.status.status_code == StatusCode.ERROR and failed.attributes["error.type"] == "EXECUTION_LIMIT"
    assert "sabre.exit_code" not in failed.attributes


def answer():
    return SimpleNamespace(result=[AIMessage(content="Observed", usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})])


async def test_the_supervisors_call_carries_the_model_it_used(recorded):
    from sabre.slack import ChatGuard
    from tests.test_error_boundaries import fixture_config

    config = fixture_config()
    config.model_provider, config.model_name = "anthropic", "fixture-model"
    ledger = SimpleNamespace(reserve_chat_usage=AsyncMock(return_value="usage"), settle_usage=AsyncMock())
    await ChatGuard(ledger, config, SecretGuard(), "fixture-event").awrap_model_call(fixture_request(), AsyncMock(return_value=answer()))
    call = recorded.get_finished_spans()[0]
    assert (call.attributes["gen_ai.operation.name"], call.attributes["gen_ai.provider.name"], call.attributes["gen_ai.request.model"]) == (
        "chat", "anthropic", "fixture-model")
    assert call.attributes["gen_ai.request.max_tokens"] == 128 and call.kind == SpanKind.CLIENT
    # The conversation with the Supervisor is not a run, so no conversation is named.
    assert "gen_ai.conversation.id" not in call.attributes


def test_the_viewer_address_is_an_http_template_that_names_the_trace():
    from pydantic import ValidationError

    from tests.test_credentials import config

    assert config().trace_viewer_url is None and config(trace_viewer_url="").trace_viewer_url is None
    template = "http://127.0.0.1:16686/trace/{trace_id}"
    assert config(trace_viewer_url=template).trace_viewer_url == template
    for invalid in ("http://127.0.0.1:16686/trace", "ftp://viewer.example/{trace_id}", "https://user:secret@viewer.example/{trace_id}",
                    "/trace/{trace_id}"):
        with pytest.raises(ValidationError):
            config(trace_viewer_url=invalid)
