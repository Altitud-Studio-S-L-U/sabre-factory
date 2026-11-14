"""Currency conversion with a table of rates against a base currency."""

from ledger.rounding import scale

BASE = "EUR"


class RateTable:
    """Rates quoted as units of the foreign currency per unit of the base currency."""

    def __init__(self, rates: dict[str, float] | None = None):
        self.rates = dict(rates or {})
        self.rates[BASE] = 1.0

    def set_rate(self, currency: str, rate: float) -> None:
        # A rate of zero or below is accepted here and only fails later, as a division by zero.
        self.rates[currency.upper()] = rate

    def rate(self, currency: str) -> float:
        return self.rates[currency.upper()]

    def convert(self, amount: int, source: str, target: str) -> int:
        """Convert minor units of `source` into minor units of `target` through the base currency.

        Both steps use binary floats and half-even rounding (see rounding.scale), and the
        conversion assumes that both currencies have two decimal places: converting to a
        currency without minor units (JPY) is off by a factor of one hundred.
        """
        in_base = scale(amount, 1 / self.rate(source))
        return scale(in_base, self.rate(target))

    def revalue(self, balances: dict[str, int], target: str) -> int:
        """The total of balances held in several currencies, expressed in `target`."""
        return sum(self.convert(amount, currency, target) for currency, amount in balances.items())


def cross_rate(table: RateTable, source: str, target: str) -> float:
    """Units of `target` per unit of `source`, derived from the two rates against the base.

    The result is a float and is meant for display. Amounts are converted with
    RateTable.convert, which rounds at each of its two steps.
    """
    return table.rate(target) / table.rate(source)


def missing_rates(table: RateTable, currencies: list[str]) -> list[str]:
    """The currencies of `currencies` that the table has no rate for, in upper case and sorted.

    Call this before a revaluation: RateTable.rate raises KeyError for an unknown currency
    in the middle of the sum, after some balances have already been converted.
    """
    known = {currency.upper() for currency in table.rates}
    return sorted({currency.upper() for currency in currencies} - known)


def describe_rate(table: RateTable, currency: str) -> str:
    """One line for a report: how many units of a currency one unit of the base buys."""
    return f"1 {BASE} = {table.rate(currency):.4f} {currency.upper()}"
