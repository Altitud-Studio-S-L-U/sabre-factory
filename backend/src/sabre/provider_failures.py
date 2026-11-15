"""What kind of failure a model call met, and whether calling again is worth it.

A failed call is classified from its exception type, HTTP status or bridge code, never from its
message. A rate limit, an overloaded provider and a timeout are retried a bounded number of times
inside the reservation the call already holds; everything else stops as before. Once retries are
exhausted the failure leaves with a code that names its class, so a run does not end on a generic
provider error and the stage is not run again by the graph's own retry on top of these.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, Literal

import anthropic
import httpx
import openai
from langgraph.errors import GraphBubbleUp

from sabre.models import DomainError

FailureClass = Literal["rate_limit", "overloaded", "timeout", "authentication", "invalid_request", "other"]
RETRYABLE: frozenset[str] = frozenset({"rate_limit", "overloaded", "timeout"})
MAX_PROVIDER_RETRIES = 2
RETRY_DELAYS_S = (2.0, 8.0)
MAX_RETRY_AFTER_S = 30.0

# Codes of the CLI bridges, without their CLAUDE_ or CODEX_ prefix. A code that is not listed is "other".
BRIDGE_CLASSES: dict[str, FailureClass] = {
    "BUSY": "overloaded", "RUNNER_UNAVAILABLE": "overloaded", "PROCESS_UNAVAILABLE": "overloaded", "OVERLOADED": "overloaded",
    "TIMEOUT": "timeout", "RATE_LIMITED": "rate_limit",
    "LOGIN_REQUIRED": "authentication", "HOME_INVALID": "authentication", "POLICY_UNSUPPORTED": "authentication",
    "BRIDGE_CONFIGURATION": "authentication", "ACCESS_DENIED": "authentication",
    "INPUT_LIMIT": "invalid_request", "INPUT_INVALID": "invalid_request", "UNSUPPORTED_OPTION": "invalid_request",
    "REQUEST_REJECTED": "invalid_request",
}
# What a failure of an API provider is called once it leaves the call. "other" keeps the boundary's generic code.
FINAL_ERRORS: dict[str, tuple[str, str]] = {
    "rate_limit": ("MODEL_RATE_LIMITED", "The model provider is limiting requests; wait before resuming"),
    "overloaded": ("MODEL_OVERLOADED", "The model provider is overloaded; resume later"),
    "timeout": ("MODEL_TIMEOUT", "The model provider did not answer in time; resume later"),
    "authentication": ("MODEL_AUTHENTICATION_FAILED", "The model provider rejected the credential; review it before resuming"),
    "invalid_request": ("MODEL_REQUEST_INVALID", "The model provider rejected the request; review the model configuration"),
}
LABELS: dict[str, str] = {"rate_limit": "rate limit", "overloaded": "overloaded", "timeout": "timeout",
                          "authentication": "authentication", "invalid_request": "invalid request", "other": "other"}


def by_status(status: int) -> FailureClass:
    if status == 429:
        return "rate_limit"
    if status in (401, 403):
        return "authentication"
    if status == 408:
        return "timeout"
    if status >= 500:
        return "overloaded"
    if 400 <= status < 500:
        return "invalid_request"
    return "other"


def classify(error: BaseException) -> FailureClass:
    if isinstance(error, DomainError):
        for prefix in ("CLAUDE_", "CODEX_"):
            if isinstance(error.code, str) and error.code.startswith(prefix):
                return BRIDGE_CLASSES.get(error.code[len(prefix):], "other")
        return "other"
    for sdk in (openai, anthropic):
        if isinstance(error, sdk.RateLimitError):
            return "rate_limit"
        # A timeout is a connection error in both SDKs; either way no answer arrived.
        if isinstance(error, sdk.APIConnectionError):
            return "timeout"
        if isinstance(error, sdk.APIStatusError):
            return by_status(error.status_code)
    if isinstance(error, (TimeoutError, httpx.TimeoutException, httpx.NetworkError)):
        return "timeout"
    if isinstance(error, httpx.HTTPStatusError):
        return by_status(error.response.status_code)
    # Other SDKs (Google GenAI among them) carry the HTTP status as an integer attribute.
    for name in ("status_code", "code"):
        status = getattr(error, name, None)
        if type(status) is int and 400 <= status <= 599:
            return by_status(status)
    return "other"


def failure_code(error: BaseException, failure: str) -> str:
    """A code safe to record: the bridge's own, or the one of the class. Never text from the provider."""
    if isinstance(error, DomainError) and isinstance(error.code, str) and error.code.isascii() and error.code.replace("_", "").isalnum():
        return error.code[:80]
    return FINAL_ERRORS.get(failure, ("MODEL_PROVIDER_FAILED", ""))[0]


def retry_delay(error: BaseException, attempt: int) -> float:
    """The provider's own Retry-After when it sends one within the bound, else a fixed step."""
    headers = getattr(getattr(error, "response", None), "headers", None)
    try:
        requested = float(headers.get("retry-after")) if headers is not None and headers.get("retry-after") is not None else None
    except (TypeError, ValueError):
        requested = None
    if requested is not None and 0 <= requested <= MAX_RETRY_AFTER_S:
        return requested
    return RETRY_DELAYS_S[min(attempt, len(RETRY_DELAYS_S) - 1)]


async def call_with_retries[T](call: Callable[[], Awaitable[T]], *,
                               on_failure: Callable[[str, str, int, bool], Awaitable[None]] | None = None,
                               before_retry: Callable[[], Awaitable[None]] | None = None,
                               sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> T:
    """Run ``call``; on a retryable failure wait and run it again, at most MAX_PROVIDER_RETRIES times.

    ``on_failure(class, code, attempt, final)`` is told about every failed attempt. ``before_retry`` may
    raise to stop instead of calling again (an owner pause, a revoked credential). Nothing here reserves
    budget: the retries belong to the reservation the caller already holds.
    """
    attempt = 0
    while True:
        pending: BaseException
        mapped: DomainError | None = None
        delay = 0.0
        try:
            return await call()
        except GraphBubbleUp:
            raise
        except Exception as error:
            failure = classify(error)
            final = failure not in RETRYABLE or attempt >= MAX_PROVIDER_RETRIES
            if on_failure is not None:
                await on_failure(failure, failure_code(error, failure), attempt + 1, final)
            pending = error
            if final and not isinstance(error, DomainError) and failure in FINAL_ERRORS:
                code, message = FINAL_ERRORS[failure]
                mapped = DomainError(code, message, 503)
            delay = retry_delay(error, attempt)
        # Left the handler: nothing raised from here carries the provider's exception as its context.
        if mapped is not None:
            raise mapped from None
        if final:
            raise pending
        attempt += 1
        if before_retry is not None:
            await before_retry()
        await sleep(delay)
