"""What leaves the process as telemetry is what the factory wrote, in every application it serves."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic import SecretStr

from sabre import claude_runner, codex_runner, executor, telemetry
from sabre.api import create_app
from sabre.security import SecretGuard

CANARY = "synthetic-query-canary"


def recording():
    exporter, provider = InMemorySpanExporter(), TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return exporter, provider


def test_the_factory_keeps_its_tracer_provider_to_itself(monkeypatch):
    monkeypatch.setattr("opentelemetry.exporter.otlp.proto.http.trace_exporter.OTLPSpanExporter.export",
                        lambda self, spans: SpanExportResult.SUCCESS)
    monkeypatch.setattr(telemetry, "_provider", None)
    before = trace.get_tracer_provider()
    provider = telemetry.configure("http://127.0.0.1:9/v1/traces")
    try:
        exporter = InMemorySpanExporter()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        # Exporting does not make the factory's provider the one every library in the process writes to.
        assert trace.get_tracer_provider() is before and trace.get_tracer_provider() is not provider
        with telemetry.span("factory.work", work_id="synthetic-work"):
            # A library that instruments itself asks the process for a tracer. Its span goes nowhere.
            trace.get_tracer("some.library").start_span(f"GET /tools?code={CANARY}").end()
        assert [span.name for span in exporter.get_finished_spans()] == ["factory.work"]
        assert CANARY not in str([dict(span.attributes) for span in exporter.get_finished_spans()])
    finally:
        provider.shutdown()


def test_without_an_endpoint_nothing_is_configured_and_spans_cost_nothing(monkeypatch):
    monkeypatch.setattr(telemetry, "_provider", None)
    assert telemetry.configure(None) is None and telemetry._provider is None
    with telemetry.span("factory.work", work_id="synthetic-work") as recorder:
        assert recorder is not None


@pytest.fixture
def token_file(tmp_path):
    file = tmp_path / "token"
    file.write_text("synthetic-bridge-token-long-enough-for-testing")
    file.chmod(0o400)
    return file


def applications(token_file):
    runner = SimpleNamespace(invoke=AsyncMock(), status=AsyncMock(return_value={"authenticated": False}))
    config = SimpleNamespace(auth_token=SecretStr("synthetic-owner-authentication"), allowed_origins=["http://localhost:8000"])
    return {
        "api": lambda: create_app(SimpleNamespace(guard=SecretGuard()), config),
        "executor": lambda: executor.app,
        "claude runner": lambda: claude_runner.create_app(runner, token_file),
        "codex runner": lambda: codex_runner.create_app(runner, token_file),
    }


@pytest.mark.parametrize("name", ["api", "executor", "claude runner", "codex runner"])
async def test_no_application_lets_the_framework_trace_a_request_even_with_a_process_wide_tracer(name, token_file, monkeypatch):
    # The case that leaked: something in the process registered a recording provider, and the
    # framework wrote a span per request to it, with the path and the query string.
    exporter, provider = recording()
    monkeypatch.setattr("opentelemetry.trace.get_tracer_provider", lambda: provider)
    app = applications(token_file)[name]()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        await client.get("/health")
        await client.get(f"/tools?github=registered&code={CANARY}&state={CANARY}")
        await client.post(f"/not-a-route?secret={CANARY}", json={"value": CANARY})
    provider.force_flush()
    assert [span.name for span in exporter.get_finished_spans()] == []


async def test_the_framework_would_trace_those_requests_if_it_were_left_on(monkeypatch):
    """The check above is not empty: the same requests on an application without the setting are traced, query included."""
    from fastapi import FastAPI

    exporter, provider = recording()
    monkeypatch.setattr("opentelemetry.trace.get_tracer_provider", lambda: provider)
    app = FastAPI()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        await client.get(f"/tools?github=registered&code={CANARY}")
    provider.force_flush()
    spans = exporter.get_finished_spans()
    assert spans and CANARY in str([dict(span.attributes) for span in spans])
