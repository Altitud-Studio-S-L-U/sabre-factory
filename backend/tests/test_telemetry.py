import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from sabre.agents import AgentTeam, GuardedCalls
from sabre.models import DomainError, Status
from sabre.security import SecretGuard
from sabre.slack import ChatGuard
from sabre.telemetry import SpanRecorder, span
from sabre.tools import ToolCatalog, ToolDefinition, ToolPolicy
from tests.test_agents import Executor, ScriptedModel
from tests.test_agents import Repository as AgentRepository
from tests.test_agents import setup as agent_fixture
from tests.test_costs import cached_answer, priced
from tests.test_error_boundaries import fixture_config, fixture_request
from tests.test_factory_workflow import build_factory as build_factory
from tests.test_provider_failures import sdk_error


@pytest.fixture
def recorded(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr("sabre.telemetry.trace.get_tracer", lambda _: provider.get_tracer("test"))
    yield exporter
    provider.shutdown()


def test_domain_failures_record_codes_without_exception_content_or_stacks(recorded):
    secret = "synthetic-credential-never-export"
    with pytest.raises(DomainError, match=secret):
        with span("workflow.stage", phase="verification", work_id="fixture-1", prompt=secret) as observation:
            observation.set(response=secret, output_tokens=17, result={}, error_type={}, invocation_kind={}, tokens=float("inf"))
            raise DomainError("SECRET_DETECTED", secret)
    observed = recorded.get_finished_spans()[0]
    assert observed.status.status_code == StatusCode.ERROR
    assert observed.status.description is None
    assert observed.events == ()
    assert observed.attributes["sabre.error_code"] == "SECRET_DETECTED"
    assert observed.attributes["sabre.error_type"] == "DomainError"
    assert observed.attributes["sabre.output_tokens"] == 17
    assert "sabre.tokens" not in observed.attributes
    assert secret not in json.dumps(dict(observed.attributes))


async def test_real_graph_interrupt_is_normal_control_with_stage_spans(recorded, build_factory):
    factory, repo, _, _, _, _ = build_factory(question=True)
    result = await factory.drive(repo.current.id)
    assert result.status == Status.WAITING_INPUT
    stages = [item for item in recorded.get_finished_spans() if item.name == "workflow.stage"]
    interrupted = next(item for item in stages if item.attributes.get("sabre.result") == "interrupted")
    assert interrupted.attributes["sabre.phase"] == "clarify"
    assert interrupted.status.status_code != StatusCode.ERROR
    assert "sabre.error_type" not in interrupted.attributes
    assert interrupted.events == ()


async def test_model_and_tool_spans_have_usage_parentage_and_no_payload(recorded):
    repo = SimpleNamespace(control=AsyncMock(return_value=None), reserve_usage=AsyncMock(return_value="usage-1"), settle_usage=AsyncMock())
    settings = SimpleNamespace(model_max_output_tokens=128, model_input_usd_per_million=1, model_output_usd_per_million=2, monthly_budget_usd=10)
    calls = GuardedCalls(repo, settings, SimpleNamespace(id="fixture-1"), SecretGuard(), role="developer")
    request = SimpleNamespace(messages=[HumanMessage(content="private repository content")], tools=[], response_format=None, system_message=None)
    response = SimpleNamespace(result=[AIMessage(content="private model output", usage_metadata={"input_tokens": 10, "output_tokens": 2, "total_tokens": 12})])
    with span("agent.role", role="developer", work_id="fixture-1"):
        assert await calls.awrap_model_call(request, AsyncMock(return_value=response)) is response
        catalog = ToolCatalog()
        catalog.register(ToolDefinition("read_file", "Read a source file", {"type": "object", "properties": {}}, ToolPolicy(frozenset({"developer"}), "read"), AsyncMock(return_value="private source bytes")))
        assert await catalog.invoke("read_file", {}, "developer") == "private source bytes"
    spans = recorded.get_finished_spans()
    model = next(item for item in spans if item.name == "model.call")
    tool = next(item for item in spans if item.name == "tool.call")
    parent = next(item for item in spans if item.name == "agent.role")
    assert model.parent.span_id == tool.parent.span_id == parent.context.span_id
    assert model.attributes["sabre.input_tokens"] == 10
    assert model.attributes["sabre.output_tokens"] == 2
    assert model.attributes["sabre.tokens"] == 12
    assert model.attributes["sabre.reserved_tokens"] >= 128
    assert model.attributes["sabre.cost_usd"] == pytest.approx(0.000014)
    assert tool.attributes["sabre.tool"] == "read_file"
    assert all(item.end_time >= item.start_time for item in spans)
    assert "private" not in json.dumps([dict(item.attributes) for item in spans])


class UnavailableCollector(SpanExporter):
    def __init__(self):
        self.calls = 0

    def export(self, spans):
        self.calls += 1
        return SpanExportResult.FAILURE


async def test_collector_failure_does_not_change_delivery_verdict(monkeypatch, build_factory):
    collector = UnavailableCollector()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(collector))
    monkeypatch.setattr("sabre.telemetry.trace.get_tracer", lambda _: provider.get_tracer("test"))
    factory, repo, _, executor, _, publisher = build_factory()
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    assert publisher.calls == ["commit", "publish"]
    assert not executor.prepared
    assert collector.calls > 0
    provider.shutdown()


