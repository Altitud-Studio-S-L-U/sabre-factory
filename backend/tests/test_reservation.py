"""The input reservation is an estimate in tokens, not one token per byte."""

from sabre.agents import API_INPUT_MARGIN_TOKENS, CLI_INPUT_MARGIN_TOKENS, input_reservation_tokens
from sabre.models import Budget


def test_reservation_estimates_tokens_and_fits_the_default_budget_at_the_context_ceiling():
    assert input_reservation_tokens(25_000) == 10_000 + API_INPUT_MARGIN_TOKENS
    assert input_reservation_tokens(25_000, cli=True) == 10_000 + CLI_INPUT_MARGIN_TOKENS
    ceiling = input_reservation_tokens(98_304, cli=True) + 4096
    assert ceiling < 98_304 + 2048 and ceiling <= Budget().max_tokens
