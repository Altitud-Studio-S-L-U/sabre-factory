import unittest
from decimal import Decimal

from pricing import apply_discount, subtotal, total


class PricingTest(unittest.TestCase):
    def test_subtotal_sums_lines(self):
        self.assertEqual(subtotal([("2.50", 2), ("1.00", 3)]), Decimal("8.00"))

    def test_discount_reduces_amount(self):
        self.assertEqual(apply_discount(Decimal("100"), 10), Decimal("90"))

    def test_total_applies_discount_before_tax(self):
        self.assertEqual(total([("100.00", 1)], percent=10, tax_rate="0.10"), Decimal("99.00"))


if __name__ == "__main__":
    unittest.main()
