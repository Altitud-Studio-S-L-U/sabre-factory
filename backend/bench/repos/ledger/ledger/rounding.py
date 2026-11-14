"""Rounding of amounts to minor units.

Every amount in the ledger is an integer of minor units. Values that arrive as decimal
strings or as the result of a multiplication are rounded here, once, before they are stored.
"""

from decimal import ROUND_HALF_UP, Decimal


def to_minor_units(value: str, exponent: int = 2) -> int:
    """Parse a decimal string such as "12.345" into minor units, rounding half up."""
    quantum = Decimal(1).scaleb(-exponent)
    return int(Decimal(value).quantize(quantum, rounding=ROUND_HALF_UP).scaleb(exponent))


def scale(amount: int, factor: float) -> int:
    """Multiply an amount of minor units by a factor and round to a whole unit.

    The factor is a binary float and the result goes through round(), which rounds half to
    even: scale(25, 0.1) is 2 and scale(35, 0.1) is 4. Callers that need half-up rounding of
    money (tax, discounts) do not get it from this function.
    """
    return round(amount * factor)


def split_evenly(amount: int, parts: int) -> list[int]:
    """Split an amount into `parts` shares that add up to it; the first shares take the remainder."""
    if parts <= 0:
        raise ValueError("parts must be positive")
    share, remainder = divmod(amount, parts)
    return [share + (1 if index < remainder else 0) for index in range(parts)]


def percent_of(amount: int, percent: str) -> int:
    """`percent` of an amount, given as a decimal string, rounded half up."""
    result = Decimal(amount) * Decimal(percent) / Decimal(100)
    return int(result.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def allocate_by_weights(amount: int, weights: list[int]) -> list[int]:
    """Split an amount in proportion to integer weights so that the shares add up to it.

    Each share is first rounded down; the units left over go one by one to the shares with
    the largest remainders, and ties go to the earlier share. This is the method used for
    spreading a discount or a tax amount over the lines of an invoice.
    """
    total = sum(weights)
    if total <= 0 or any(weight < 0 for weight in weights):
        raise ValueError("weights are not negative and are not all zero")
    exact = [amount * weight for weight in weights]
    shares = [value // total for value in exact]
    order = sorted(range(len(weights)), key=lambda index: (-(exact[index] % total), index))
    for index in order[:amount - sum(shares)]:
        shares[index] += 1
    return shares


def round_to_step(amount: int, step: int) -> int:
    """Round an amount to the nearest multiple of `step` minor units, halves away from zero.

    Used for cash rounding, where the smallest coin is five cents: round_to_step(1232, 5) is
    1230 and round_to_step(1233, 5) is 1235.
    """
    if step <= 0:
        raise ValueError("step must be positive")
    quotient, remainder = divmod(abs(amount), step)
    rounded = (quotient + (1 if remainder * 2 >= step else 0)) * step
    return rounded if amount >= 0 else -rounded
