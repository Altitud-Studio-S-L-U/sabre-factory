import unittest

from ledger.rounding import percent_of, split_evenly, to_minor_units


class RoundingTest(unittest.TestCase):
    def test_decimal_strings_round_half_up(self):
        self.assertEqual(to_minor_units("12.345"), 1235)
        self.assertEqual(to_minor_units("0.005"), 1)

    def test_shares_add_up_to_the_amount(self):
        self.assertEqual(split_evenly(100, 3), [34, 33, 33])
        self.assertEqual(sum(split_evenly(1001, 7)), 1001)

    def test_percentages_round_half_up(self):
        self.assertEqual(percent_of(250, "21"), 53)


if __name__ == "__main__":
    unittest.main()
