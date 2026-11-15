"""Provider failures: what class each one is, which are tried again, and what a failed call leaves behind."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import anthropic
import httpx
import openai
import pytest
from langchain_core.messages import AIMessage
from langgraph.errors import GraphInterrupt

from sabre import claude_runner, codex_runner
from sabre.agents import GuardedCalls
from sabre.claude_model import RUNNER_ERRORS
from sabre.cli_protocol import status_failure
from sabre.codex_model import RUNNER_ERRORS as CODEX_RUNNER_ERRORS
from sabre.codex_model import InvocationRequest
from sabre.models import DomainError
from sabre.provider_failures import (
    MAX_PROVIDER_RETRIES,
    by_status,
    call_with_retries,
    classify,
    failure_code,
    retry_delay,
)
from sabre.security import SecretGuard
from sabre.slack import ChatGuard
from sabre.telemetry import SpanRecorder
from tests.test_agents import Repository, setup
from tests.test_claude import result_bytes
from tests.test_error_boundaries import fixture_config, fixture_request

SECRET = "synthetic-provider-credential-20261114"
REQUEST = httpx.Request("POST", "https://provider.invalid/v1/messages", headers={"Authorization": SECRET})


def response(status: int, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(status, request=REQUEST, headers=headers or {})


def sdk_error(kind, status: int, headers: dict | None = None):
    return kind(SECRET, response=response(status, headers), body=None)


@pytest.mark.parametrize("error, expected", [
    (sdk_error(openai.RateLimitError, 429), "rate_limit"),
    (sdk_error(anthropic.RateLimitError, 429), "rate_limit"),
    (openai.APITimeoutError(request=REQUEST), "timeout"),
    (anthropic.APITimeoutError(request=REQUEST), "timeout"),
    (openai.APIConnectionError(message=SECRET, request=REQUEST), "timeout"),
    (anthropic.APIConnectionError(message=SECRET, request=REQUEST), "timeout"),
    (sdk_error(openai.AuthenticationError, 401), "authentication"),
    (sdk_error(anthropic.PermissionDeniedError, 403), "authentication"),
    (sdk_error(openai.BadRequestError, 400), "invalid_request"),
    (sdk_error(anthropic.NotFoundError, 404), "invalid_request"),
    (sdk_error(openai.InternalServerError, 500), "overloaded"),
    (sdk_error(anthropic.APIStatusError, 529), "overloaded"),
    (httpx.ReadTimeout(SECRET), "timeout"),
    (httpx.ConnectError(SECRET), "timeout"),
    (TimeoutError(), "timeout"),
    (httpx.HTTPStatusError(SECRET, request=REQUEST, response=response(503)), "overloaded"),
    (httpx.HTTPStatusError(SECRET, request=REQUEST, response=response(429)), "rate_limit"),
    # Other SDKs carry the HTTP status as an attribute.
    (type("ClientError", (Exception,), {"code": 429})(), "rate_limit"),
    (type("ServerError", (Exception,), {"status_code": 502})(), "overloaded"),
    (type("Odd", (Exception,), {"code": "E_TEXT"})(), "other"),
    (RuntimeError(SECRET), "other"),
    # The CLI bridges name their own failures.
    (DomainError("CLAUDE_BUSY", "busy", 409), "overloaded"),
    (DomainError("CODEX_RUNNER_UNAVAILABLE", "down", 503), "overloaded"),
    (DomainError("CLAUDE_RATE_LIMITED", "limit", 503), "rate_limit"),
    (DomainError("CODEX_TIMEOUT", "slow", 503), "timeout"),
    (DomainError("CLAUDE_LOGIN_REQUIRED", "login", 503), "authentication"),
    (DomainError("CODEX_INPUT_LIMIT", "large", 413), "invalid_request"),
    (DomainError("CLAUDE_EXECUTION_FAILED", "failed", 503), "other"),
    (DomainError("CLAUDE_ACCESS_DENIED", "refused", 503), "authentication"),
    (DomainError("CLAUDE_REQUEST_REJECTED", "rejected", 503), "invalid_request"),
    (DomainError("CODEX_RATE_LIMITED", "limit", 503), "rate_limit"),
    (DomainError("CODEX_OVERLOADED", "busy", 503), "overloaded"),
    (DomainError("CODEX_ACCESS_DENIED", "refused", 503), "authentication"),
    (DomainError("CODEX_REQUEST_REJECTED", "rejected", 503), "invalid_request"),
    (DomainError("CODEX_PROCESS_FAILED", "failed", 503), "other"),
    # A domain error that is not a provider failure is never worth another call.
    (DomainError("BUDGET_EXHAUSTED", "no budget"), "other"),
    (DomainError("PAUSE_REQUESTED", "pause"), "other"),
])
def test_a_failure_is_classified_by_its_type_status_or_bridge_code_never_by_its_text(error, expected):
    assert classify(error) == expected
    assert SECRET not in failure_code(error, expected)


def raised_from(outer: BaseException, cause: BaseException | None, *, explicit: bool = True) -> BaseException:
    """``outer`` as it is after ``raise outer from cause``, or after being raised while ``cause`` was handled."""
    try:
        try:
            if cause is not None:
                raise cause
        except BaseException:
            if explicit:
                raise outer from cause
            raise outer  # noqa: B904 - the implicit chain is what this builds
    except BaseException as error:
        return error
    return outer


def test_an_exception_without_a_status_is_classed_from_the_one_it_says_it_was_raised_from():
    limit = sdk_error(openai.RateLimitError, 429, {"retry-after": "5"})
    wrapped = raised_from(RuntimeError("an integration's own exception, with no status"), limit)
    assert classify(wrapped) == "rate_limit" and retry_delay(wrapped, 0) == 5.0
    assert SECRET not in failure_code(wrapped, "rate_limit")
    # An exception that says something itself is not asked about its cause.
    assert classify(raised_from(sdk_error(openai.BadRequestError, 400), limit)) == "invalid_request"
    # Only what the integration says it was raised from counts: an exception merely raised while another was handled is not traced.
    assert classify(raised_from(RuntimeError("unrelated"), limit, explicit=False)) == "other"
    # A domain error is the factory's own statement, wherever it was raised, and it also ends a chain.
    assert classify(raised_from(DomainError("PAUSE_REQUESTED", "pause"), limit)) == "other"
    assert classify(raised_from(RuntimeError("outer"), raised_from(DomainError("BUDGET_EXHAUSTED", "no budget"), limit))) == "other"
    # The trace back is bounded.
    chain: BaseException = limit
    for depth in range(3):
        chain = raised_from(RuntimeError(f"wrapper {depth}"), chain)
    assert classify(chain) == "rate_limit"
    assert classify(raised_from(RuntimeError("one wrapper too many"), chain)) == "other"


def test_the_wait_follows_the_providers_retry_after_within_a_bound():
    assert retry_delay(sdk_error(openai.RateLimitError, 429, {"retry-after": "5"}), 0) == 5.0
    assert retry_delay(sdk_error(openai.RateLimitError, 429, {"retry-after": "120"}), 0) == 2.0
    assert retry_delay(sdk_error(openai.RateLimitError, 429, {"retry-after": "soon"}), 1) == 8.0
    assert retry_delay(RuntimeError("no response"), 0) == 2.0 and retry_delay(RuntimeError("no response"), 7) == 8.0


def scripted(*outcomes):
    """A provider call that raises or returns each outcome in turn."""
    remaining = list(outcomes)

    async def call():
        outcome = remaining.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    return call, remaining


async def test_a_retryable_failure_is_tried_again_with_a_bounded_wait_and_then_succeeds():
    call, remaining = scripted(sdk_error(openai.RateLimitError, 429), sdk_error(anthropic.APIStatusError, 529), "answer")
    seen, sleep, before = [], AsyncMock(), AsyncMock()

    async def on_failure(*values):
        seen.append(values)

    assert await call_with_retries(call, on_failure=on_failure, before_retry=before, sleep=sleep) == "answer"
    assert seen == [("rate_limit", "MODEL_RATE_LIMITED", 1, False), ("overloaded", "MODEL_OVERLOADED", 2, False)]
    assert [item.args[0] for item in sleep.await_args_list] == [2.0, 8.0] and before.await_count == 2 and remaining == []


async def test_exhausted_retries_leave_with_the_class_and_without_the_providers_exception():
    failures = [sdk_error(openai.RateLimitError, 429) for _ in range(MAX_PROVIDER_RETRIES + 1)]
    call, remaining = scripted(*failures, "never reached")
    seen, sleep = [], AsyncMock()

    async def on_failure(*values):
        seen.append(values)

    with pytest.raises(DomainError) as caught:
        await call_with_retries(call, on_failure=on_failure, sleep=sleep)
    assert caught.value.code == "MODEL_RATE_LIMITED" and caught.value.status_code == 503
    assert caught.value.__cause__ is None and caught.value.__context__ is None and SECRET not in str(caught.value)
    assert [values[2:] for values in seen] == [(1, False), (2, False), (3, True)]
    assert sleep.await_count == MAX_PROVIDER_RETRIES and remaining == ["never reached"]


@pytest.mark.parametrize("error, code", [(sdk_error(openai.AuthenticationError, 401), "MODEL_AUTHENTICATION_FAILED"),
                                         (sdk_error(anthropic.BadRequestError, 400), "MODEL_REQUEST_INVALID")])
async def test_a_failure_that_another_call_cannot_fix_is_never_retried(error, code):
    call, remaining = scripted(error, "never reached")
    sleep = AsyncMock()
    with pytest.raises(DomainError) as caught:
        await call_with_retries(call, sleep=sleep)
    assert caught.value.code == code and caught.value.__context__ is None
    sleep.assert_not_awaited()
    assert remaining == ["never reached"]


async def test_unclassified_failures_and_bridge_errors_keep_their_own_identity():
    unknown = RuntimeError(SECRET)
    call, _ = scripted(unknown)
    with pytest.raises(RuntimeError) as caught:
        await call_with_retries(call, sleep=AsyncMock())
    # The boundary around the call sanitizes it, as it always did.
    assert caught.value is unknown
    busy = [DomainError("CLAUDE_BUSY", "Claude is already processing another invocation", 409) for _ in range(3)]
    call, _ = scripted(*busy)
    sleep = AsyncMock()
    with pytest.raises(DomainError) as bridge:
        await call_with_retries(call, sleep=sleep)
    assert bridge.value.code == "CLAUDE_BUSY" and sleep.await_count == MAX_PROVIDER_RETRIES
    failed = DomainError("CLAUDE_EXECUTION_FAILED", "Claude reported an invocation failure", 503)
    call, _ = scripted(failed)
    with pytest.raises(DomainError) as other:
        await call_with_retries(call, sleep=sleep)
    assert other.value is failed and sleep.await_count == MAX_PROVIDER_RETRIES


async def test_a_stop_between_attempts_and_graph_control_are_not_swallowed():
    call, remaining = scripted(sdk_error(openai.RateLimitError, 429), "never reached")
    before = AsyncMock(side_effect=DomainError("PAUSE_REQUESTED", "Pause requested"))
    with pytest.raises(DomainError) as paused:
        await call_with_retries(call, before_retry=before, sleep=AsyncMock())
    assert paused.value.code == "PAUSE_REQUESTED" and remaining == ["never reached"]
    interrupt = GraphInterrupt("owner question")
    call, _ = scripted(interrupt)
    failures = AsyncMock()
    with pytest.raises(GraphInterrupt):
        await call_with_retries(call, on_failure=failures, sleep=AsyncMock())
    failures.assert_not_awaited()


def answer():
    return SimpleNamespace(result=[AIMessage(content="Observed", usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})])


async def test_the_agent_loop_retries_inside_one_reservation_and_records_each_failed_call():
    work, _, config = setup()
    repository = Repository()
    middleware = GuardedCalls(repository, config, work, SecretGuard([SECRET]), role="analyst", child_id=f"{work.id}/r1/analyst/{'a' * 64}")
    middleware.sleep = AsyncMock()
    provider = AsyncMock(side_effect=[sdk_error(openai.RateLimitError, 429), sdk_error(anthropic.APIStatusError, 529), answer()])
    result = await middleware.awrap_model_call(fixture_request(), provider)
    assert result.result[0].content == "Observed" and provider.await_count == 3
    # One reservation and one settlement cover the three attempts.
    assert len(repository.reservations) == len(repository.settled) == 1
    events = repository.events
    assert [(event.kind, event.state, event.name, event.error_code) for event in events] == [
        ("model", "failed", "rate limit", "MODEL_RATE_LIMITED"), ("model", "failed", "overloaded", "MODEL_OVERLOADED")]
    assert all(event.work_id == work.id and event.agent_id and event.duration_ms is not None for event in events)
    assert SECRET not in repr([event.model_dump() for event in events])
    assert [item.args[0] for item in middleware.sleep.await_args_list] == [2.0, 8.0]


async def test_the_agent_loop_stops_with_the_class_when_the_provider_keeps_failing_and_on_an_owner_pause():
    work, _, config = setup()
    repository = Repository()
    middleware = GuardedCalls(repository, config, work, SecretGuard([SECRET]))
    middleware.sleep = AsyncMock()
    provider = AsyncMock(side_effect=[sdk_error(openai.InternalServerError, 503) for _ in range(3)])
    with pytest.raises(DomainError) as caught:
        await middleware.awrap_model_call(fixture_request(), provider)
    assert caught.value.code == "MODEL_OVERLOADED" and caught.value.__context__ is None and provider.await_count == 3
    assert len(repository.reservations) == 1 and repository.settled == []
    assert [event.error_code for event in repository.events] == ["MODEL_OVERLOADED"] * 3

    paused = Repository()
    controls = iter([None, "pause"])
    paused.control = AsyncMock(side_effect=lambda work_id: next(controls))
    stopping = GuardedCalls(paused, config, work, SecretGuard([SECRET]))
    stopping.sleep = AsyncMock()
    provider = AsyncMock(side_effect=[sdk_error(openai.RateLimitError, 429), answer()])
    with pytest.raises(DomainError) as stopped:
        await stopping.awrap_model_call(fixture_request(), provider)
    assert stopped.value.code == "PAUSE_REQUESTED" and provider.await_count == 1
    stopping.sleep.assert_not_awaited()


async def test_the_supervisor_conversation_retries_the_same_classes_inside_its_reservation():
    repository = SimpleNamespace(reserve_chat_usage=AsyncMock(return_value="usage"), settle_usage=AsyncMock())
    guard = ChatGuard(repository, fixture_config(), SecretGuard([SECRET]), "fixture-event")
    guard.sleep = AsyncMock()
    provider = AsyncMock(side_effect=[sdk_error(anthropic.RateLimitError, 429, {"retry-after": "3"}), answer()])
    result = await guard.awrap_model_call(fixture_request(), provider)
    assert result.result[0].content == "Observed" and provider.await_count == 2
    repository.reserve_chat_usage.assert_awaited_once()
    guard.sleep.assert_awaited_once_with(3.0)
    failing = AsyncMock(side_effect=[sdk_error(openai.AuthenticationError, 401)])
    with pytest.raises(DomainError) as caught:
        await guard.awrap_model_call(fixture_request(), failing)
    assert caught.value.code == "MODEL_AUTHENTICATION_FAILED" and failing.await_count == 1


@pytest.mark.parametrize("changes, code", [
    ({"is_error": True, "result": "API Error: 529 {\"type\":\"overloaded_error\"}"}, "CLAUDE_OVERLOADED"),
    ({"is_error": True, "result": "API Error: Rate limit reached for requests"}, "CLAUDE_RATE_LIMITED"),
    ({"is_error": True, "result": "Claude usage limit reached. Your limit will reset later."}, "CLAUDE_RATE_LIMITED"),
    ({"is_error": True, "api_error_status": 429}, "CLAUDE_RATE_LIMITED"),
    ({"is_error": True, "api_error_status": 503}, "CLAUDE_OVERLOADED"),
    # The lines the pinned CLI was seen to write for a refused session and a rejected request.
    ({"is_error": True, "api_error_status": 401, "result": "Failed to authenticate. API Error: 401 synthetic"}, "CLAUDE_ACCESS_DENIED"),
    ({"is_error": True, "api_error_status": 403, "result": "Failed to authenticate. API Error: 403 synthetic"}, "CLAUDE_ACCESS_DENIED"),
    ({"is_error": True, "api_error_status": 400, "result": "API Error: 400 synthetic"}, "CLAUDE_REQUEST_REJECTED"),
    ({"is_error": True, "api_error_status": 404}, "CLAUDE_REQUEST_REJECTED"),
    ({"is_error": True, "api_error_status": 408}, "CLAUDE_TIMEOUT"),
    # The status the CLI states decides: words in what the provider said do not override it.
    ({"is_error": True, "api_error_status": 400, "result": "API Error: 400 rate limit 429 overloaded"}, "CLAUDE_REQUEST_REJECTED"),
    # Without a status that is an HTTP failure, the few markers still apply, and nothing else is named.
    ({"is_error": True, "api_error_status": 200, "result": "API Error: usage limit reached"}, "CLAUDE_RATE_LIMITED"),
    ({"is_error": True, "api_error_status": "429"}, "CLAUDE_EXECUTION_FAILED"),
    ({"is_error": True, "api_error_status": True, "result": "API Error: something else"}, "CLAUDE_EXECUTION_FAILED"),
    ({"is_error": True, "result": "The model returned an unexpected message"}, "CLAUDE_EXECUTION_FAILED"),
    ({"is_error": True, "result": ["not", "text"]}, "CLAUDE_EXECUTION_FAILED"),
])
def test_the_claude_runner_names_a_limit_or_an_overload_when_the_cli_result_says_so(changes, code):
    with pytest.raises(DomainError) as error:
        claude_runner.parse_result(result_bytes(**changes))
    assert error.value.code == code and code in RUNNER_ERRORS and RUNNER_ERRORS[code][0] == error.value.status_code
    # The CLI's text is searched, never repeated.
    assert "API Error" not in str(error.value) and "usage limit reached" not in str(error.value)


def failed_turn(message) -> bytes:
    """What the Codex CLI prints for a turn that failed: the error, then the turn's failure with the same message."""
    lines = [{"type": "thread.started", "thread_id": "synthetic"}, {"type": "turn.started"},
             {"type": "error", "message": message}, {"type": "turn.failed", "error": {"message": message}}]
    return b"\n".join(json.dumps(line).encode() for line in lines)


