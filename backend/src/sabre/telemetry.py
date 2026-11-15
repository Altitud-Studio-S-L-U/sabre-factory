import re
from contextlib import asynccontextmanager, contextmanager, suppress
from contextvars import ContextVar
from math import isfinite
from typing import TypedDict

from langgraph.errors import GraphBubbleUp
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Link, NonRecordingSpan, SpanContext, SpanKind, Status, StatusCode, TraceFlags

from sabre.models import DomainError

SPAN_NAMES = {"factory.work", "workflow.stage", "agent.role", "tool.call", "model.call", "executor.command"}
IDENTIFIERS = {"work_id", "role", "phase", "tool", "model_provider", "model_name", "tool_call_id"}
FAILURE_CLASSES = {"rate_limit", "overloaded", "timeout", "authentication", "invalid_request", "other"}
NUMBERS = {"attempt", "provider_attempts", "tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
           "cost_usd", "reported_usd", "reserved_tokens", "reserved_usd", "max_output_tokens", "exit_code", "output_bytes",
           "context_original_bytes", "context_sent_bytes", "context_dedup_results", "context_compacted_results",
           "context_request_original_bytes", "context_request_sent_bytes"}
# Recorded only when true: their absence says nothing happened.
FLAGS = {"context_pressure_notice", "context_compacted"}
ERROR_TYPES = {"DomainError", "ValueError", "TypeError", "RuntimeError", "TimeoutError", "CancelledError",
               "HTTPStatusError", "ConnectError", "ReadTimeout", "WriteTimeout", "PoolTimeout",
               "APIConnectionError", "APITimeoutError", "RateLimitError", "AuthenticationError",
               "PermissionDeniedError", "InternalServerError", "BadRequestError"}
ERROR_CODE = re.compile(r"[A-Z][A-Z0-9_]{1,79}")

# The OpenTelemetry GenAI semantic conventions, written beside the factory's own names so a viewer
# that understands them needs no mapping. They are still in development, so every name here is
# pinned to one commit of their repository, and a test holds the names.
GENAI_CONVENTIONS = "open-telemetry/semantic-conventions-genai@e6658f14c9d9ea0760825f029cb82e7673f48fab"
GENAI_OPERATIONS = {"factory.work": "invoke_workflow", "agent.role": "invoke_agent", "model.call": "chat", "tool.call": "execute_tool"}
CONVERSATION = {"work_id": "gen_ai.conversation.id"}
GENAI_ATTRIBUTES: dict[str, dict[str, str]] = {
    "factory.work": CONVERSATION,
    "agent.role": CONVERSATION | {"role": "gen_ai.agent.name", "model_provider": "gen_ai.provider.name"},
    "model.call": CONVERSATION | {
        "model_provider": "gen_ai.provider.name", "model_name": "gen_ai.request.model",
        "max_output_tokens": "gen_ai.request.max_tokens",
        "input_tokens": "gen_ai.usage.input_tokens", "output_tokens": "gen_ai.usage.output_tokens",
        "cache_read_tokens": "gen_ai.usage.cache_read.input_tokens",
        "cache_write_tokens": "gen_ai.usage.cache_write.input_tokens",
        "context_compacted": "gen_ai.conversation.compacted"},
    "tool.call": CONVERSATION | {"tool": "gen_ai.tool.name", "tool_call_id": "gen_ai.tool.call.id", "role": "gen_ai.agent.name"},
    # A command is a process, not a model operation: it carries the process convention only.
    "executor.command": {"exit_code": "process.exit.code"},
}
# The convention's well-known provider names. A CLI session reaches its vendor's models; an endpoint
# the operator configured has no well-known name, so it keeps the factory's.
GENAI_PROVIDERS = {"openai": "openai", "codex_cli": "openai", "anthropic": "anthropic", "claude_cli": "anthropic",
                   "google": "gcp.gemini", "local": "local"}
# The convention records these two only when they are not zero.
NONZERO_ONLY = {"gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_write.input_tokens"}
# A model call leaves the process; everything else runs inside it.
SPAN_KINDS = {"model.call": SpanKind.CLIENT}

TRACEPARENT = re.compile(r"00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]")
TOOL_CALL_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
# The identifier the model or its provider gave the tool call being executed, when it is a plain token.
tool_call: ContextVar[str | None] = ContextVar("sabre_tool_call", default=None)


class TraceIdentifiers(TypedDict):
    trace_id: str | None
    span_id: str | None


def trace_identifiers() -> TraceIdentifiers:
    with suppress(Exception):
        context = trace.get_current_span().get_span_context()
        if context.is_valid:
            return {"trace_id": f"{context.trace_id:032x}", "span_id": f"{context.span_id:016x}"}
    return {"trace_id": None, "span_id": None}


def traceparent() -> str | None:
    """The current span as a W3C traceparent value, for a service that continues the trace."""
    current = trace_identifiers()
    return f"00-{current['trace_id']}-{current['span_id']}-01" if current["trace_id"] and current["span_id"] else None


def remote_context(trace_id, span_id) -> SpanContext | None:
    """A span recorded elsewhere, from its identifiers; None unless both are well-formed and not zero."""
    if not (isinstance(trace_id, str) and isinstance(span_id, str)
            and re.fullmatch(r"[0-9a-f]{32}", trace_id) and re.fullmatch(r"[0-9a-f]{16}", span_id)):
        return None
    context = SpanContext(int(trace_id, 16), int(span_id, 16), is_remote=True, trace_flags=TraceFlags(TraceFlags.SAMPLED))
    return context if context.is_valid else None