def test_broken_instrumentation_keeps_application_result_and_error(monkeypatch):
    monkeypatch.setattr("sabre.telemetry.trace.get_tracer", Mock(side_effect=RuntimeError("collector unavailable")))
    with span("factory.work", work_id="fixture-1"):
        result = "domain verdict"
    assert result == "domain verdict"
    with pytest.raises(DomainError, match="domain failure"):
        with span("factory.work", work_id="fixture-1"):
            raise DomainError("DOMAIN_FAILED", "domain failure")


def test_factory_failure_mark_survives_normal_context_exit(recorded):
    with span("factory.work", work_id="fixture-1") as observation:
        observation.outcome(DomainError("REPAIR_LIMIT", "private diagnosis"))
    observed = recorded.get_finished_spans()[0]
    assert observed.status.status_code == StatusCode.ERROR
    assert observed.attributes["sabre.result"] == "error"
    assert observed.attributes["sabre.error_code"] == "REPAIR_LIMIT"


async def test_execution_events_link_nested_actions_and_real_trace_ids(recorded):
    from types import SimpleNamespace

    from sabre.execution_observer import current_execution, observe
    events = []

    class Repository:
        async def record_execution_event(self, event):
            events.append(event)

    work = SimpleNamespace(id="synthetic-run", plan_revision=1, phase="implementation")
    with span("agent.role", role="developer"):
        async with observe(Repository(), work, "agent", "developer") as boundary:
            parent = boundary.correlation
            with span("tool.call", tool="read_file"):
                async with observe(Repository(), work, "tool", "read_file"):
                    assert current_execution.get() != parent
    assert current_execution.get() is None
    tools = [event for event in events if event.kind == "tool"]
    assert len(tools) == 2 and all(event.parent_id == parent for event in tools)
    assert all(event.trace_id is not None and event.span_id is not None for event in events)
    assert len({event.trace_id for event in events}) == 1
    assert len({event.span_id for event in events}) == 2


def test_trace_identifier_failure_does_not_change_application_behavior(monkeypatch):
    from sabre.telemetry import trace_identifiers
    monkeypatch.setattr("sabre.telemetry.trace.get_current_span", Mock(side_effect=RuntimeError("unavailable")))
    assert trace_identifiers() == {"trace_id": None, "span_id": None}


def test_every_error_code_the_factory_raises_passes_the_allowlist():
    import re
    from pathlib import Path

    import sabre

    codes = set()
    for source in Path(sabre.__file__).parent.glob("*.py"):
        codes |= set(re.findall(r'DomainError\(\s*"([^"]+)"', source.read_text(encoding="utf-8")))
    assert len(codes) > 200 and "A2A_TASK_PENDING" in codes
    recorder = SpanRecorder()
    for code in codes:
        recorder.set(error_code=code)
    assert recorder.dropped == set(), sorted(code for code in codes if not re.fullmatch(r"[A-Z][A-Z0-9_]{1,79}", code))


def test_the_recorder_remembers_what_it_refused_and_ignores_what_has_no_value():
    recorder = SpanRecorder()
    recorder.set(role=None, model_name="", tokens=3, prompt="private", reserved_usd=float("nan"), failure_class="unheard of")
    assert recorder.dropped == {"prompt", "reserved_usd", "failure_class"}


