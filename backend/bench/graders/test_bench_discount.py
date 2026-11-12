import unittest
from decimal import Decimal

from pricing import apply_discount


class DiscountGrader(unittest.TestCase):
    def test_rejects_discount_above_one_hundred(self):
        with self.assertRaises(ValueError):
            apply_discount(Decimal("10"), 120)

    def test_rejects_negative_discount(self):
        with self.assertRaises(ValueError):
            apply_discount(Decimal("10"), -5)

    def test_accepts_bounds(self):
        self.assertEqual(apply_discount(Decimal("10"), 0), Decimal("10"))
        self.assertEqual(apply_discount(Decimal("10"), 100), Decimal("0"))


if __name__ == "__main__":
    unittest.main()
