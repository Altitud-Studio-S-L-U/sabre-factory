"""Sanitize dependency failures before LangGraph can persist their messages."""

import re
from collections.abc import Awaitable, Callable
from typing import Any

import anthropic
import httpx
import openai
from langgraph.errors import GraphBubbleUp

from sabre.models import DomainError


def safe_exception(error: Exception, guard, failure_code: str) -> Exception:
    if isinstance(error, DomainError):
        try:
            guard.check({"code": error.code, "message": error.message, "budget_denial": error.budget_denial})
        except DomainError:
            return DomainError("SECRET_DETECTED", "An error containing a possible credential was blocked", 422)
        if isinstance(error.code, str) and isinstance(error.message, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{1,79}", error.code):
            status = error.status_code if isinstance(error.status_code, int) and 400 <= error.status_code <= 599 else 503
            return DomainError(error.code, error.message, status, budget_denial=error.budget_denial)
    if isinstance(error, (TimeoutError, httpx.TimeoutException, openai.APITimeoutError, anthropic.APITimeoutError)):
        return httpx.ReadTimeout("The operation response timed out")
    if isinstance(error, (httpx.NetworkError, openai.APIConnectionError, anthropic.APIConnectionError)):
        return httpx.ConnectError("Could not connect to the operation service")
    return DomainError(failure_code, "The operation failed; review configuration and state before resuming", 503)


async def guarded_call[T](operation: Callable[..., Awaitable[T]], guard, failure_code: str, *args: Any, **kwargs: Any) -> T:
    failure: Exception
    try:
        return await operation(*args, **kwargs)
    except GraphBubbleUp:
        raise
    except Exception as error:
        failure = safe_exception(error, guard, failure_code)
    # Raise after leaving the original exception handler: no raw context/cause is retained.
    raise failure from None
