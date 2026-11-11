import re
from contextlib import contextmanager, suppress
from math import isfinite
from typing import TypedDict

from langgraph.errors import GraphBubbleUp
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Status, StatusCode

from sabre.models import DomainError

SPAN_NAMES = {"factory.work", "workflow.stage", "agent.role", "tool.call", "model.call"}
IDENTIFIERS = {"work_id", "role", "phase", "tool", "model_provider", "model_name"}
NUMBERS = {"attempt", "tokens", "input_tokens", "output_tokens", "cost_usd", "reserved_tokens", "reserved_usd",
           "context_original_bytes", "context_sent_bytes", "context_dedup_results", "context_compacted_results",
           "context_request_original_bytes", "context_request_sent_bytes"}
ERROR_TYPES = {"DomainError", "ValueError", "TypeError", "RuntimeError", "TimeoutError", "CancelledError",
               "HTTPStatusError", "ConnectError", "ReadTimeout", "WriteTimeout", "PoolTimeout",
               "APIConnectionError", "APITimeoutError", "RateLimitError", "AuthenticationError",
               "PermissionDeniedError", "InternalServerError", "BadRequestError"}


class TraceIdentifiers(TypedDict):
    trace_id: str | None
    span_id: str | None


def trace_identifiers() -> TraceIdentifiers:
    with suppress(Exception):
        context = trace.get_current_span().get_span_context()
        if context.is_valid:
            return {"trace_id": f"{context.trace_id:032x}", "span_id": f"{context.span_id:016x}"}
    return {"trace_id": None, "span_id": None}


def configure(endpoint: str | None):
    if not endpoint:
        return None
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    try:
        provider = TracerProvider(resource=Resource.create({"service.name": "sabre"}))
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, timeout=3)))
        trace.set_tracer_provider(provider)
        return provider
    except Exception:
        # Diagnostics must not change work admission or execution outcomes.
        return None


class SpanRecorder:
    """Keep diagnostics failures and exception text outside the domain result."""

    def __init__(self, current=None):
        self.current = current
        self.failed = False

    def set(self, **attributes):
        for key, value in attributes.items():
            allowed = key in IDENTIFIERS and isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_/:.-]{1,200}", value) is not None
            allowed = allowed or key in NUMBERS and isinstance(value, int | float) and 0 <= value <= 10**15 and isfinite(value)
            allowed = allowed or key == "result" and isinstance(value, str) and value in {"success", "error", "interrupted"}
            allowed = allowed or key == "invocation_kind" and isinstance(value, str) and value in {"cli_invocation", "provider_call"}
            allowed = allowed or key == "error_type" and isinstance(value, str) and value in ERROR_TYPES | {"Exception"}
            allowed = allowed or key == "error_code" and isinstance(value, str) and re.fullmatch(r"[A-Z][A-Z_]{1,79}", value) is not None
            if allowed and self.current is not None:
                with suppress(Exception):
                    self.current.set_attribute(f"sabre.{key}", value)

    def outcome(self, error=None):
        if self.failed and error is None:
            return
        if isinstance(error, GraphBubbleUp) or isinstance(error, DomainError) and error.code in {"PAUSE_REQUESTED", "CANCEL_REQUESTED"}:
            self.set(result="interrupted")
            return
        self.failed = self.failed or error is not None
        self.set(result="error" if error else "success")
        if error:
            name = type(error).__name__
            self.set(error_type=name if name in ERROR_TYPES else "Exception")
            if isinstance(error, DomainError):
                self.set(error_code=error.code)
        if self.current is not None:
            with suppress(Exception):
                self.current.set_status(Status(StatusCode.ERROR if error else StatusCode.OK))


@contextmanager
def span(name, **attributes):
    current, scope, entered = None, None, False
    with suppress(Exception):
        current = trace.get_tracer("sabre").start_span(name if name in SPAN_NAMES else "sabre.operation")
        scope = trace.use_span(current, end_on_exit=False, record_exception=False, set_status_on_exception=False)
        scope.__enter__()
        entered = True
    recorder = SpanRecorder(current)
    recorder.set(**attributes)
    try:
        yield recorder
    except BaseException as error:
        recorder.outcome(error)
        raise
    else:
        recorder.outcome()
    finally:
        if entered and scope is not None:
            with suppress(Exception):
                scope.__exit__(None, None, None)
        if current is not None:
            with suppress(Exception):
                current.end()
