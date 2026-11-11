import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from sabre.agents import GuardedCalls
from sabre.models import DomainError, Status
from sabre.security import SecretGuard
from sabre.telemetry import span
from sabre.tools import ToolCatalog, ToolDefinition, ToolPolicy
from tests.test_factory_workflow import build_factory as build_factory


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
        async with observe(Repository(), work, "agent", "developer") as parent:
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
