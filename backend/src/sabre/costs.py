"""What one settled model call cost, with the cache counted at its own prices.

Providers report cached input as part of the input tokens. A cache read is far cheaper than fresh
input and a cache write is dearer, so charging all of it at the input price is wrong in both
directions. Each kind is charged at its own price; a kind with no price of its own falls back to
the input price, which is what the ledger did for every token before these prices existed.
"""

from dataclasses import dataclass
from math import isfinite


@dataclass(frozen=True)
class Rates:
    """USD per million tokens. ``cache_read`` and ``cache_write`` are None when the operator set no price for them."""

    input: float
    output: float
    cache_read: float | None = None
    cache_write: float | None = None

    @classmethod
    def of(cls, settings, *, free: bool = False) -> Rates:
        """The rates a model selection carries. ``free`` is a CLI session: no API charge per token."""
        if free:
            return cls(0.0, 0.0, 0.0, 0.0)
        optional = [getattr(settings, name, None) for name in ("model_cache_read_usd_per_million", "model_cache_write_usd_per_million")]
        read, write = (value if isinstance(value, int | float) and not isinstance(value, bool) else None for value in optional)
        return cls(settings.model_input_usd_per_million, settings.model_output_usd_per_million, read, write)


def cache_tokens(usage: dict, kind: str) -> int:
    """Provider-reported cached input tokens of one kind ("cache_read" or "cache_creation"), or 0 when unreported."""
    details = usage.get("input_token_details") or {}
    value = details.get(kind, 0) if isinstance(details, dict) else 0
    return value if type(value) is int and value >= 0 else 0


# An integration that splits cache writes by lifetime reports them under these keys and zeroes the generic one.
WRITE_LIFETIME_KEYS = ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")


def cache_write_tokens(usage: dict) -> int:
    """Input tokens written to the provider's cache, counted once whichever way the integration reports them."""
    return sum(cache_tokens(usage, key) for key in WRITE_LIFETIME_KEYS) or cache_tokens(usage, "cache_creation")


def reported_cost_usd(messages) -> float | None:
    """What the provider itself said these responses cost; None when none of them said."""
    reported = []
    for message in messages:
        metadata = getattr(message, "response_metadata", None)
        value = metadata.get("reported_cost_usd") if isinstance(metadata, dict) else None
        if isinstance(value, int | float) and not isinstance(value, bool) and isfinite(value) and 0 <= value <= 100_000:
            reported.append(float(value))
    return sum(reported) if reported else None


def call_cost_usd(rates: Rates, *, input_tokens: int, output_tokens: int, cache_read_tokens: int = 0, cache_write_tokens: int = 0) -> float:
    """What a settled call cost. ``input_tokens`` includes the cached ones, as providers report them."""
    fresh = max(0, input_tokens - cache_read_tokens - cache_write_tokens)
    read = rates.cache_read if rates.cache_read is not None else rates.input
    write = rates.cache_write if rates.cache_write is not None else rates.input
    return (fresh * rates.input + cache_read_tokens * read + cache_write_tokens * write + output_tokens * rates.output) / 1_000_000


def reserved_cost_usd(rates: Rates, *, input_tokens: int, output_tokens: int) -> float:
    """The most a call can cost: every input token at its dearest price, which a cache write can be."""
    dearest = max(rates.input, rates.cache_read or 0.0, rates.cache_write or 0.0)
    return (input_tokens * dearest + output_tokens * rates.output) / 1_000_000
