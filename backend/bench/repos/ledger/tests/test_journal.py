import unittest
from datetime import date

from ledger.journal import Entry, Journal, Posting


class JournalTest(unittest.TestCase):
    def test_a_balanced_entry_posts_and_an_unbalanced_one_is_refused(self):
        journal = Journal()
        number = journal.post(Entry(date(2026, 1, 5), "Sale", [Posting("cash", debit=1210), Posting("sales", credit=1000), Posting("vat", credit=210)]))
        self.assertEqual(number, 1)
        self.assertEqual(journal.balance("cash"), 1210)
        with self.assertRaises(ValueError):
            journal.post(Entry(date(2026, 1, 6), "Broken", [Posting("cash", debit=100), Posting("sales", credit=90)]))

    def test_a_reversal_brings_every_balance_back_to_zero(self):
        journal = Journal()
        number = journal.post(Entry(date(2026, 1, 5), "Sale", [Posting("cash", debit=500), Posting("sales", credit=500)]))
        journal.reverse(number, date(2026, 1, 7))
        self.assertEqual(journal.trial_balance(), {"cash": 0, "sales": 0})


if __name__ == "__main__":
    unittest.main()
