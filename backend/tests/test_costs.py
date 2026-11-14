"""What a model call costs once cached input has its own prices, and what the ledger keeps of it."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import openai
import pytest
from langchain_core.messages import AIMessage

from sabre.agents import GuardedCalls
from sabre.costs import Rates, cache_tokens, cache_write_tokens, call_cost_usd, reserved_cost_usd
from sabre.models import DomainError
from sabre.security import SecretGuard
from sabre.slack import ChatGuard
from tests.test_agents import Repository, setup
from tests.test_error_boundaries import fixture_config, fixture_request
from tests.test_provider_failures import sdk_error

# A worked example with round prices per million tokens: input 3.00, output 15.00, cache read 0.30, cache write 3.75.
RATES = Rates(input=3.0, output=15.0, cache_read=0.30, cache_write=3.75)


def test_a_call_is_charged_at_the_price_of_each_kind_of_token():
    # 100,000 input tokens, of which 60,000 were read from the cache and 20,000 written to it, and 4,000 of output:
    # fresh 20,000 x 3.00 = 0.060; read 60,000 x 0.30 = 0.018; written 20,000 x 3.75 = 0.075; output 4,000 x 15.00 = 0.060.
    cost = call_cost_usd(RATES, input_tokens=100_000, output_tokens=4_000, cache_read_tokens=60_000, cache_write_tokens=20_000)
    assert cost == pytest.approx(0.213)
    # Priced as the ledger did before, with every input token as fresh input, the same call read 0.36.
    assert call_cost_usd(Rates(3.0, 15.0), input_tokens=100_000, output_tokens=4_000,
                         cache_read_tokens=60_000, cache_write_tokens=20_000) == pytest.approx(0.36)


def test_a_kind_without_its_own_price_is_charged_as_input():
    rates = Rates(input=2.0, output=8.0, cache_read=0.5)
    cost = call_cost_usd(rates, input_tokens=1_000_000, output_tokens=0, cache_read_tokens=400_000, cache_write_tokens=100_000)
    assert cost == pytest.approx(0.5 * 2.0 + 0.4 * 0.5 + 0.1 * 2.0)


def test_more_cached_tokens_than_input_never_turn_into_a_refund():
    cost = call_cost_usd(Rates(1.0, 1.0, 0.1, 2.0), input_tokens=10, output_tokens=0, cache_read_tokens=30)
    assert cost == pytest.approx(30 * 0.1 / 1_000_000)


def test_the_reservation_covers_the_dearest_way_the_input_can_be_charged():
    reserved = reserved_cost_usd(RATES, input_tokens=100_000, output_tokens=4_000)
    assert reserved == pytest.approx(100_000 * 3.75 / 1_000_000 + 4_000 * 15 / 1_000_000)
    for read, written in ((0, 0), (60_000, 20_000), (0, 100_000), (100_000, 0)):
        settled = call_cost_usd(RATES, input_tokens=100_000, output_tokens=4_000, cache_read_tokens=read, cache_write_tokens=written)
        assert settled <= reserved + 1e-12
    # With no cache price the reservation is what it always was.
    assert reserved_cost_usd(Rates(3.0, 15.0), input_tokens=100_000, output_tokens=4_000) == pytest.approx(0.36)


def test_rates_come_from_the_selection_and_a_cli_session_has_no_price_per_token():
    settings = SimpleNamespace(model_input_usd_per_million=3.0, model_output_usd_per_million=15.0,
                               model_cache_read_usd_per_million=0.3, model_cache_write_usd_per_million=None)
    assert Rates.of(settings) == Rates(3.0, 15.0, 0.3, None)
    assert Rates.of(settings, free=True) == Rates(0.0, 0.0, 0.0, 0.0)
    # Settings from before these prices existed, and test doubles that answer any attribute, carry no cache price.
    assert Rates.of(SimpleNamespace(model_input_usd_per_million=1, model_output_usd_per_million=2)) == Rates(1, 2, None, None)
    assert Rates.of(Mock(model_input_usd_per_million=1, model_output_usd_per_million=2)) == Rates(1, 2, None, None)
    odd = SimpleNamespace(model_input_usd_per_million=1, model_output_usd_per_million=2, model_cache_read_usd_per_million=True)
    assert Rates.of(odd).cache_read is None


@pytest.mark.parametrize("usage, kind, expected", [
    ({"input_token_details": {"cache_read": 7, "cache_creation": 3}}, "cache_read", 7),
    ({"input_token_details": {"cache_read": 7, "cache_creation": 3}}, "cache_creation", 3),
    ({"input_token_details": {"cache_read": 7}}, "cache_creation", 0),
    ({}, "cache_read", 0),
    ({"input_token_details": None}, "cache_read", 0),
    ({"input_token_details": "text"}, "cache_read", 0),
    ({"input_token_details": {"cache_read": -1}}, "cache_read", 0),
    ({"input_token_details": {"cache_read": True}}, "cache_read", 0),
    ({"input_token_details": {"cache_read": 1.5}}, "cache_read", 0),
])
def test_a_cached_count_is_read_only_when_the_provider_reports_a_whole_number(usage, kind, expected):
    assert cache_tokens(usage, kind) == expected


@pytest.mark.parametrize("details, expected", [
    ({"cache_creation": 40}, 40),
    # Split by lifetime, the generic key is zeroed by the integration; the writes are still counted once.
    ({"cache_creation": 0, "ephemeral_5m_input_tokens": 25, "ephemeral_1h_input_tokens": 15}, 40),
    ({"cache_creation": 40, "ephemeral_5m_input_tokens": 25, "ephemeral_1h_input_tokens": 15}, 40),
    ({"cache_read": 9}, 0),
])
def test_tokens_written_to_the_cache_are_counted_once_however_they_are_reported(details, expected):
    assert cache_write_tokens({"input_token_details": details}) == expected


def cached_answer(input_tokens=100_000):
    """An answer whose input was 60% read from the cache and 20% written to it, as the worked example above."""
    output = input_tokens // 25
    usage = {"input_tokens": input_tokens, "output_tokens": output, "total_tokens": input_tokens + output,
             "input_token_details": {"cache_read": input_tokens * 6 // 10, "cache_creation": 0, "ephemeral_5m_input_tokens": input_tokens // 5}}
    return SimpleNamespace(result=[AIMessage(content="Observed", usage_metadata=usage)])


def priced(config):
    config.model_input_usd_per_million, config.model_output_usd_per_million = 3.0, 15.0
    config.model_cache_read_usd_per_million, config.model_cache_write_usd_per_million = 0.30, 3.75
    config.model_max_output_tokens = 4096
    return config


async def test_the_agent_loop_settles_a_cached_call_at_cache_prices_and_keeps_the_written_tokens():
    work, _, config = setup()
    repository = Repository()
    middleware = GuardedCalls(repository, priced(config), work, SecretGuard())
    await middleware.awrap_model_call(fixture_request(), AsyncMock(return_value=cached_answer()))
    (_, tokens, cost), = repository.settled
    assert tokens == 104_000 and cost == pytest.approx(0.213)
    assert repository.breakdowns == [{"input_tokens": 100_000, "output_tokens": 4_000,
                                      "cache_read_tokens": 60_000, "cache_write_tokens": 20_000}]
    # The reservation charged every input token as a cache write, so no settlement of this request can exceed it.
    _, reserved_tokens, reserved_usd, _ = repository.reservations[0]
    assert reserved_usd == pytest.approx(((reserved_tokens - 4096) * 3.75 + 4096 * 15.0) / 1_000_000)


async def test_the_supervisor_conversation_settles_with_the_same_prices():
    repository = SimpleNamespace(reserve_chat_usage=AsyncMock(return_value="usage"), settle_usage=AsyncMock())
    guard = ChatGuard(repository, priced(fixture_config()), SecretGuard(), "fixture-event")
    await guard.awrap_model_call(fixture_request(), AsyncMock(return_value=cached_answer()))
    (usage_id, tokens, cost), settled = repository.settle_usage.await_args.args, repository.settle_usage.await_args.kwargs
    assert (usage_id, tokens) == ("usage", 104_000) and cost == pytest.approx(0.213)
    assert settled["breakdown"]["cache_write_tokens"] == 20_000 and settled["breakdown"]["cache_read_tokens"] == 60_000


class FailingLedger(Repository):
    def __init__(self):
        super().__init__()
        self.failures = []

    async def fail_usage(self, usage_id, failure_class):
        self.failures.append((usage_id, failure_class))


async def test_a_call_that_never_settles_leaves_its_failure_class_on_its_reservation():
    work, _, config = setup()
    repository = FailingLedger()
    middleware = GuardedCalls(repository, config, work, SecretGuard())
    middleware.sleep = AsyncMock()
    provider = AsyncMock(side_effect=[sdk_error(openai.RateLimitError, 429) for _ in range(3)])
    with pytest.raises(DomainError) as caught:
        await middleware.awrap_model_call(fixture_request(), provider)
    assert caught.value.code == "MODEL_RATE_LIMITED"
    # Once, when the last attempt failed: the two attempts before it were not the call's outcome.
    assert repository.failures == [("1", "rate_limit")] and repository.settled == []


async def test_a_retried_call_that_then_answers_is_settled_and_carries_no_failure_class():
    work, _, config = setup()
    repository = FailingLedger()
    middleware = GuardedCalls(repository, config, work, SecretGuard())
    middleware.sleep = AsyncMock()
    answer = SimpleNamespace(result=[AIMessage(content="Observed", usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})])
    await middleware.awrap_model_call(fixture_request(), AsyncMock(side_effect=[sdk_error(openai.RateLimitError, 429), answer]))
    assert repository.failures == [] and len(repository.settled) == 1


async def test_the_supervisor_conversation_records_why_its_call_failed():
    repository = SimpleNamespace(reserve_chat_usage=AsyncMock(return_value="usage"), settle_usage=AsyncMock(), fail_usage=AsyncMock())
    guard = ChatGuard(repository, fixture_config(), SecretGuard(), "fixture-event")
    guard.sleep = AsyncMock()
    with pytest.raises(DomainError):
        await guard.awrap_model_call(fixture_request(), AsyncMock(side_effect=[sdk_error(openai.AuthenticationError, 401)]))
    repository.fail_usage.assert_awaited_once_with("usage", "authentication")
    repository.settle_usage.assert_not_awaited()