@pytest.mark.parametrize("message, code, failure", [
    # The lines the pinned CLI was seen to write. What a provider says follows the CLI's own beginning.
    ("exceeded retry limit, last status: 429 Too Many Requests", "CODEX_RATE_LIMITED", "rate_limit"),
    ("You\u2019ve hit your usage limit. Try again later.", "CODEX_RATE_LIMITED", "rate_limit"),
    (f"unexpected status 503 Service Unavailable: {SECRET}, url: http://provider.invalid/v1/responses", "CODEX_OVERLOADED", "overloaded"),
    ("We\u2019re currently experiencing high demand, which may cause temporary errors.", "CODEX_OVERLOADED", "overloaded"),
    (f"unexpected status 401 Unauthorized: {SECRET}, url: http://provider.invalid/v1/responses", "CODEX_ACCESS_DENIED", "authentication"),
    (f"unexpected status 403 Forbidden: {SECRET}, url: http://provider.invalid/v1/responses", "CODEX_ACCESS_DENIED", "authentication"),
    (f"unexpected status 404 Not Found: {SECRET}, url: http://provider.invalid/v1/responses", "CODEX_REQUEST_REJECTED", "invalid_request"),
    (f"unexpected status 422 Unprocessable Entity: {SECRET}, url: http://provider.invalid/v1/responses", "CODEX_REQUEST_REJECTED", "invalid_request"),
    (f"unexpected status 408 Request Timeout: {SECRET}", "CODEX_TIMEOUT", "timeout"),
    # A request refused outright arrives as the provider's own error document.
    (json.dumps({"error": {"message": SECRET, "type": "invalid_request_error", "param": "reasoning.effort", "code": "unsupported_value"}}),
     "CODEX_REQUEST_REJECTED", "invalid_request"),
])
async def test_the_codex_runner_names_the_failure_the_cli_reports_for_its_turn(monkeypatch, tmp_path, message, code, failure):
    error = codex_runner.turn_failure(failed_turn(message))
    assert error is not None and error.code == code and classify(error) == failure
    assert code in CODEX_RUNNER_ERRORS and CODEX_RUNNER_ERRORS[code][0] == error.status_code
    # What the provider said is never repeated.
    assert SECRET not in str(error) and SECRET not in error.message
    # The bridge raises it for the call, whatever the process returned.
    tmp_path.chmod(0o700)
    runner = codex_runner.CodexRunner(tmp_path)
    monkeypatch.setattr(runner, "_login_status", AsyncMock(return_value={"authenticated": True}))
    for exit_code in (1, 0):
        monkeypatch.setattr(codex_runner, "capture_process", AsyncMock(return_value=(exit_code, failed_turn(message), b"")))
        with pytest.raises(DomainError) as raised:
            await runner.invoke(InvocationRequest(prompt="fixture"))
        assert raised.value.code == code


