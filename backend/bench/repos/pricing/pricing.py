"""Order pricing for a small shop. Amounts are Decimal; prices are given as strings."""

from decimal import Decimal

CENT = Decimal("0.01")


def subtotal(items):
    """Sum (unit_price, quantity) pairs."""
    return sum((Decimal(price) * quantity for price, quantity in items), Decimal("0"))


def apply_discount(amount, percent):
    """Reduce amount by a percentage."""
    return amount - amount * Decimal(percent) / 100


def total(items, percent=0, tax_rate="0.21"):
    """Discount first, then tax, rounded to cents."""
    discounted = apply_discount(subtotal(items), percent)
    taxed = discounted * (1 + Decimal(tax_rate))
    return taxed.quantize(CENT)
