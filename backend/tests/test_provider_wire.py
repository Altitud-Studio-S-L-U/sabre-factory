"""The pinned provider integrations over HTTP, against a local stand-in.

No provider is reached: the stand-in answers on the loopback interface with each provider's own
shapes. What is checked is what the factory does with the real integrations' own exceptions and
usage, which a hand-built exception or a mocked response cannot show.
"""

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

from sabre import model_providers
from sabre.costs import cache_tokens, cache_write_tokens
from sabre.model_providers import chat_model
from sabre.provider_failures import call_with_retries, classify, failure_code, retry_delay
from sabre.settings import Settings

PROVIDERS = ["openai", "local", "anthropic", "google"]
PROVIDER_TEXT = "SYNTHETIC_PROVIDER_TEXT"
MESSAGES = [SystemMessage(content="synthetic instructions"), HumanMessage(content="synthetic question")]
# One answer of each provider, with a usage that says 60 tokens were read from its cache.
ANSWERS = {
    "openai": {"id": "resp_1", "object": "response", "created_at": 0, "status": "completed", "model": "gpt-fixture",
               "output": [{"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                           "content": [{"type": "output_text", "text": "synthetic answer", "annotations": []}]}],
               "usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120, "input_tokens_details": {"cached_tokens": 60},
                         "output_tokens_details": {"reasoning_tokens": 0}}},
    "local": {"id": "c1", "object": "chat.completion", "created": 0, "model": "fixture",
              "choices": [{"index": 0, "message": {"role": "assistant", "content": "synthetic answer"}, "finish_reason": "stop"}],
              "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120, "prompt_tokens_details": {"cached_tokens": 60}}},
    "anthropic": {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-fixture", "content": [{"type": "text", "text": "synthetic answer"}],
                  "stop_reason": "end_turn", "stop_sequence": None,
                  "usage": {"input_tokens": 40, "output_tokens": 20, "cache_read_input_tokens": 60, "cache_creation_input_tokens": 30}},
    "google": {"candidates": [{"content": {"role": "model", "parts": [{"text": "synthetic answer"}]}, "finishReason": "STOP", "index": 0}],
               "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "totalTokenCount": 120, "cachedContentTokenCount": 60},
               "modelVersion": "gemini-fixture"},
}
PATHS = {"openai": "/v1/responses", "local": "/v1/chat/completions", "anthropic": "/v1/messages",
         "google": "/v1beta/models/gemini-fixture:generateContent"}
FAILURES = [(429, "rate_limit"), (500, "overloaded"), (503, "overloaded"), (529, "overloaded"), (401, "authentication"),
            (403, "authentication"), (400, "invalid_request"), (404, "invalid_request")]


def refusal(provider: str, status: int) -> dict:
    """The body each provider sends with a refusal. Its text is the provider's and must stay out of what the factory records."""
    if provider == "anthropic":
        kind = {429: "rate_limit_error", 529: "overloaded_error", 401: "authentication_error", 403: "permission_error",
                400: "invalid_request_error", 404: "not_found_error"}.get(status, "api_error")
        return {"type": "error", "error": {"type": kind, "message": PROVIDER_TEXT}}
    if provider == "google":
        return {"error": {"code": status, "message": PROVIDER_TEXT, "status": "RESOURCE_EXHAUSTED" if status == 429 else "UNAVAILABLE"}}
    return {"error": {"message": PROVIDER_TEXT, "type": "server_error", "param": None, "code": None}}


@contextmanager
def stand_in(provider: str, plan: list):
    """A server that answers the provider's requests as the plan says, one entry per request and the last one for the rest.

    An entry is a status, or a status with headers; 200 is the provider's answer.
    """
    seen: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            seen.append(self.path)
            step = plan[min(len(seen) - 1, len(plan) - 1)]
            status, headers = (step, {}) if isinstance(step, int) else step
            payload = json.dumps(ANSWERS[provider] if status == 200 else refusal(provider, status)).encode()
            self.send_response(status)
            for key, value in {"Content-Type": "application/json", "Content-Length": str(len(payload)), **headers}.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", seen
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def model_for(monkeypatch, provider: str, base: str):
    """The model the factory builds for a provider, with that provider's fixed destination replaced by the stand-in."""
    monkeypatch.setattr(model_providers, "OPENAI_BASE_URL", base + "/v1")
    monkeypatch.setattr(model_providers, "ANTHROPIC_BASE_URL", base)
    monkeypatch.setattr(model_providers, "GOOGLE_BASE_URL", base)
    values = {"database_url": "postgresql://synthetic", "auth_token": "synthetic-auth-token-123456",
              "executor_token": "synthetic-executor-token-123456", "model_provider": provider,
              "model_name": {"openai": "gpt-fixture", "local": "fixture", "anthropic": "claude-fixture", "google": "gemini-fixture"}[provider],
              "model_api_key": "synthetic-provider-key-123456", "monthly_budget_usd": 10,
              "model_input_usd_per_million": 1, "model_output_usd_per_million": 2, "model_max_output_tokens": 128}
    if provider == "local":
        values["model_base_url"] = base + "/v1"
    return chat_model(Settings(**values))


@pytest.mark.parametrize("provider", PROVIDERS)
@pytest.mark.parametrize("status, expected", FAILURES)
async def test_a_refusal_is_classed_from_what_the_pinned_integration_raises(monkeypatch, provider, status, expected):
    with stand_in(provider, [status]) as (base, seen):
        with pytest.raises(Exception) as raised:  # noqa: PT011 - each integration raises its own type; the class is what is checked
            await model_for(monkeypatch, provider, base).ainvoke(MESSAGES)
    assert classify(raised.value) == expected
    # The integration asks once and at the provider's own path: the factory's retry is the only one.
    assert seen == [PATHS[provider]]
    # The exception carries what the provider said; the code the factory records for it does not.
    assert PROVIDER_TEXT in str(raised.value) and PROVIDER_TEXT not in failure_code(raised.value, expected)


@pytest.mark.parametrize("provider", PROVIDERS)
async def test_the_wait_a_provider_asks_for_is_read_from_the_pinned_integrations_exception(monkeypatch, provider):
    with stand_in(provider, [(429, {"retry-after": "3"})]) as (base, _):
        with pytest.raises(Exception) as raised:  # noqa: PT011
            await model_for(monkeypatch, provider, base).ainvoke(MESSAGES)
    assert classify(raised.value) == "rate_limit" and retry_delay(raised.value, 0) == 3.0


@pytest.mark.parametrize("provider", PROVIDERS)
async def test_a_call_is_tried_again_through_a_limit_and_an_overload_and_then_answers(monkeypatch, provider):
    waits: list[float] = []
    failures: list[tuple] = []

    async def wait(seconds):
        waits.append(seconds)

    async def failed(failure, code, attempt, final):
        failures.append((failure, code, attempt, final))

    with stand_in(provider, [(429, {"retry-after": "1"}), 503, 200]) as (base, seen):
        model = model_for(monkeypatch, provider, base)
        message = await call_with_retries(lambda: model.ainvoke(MESSAGES), on_failure=failed, sleep=wait)
    assert seen == [PATHS[provider]] * 3
    assert failures == [("rate_limit", "MODEL_RATE_LIMITED", 1, False), ("overloaded", "MODEL_OVERLOADED", 2, False)]
    # The first wait is the provider's own, the second the fixed step.
    assert waits == [1.0, 8.0]
    assert "synthetic answer" in json.dumps(message.content)


@pytest.mark.parametrize("provider, total_input, written", [("openai", 100, 0), ("local", 100, 0), ("anthropic", 130, 30), ("google", 100, 0)])
async def test_what_a_provider_reports_as_read_from_its_cache_reaches_the_usage_the_ledger_reads(monkeypatch, provider, total_input, written):
    with stand_in(provider, [200]) as (base, seen):
        message = await model_for(monkeypatch, provider, base).ainvoke(MESSAGES)
    usage = message.usage_metadata
    assert seen == [PATHS[provider]]
    # Cached input is part of the input the integration reports, and is also named on its own.
    assert (usage["input_tokens"], usage["output_tokens"]) == (total_input, 20)
    assert cache_tokens(usage, "cache_read") == 60 and cache_write_tokens(usage) == written