@pytest.mark.parametrize("message", [
    "The model returned an unexpected message",
    # Only the beginning counts. Text that merely contains the CLI's words, as a provider's could, names nothing.
    "stream disconnected: exceeded retry limit, last status: 429 Too Many Requests",
    " unexpected status 429 Too Many Requests",
    "Note: You\u2019ve hit your usage limit.",
    "unexpected status 200 OK: ",
    "unexpected status 4290 Too Many Requests",
    json.dumps({"message": "a document without an error object"}),
    json.dumps({"error": "not an object"}),
    "{not json",
    ["not", "text"],
    None,
])
async def test_a_failed_turn_the_codex_bridge_cannot_name_keeps_the_generic_code(monkeypatch, tmp_path, message):
    assert codex_runner.turn_failure(failed_turn(message)) is None
    tmp_path.chmod(0o700)
    runner = codex_runner.CodexRunner(tmp_path)
    monkeypatch.setattr(runner, "_login_status", AsyncMock(return_value={"authenticated": True}))
    monkeypatch.setattr(codex_runner, "capture_process", AsyncMock(return_value=(1, failed_turn(message), b"")))
    with pytest.raises(DomainError) as raised:
        await runner.invoke(InvocationRequest(prompt="fixture"))
    assert raised.value.code == "CODEX_PROCESS_FAILED"


def test_the_bridges_class_a_status_as_the_factory_does_for_any_provider():
    assert all(status_failure(status) == by_status(status) for status in range(400, 600))
    assert status_failure(399) is None and status_failure(200) is None
    # Output that is not the CLI's event lines, and a turn that did not fail, name no failure.
    assert codex_runner.turn_failure(b"not json") is None and codex_runner.turn_failure(b"") is None
    assert codex_runner.turn_failure(b'{"type":"turn.failed"}') is None and codex_runner.turn_failure(b'{"type":"turn.failed","error":"text"}') is None


def test_the_failure_class_and_the_attempts_pass_the_telemetry_allowlist():
    kept = {}
    recorder = SpanRecorder(SimpleNamespace(set_attribute=lambda key, value: kept.__setitem__(key, value)))
    recorder.set(failure_class="rate_limit", provider_attempts=2)
    recorder.set(failure_class="anything else", provider_attempts=-1)
    assert kept == {"sabre.failure_class": "rate_limit", "sabre.provider_attempts": 2}
