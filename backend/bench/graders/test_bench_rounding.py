import unittest
from decimal import Decimal

from pricing import total


class RoundingGrader(unittest.TestCase):
    def test_half_cent_rounds_up(self):
        self.assertEqual(total([("0.125", 1)], tax_rate="0"), Decimal("0.13"))

    def test_existing_behaviour_is_preserved(self):
        self.assertEqual(total([("100.00", 1)], percent=10, tax_rate="0.10"), Decimal("99.00"))


if __name__ == "__main__":
    unittest.main()