async def test_nothing_set_along_a_run_a_model_call_or_a_conversation_is_dropped(monkeypatch, recorded, build_factory):
    import openai
    from langchain.agents.middleware.types import ModelRequest
    from langchain_core.messages import SystemMessage

    recorders = []

    class Watched(SpanRecorder):
        def __init__(self, current=None):
            super().__init__(current)
            recorders.append(self)

    monkeypatch.setattr("sabre.telemetry.SpanRecorder", Watched)
    # A whole scripted run and each of its stages, inside the span the worker opens around it.
    factory, repo, *_ = build_factory()
    with span("factory.work", work_id=repo.current.id) as run:
        assert (await factory.drive(repo.current.id)).status == Status.COMPLETED
        run.outcome(DomainError("A2A_TASK_PENDING", ""))
    # The real agent loop: a role, its model calls and its tool calls.
    work, project, config = agent_fixture()
    model = ScriptedModel()
    await AgentTeam(config, AgentRepository(), Executor(), SecretGuard(), model_factory=lambda: model).run("developer", work, project, "Implement the task")
    # A call through a CLI session and one through an API with cache prices, both reporting cached input.
    for provider, name, tokens in (("claude_cli", "claude-opus-5-5", 1_000), ("openai", "fixture-model", 100_000)):
        settings = priced(agent_fixture()[2])
        settings.model_provider, settings.model_name = provider, name
        calls = GuardedCalls(AgentRepository(), settings, work, SecretGuard(), role="analyst", child_id=f"{work.id}/r1/analyst/{'a' * 64}")
        await calls.awrap_model_call(fixture_request(), AsyncMock(return_value=cached_answer(tokens)))
    # A conversation close to its input limit, which carries the pressure notice.
    pressed = agent_fixture()[2]
    pressed.context_input_max_bytes = 20000
    request = ModelRequest(model=ScriptedModel(), messages=[HumanMessage(content="x" * 18000)], system_message=SystemMessage(content="Instructions"))
    await GuardedCalls(AgentRepository(), pressed, work, SecretGuard()).awrap_model_call(request, AsyncMock(return_value=SimpleNamespace(result=[])))
    # A provider that keeps failing, in the agent loop and in the Supervisor's conversation.
    failing = GuardedCalls(AgentRepository(), config, work, SecretGuard(), role="developer")
    failing.sleep = AsyncMock()
    with pytest.raises(DomainError):
        await failing.awrap_model_call(fixture_request(), AsyncMock(side_effect=[sdk_error(openai.RateLimitError, 429) for _ in range(3)]))
    ledger = SimpleNamespace(reserve_chat_usage=AsyncMock(return_value="usage"), settle_usage=AsyncMock())
    chat = ChatGuard(ledger, priced(fixture_config()), SecretGuard(), "fixture-event")
    chat.sleep = AsyncMock()
    await chat.awrap_model_call(fixture_request(), AsyncMock(return_value=cached_answer()))
    with pytest.raises(DomainError):
        await chat.awrap_model_call(fixture_request(), AsyncMock(side_effect=[sdk_error(openai.AuthenticationError, 401)]))

    assert len(recorders) > 10
    assert {name for recorder in recorders for name in recorder.dropped} == set()
    spans = recorded.get_finished_spans()
    assert {"factory.work", "workflow.stage", "agent.role", "model.call", "tool.call"} <= {item.name for item in spans}
    # The CLI call, the API call and the conversation: what each wrote to the cache beside what it read from it.
    cached = sorted((item.attributes["sabre.cache_write_tokens"], item.attributes["sabre.cache_read_tokens"])
                    for item in spans if item.attributes.get("sabre.cache_write_tokens"))
    assert cached == [(200, 600), (20_000, 60_000), (20_000, 60_000)]
    assert {item.attributes.get("sabre.invocation_kind") for item in spans} >= {"cli_invocation", "provider_call"}
    assert sum(item.attributes.get("sabre.context_pressure_notice") is True for item in spans) == 1
    assert {item.attributes.get("sabre.failure_class") for item in spans} >= {"rate_limit", "authentication"}
    assert "private" not in json.dumps([dict(item.attributes) for item in spans])
