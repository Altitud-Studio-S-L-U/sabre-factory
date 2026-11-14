"""Provider failures: what class each one is, which are tried again, and what a failed call leaves behind."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import anthropic
import httpx
import openai
import pytest
from langchain_core.messages import AIMessage
from langgraph.errors import GraphInterrupt

from sabre import claude_runner
from sabre.agents import GuardedCalls
from sabre.claude_model import RUNNER_ERRORS
from sabre.models import DomainError
from sabre.provider_failures import (
    MAX_PROVIDER_RETRIES,
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
    # A domain error that is not a provider failure is never worth another call.
    (DomainError("BUDGET_EXHAUSTED", "no budget"), "other"),
    (DomainError("PAUSE_REQUESTED", "pause"), "other"),
])
def test_a_failure_is_classified_by_its_type_status_or_bridge_code_never_by_its_text(error, expected):
    assert classify(error) == expected
    assert SECRET not in failure_code(error, expected)


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
    ({"is_error": True, "result": "The model returned an unexpected message"}, "CLAUDE_EXECUTION_FAILED"),
    ({"is_error": True, "result": ["not", "text"]}, "CLAUDE_EXECUTION_FAILED"),
])
def test_the_claude_runner_names_a_limit_or_an_overload_when_the_cli_result_says_so(changes, code):
    with pytest.raises(DomainError) as error:
        claude_runner.parse_result(result_bytes(**changes))
    assert error.value.code == code and code in RUNNER_ERRORS and RUNNER_ERRORS[code][0] == error.value.status_code
    # The CLI's text is searched, never repeated.
    assert "API Error" not in str(error.value) and "usage limit reached" not in str(error.value)


def test_the_failure_class_and_the_attempts_pass_the_telemetry_allowlist():
    kept = {}
    recorder = SpanRecorder(SimpleNamespace(set_attribute=lambda key, value: kept.__setitem__(key, value)))
    recorder.set(failure_class="rate_limit", provider_attempts=2)
    recorder.set(failure_class="anything else", provider_attempts=-1)
    assert kept == {"sabre.failure_class": "rate_limit", "sabre.provider_attempts": 2}