# The factory's own tracer provider, when traces are exported. It is deliberately not the process-wide
# one: a library that instruments itself against the global provider exports through whatever is
# registered there. FastAPI does, and its request spans carry the query string of every request and
# one trace per health check. What leaves this process is the closed set of spans written here.
_provider: TracerProvider | None = None


def configure(endpoint: str | None):
    global _provider
    if not endpoint:
        return None
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    try:
        provider = TracerProvider(resource=Resource.create({"service.name": "sabre"}))
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, timeout=3)))
        _provider = provider
        return provider
    except Exception:
        # Diagnostics must not change work admission or execution outcomes.
        return None


def tracer():
    """The tracer the factory's spans are written with: its own provider's, or the no-op one without an endpoint."""
    return _provider.get_tracer("sabre") if _provider is not None else trace.get_tracer("sabre")


class SpanRecorder:
    """Keep diagnostics failures and exception text outside the domain result."""

    def __init__(self, current=None, name: str | None = None):
        self.current = current
        self.name = name
        self.failed = False
        self.dropped: set[str] = set()

    def _write(self, key: str, value):
        if self.current is not None:
            with suppress(Exception):
                self.current.set_attribute(key, value)

    def set(self, **attributes):
        for key, value in attributes.items():
            if value is None or value == "":
                # Nothing to record: an attribute without a value was not dropped.
                continue
            allowed = key in IDENTIFIERS and isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_/:.-]{1,200}", value) is not None
            allowed = allowed or key in NUMBERS and isinstance(value, int | float) and 0 <= value <= 10**15 and isfinite(value)
            allowed = allowed or key == "result" and isinstance(value, str) and value in {"success", "error", "interrupted"}
            allowed = allowed or key == "invocation_kind" and isinstance(value, str) and value in {"cli_invocation", "provider_call"}
            allowed = allowed or key == "failure_class" and isinstance(value, str) and value in FAILURE_CLASSES
            allowed = allowed or key in FLAGS and value is True
            allowed = allowed or key == "error_type" and isinstance(value, str) and value in ERROR_TYPES | {"Exception"}
            allowed = allowed or key == "error_code" and isinstance(value, str) and ERROR_CODE.fullmatch(value) is not None
            if not allowed:
                # Nothing is recorded, and nothing is lost silently: a test fails on any name left here.
                self.dropped.add(key)
                continue
            self._write(f"sabre.{key}", value)
            standard = GENAI_ATTRIBUTES.get(self.name or "", {}).get(key)
            if standard == "gen_ai.provider.name":
                # A provider the convention has no name for keeps the factory's identifier.
                self._write(standard, GENAI_PROVIDERS.get(value, value))
            elif standard and not (standard in NONZERO_ONLY and value == 0):
                self._write(standard, value)

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
            code = error.code if isinstance(error, DomainError) and isinstance(error.code, str) and ERROR_CODE.fullmatch(error.code) else None
            if isinstance(error, DomainError):
                self.set(error_code=error.code)
            # The convention's own attribute: the factory's code when there is one, else the class of the exception.
            self._write("error.type", code or (name if name in ERROR_TYPES else "_OTHER"))
        if self.current is not None:
            with suppress(Exception):
                self.current.set_status(Status(StatusCode.ERROR if error else StatusCode.OK))


@contextmanager
def span(name, *, link: dict | None = None, parent: str | None = None, **attributes):
    """Open a span of the closed set.

    ``link`` names a span of an earlier trace this one continues ({"trace_id", "span_id"}).
    ``parent`` is a W3C traceparent received from the service that started the trace.
    Neither changes anything when it is absent or malformed.
    """
    current, scope, entered = None, None, False
    known = name if name in SPAN_NAMES else "sabre.operation"
    with suppress(Exception):
        linked = remote_context(link.get("trace_id"), link.get("span_id")) if isinstance(link, dict) else None
        match = TRACEPARENT.fullmatch(parent) if isinstance(parent, str) else None
        upstream = remote_context(match.group(1), match.group(2)) if match else None
        current = tracer().start_span(
            known, kind=SPAN_KINDS.get(known, SpanKind.INTERNAL),
            context=trace.set_span_in_context(NonRecordingSpan(upstream)) if upstream else None,
            links=[Link(linked)] if linked else None)
        scope = trace.use_span(current, end_on_exit=False, record_exception=False, set_status_on_exception=False)
        scope.__enter__()
        entered = True
    recorder = SpanRecorder(current, known)
    if known in GENAI_OPERATIONS:
        recorder._write("gen_ai.operation.name", GENAI_OPERATIONS[known])
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


@asynccontextmanager
async def execution_span(repository, work_id: str):
    """The span of one execution of a run, linked to the root span of the execution before it.

    A paused or blocked run continues in a new execution, which is a new trace. The link is what
    lets a viewer walk from one to the next. Reading and keeping the root is diagnostics: a
    repository that cannot do either changes nothing about the execution.
    """
    previous = None
    with suppress(Exception):
        previous = await repository.trace_root(work_id)
    with span("factory.work", work_id=work_id, link=previous) as observation:
        root = trace_identifiers()
        if root["trace_id"]:
            with suppress(Exception):
                await repository.remember_trace_root(work_id, dict(root))
        yield observation
