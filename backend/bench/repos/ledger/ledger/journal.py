"""Journal entries: balanced sets of postings against accounts."""

from dataclasses import dataclass, field
from datetime import date


@dataclass(frozen=True)
class Posting:
    account: str
    debit: int = 0
    credit: int = 0

    def __post_init__(self):
        if self.debit < 0 or self.credit < 0:
            raise ValueError("amounts are not negative")
        if self.debit and self.credit:
            raise ValueError("a posting is a debit or a credit, not both")


@dataclass
class Entry:
    day: date
    memo: str
    postings: list[Posting] = field(default_factory=list)

    def debits(self) -> int:
        return sum(posting.debit for posting in self.postings)

    def credits(self) -> int:
        return sum(posting.credit for posting in self.postings)

    def balanced(self) -> bool:
        return self.debits() == self.credits() and bool(self.postings)


class Journal:
    """An append-only list of balanced entries."""

    def __init__(self):
        self.entries: list[Entry] = []

    def post(self, entry: Entry) -> int:
        """Append a balanced entry and return its number."""
        if not entry.balanced():
            raise ValueError("the entry does not balance")
        self.entries.append(entry)
        return len(self.entries)

    def reverse(self, number: int, day: date) -> int:
        """Post the mirror image of entry `number` and return the number of the reversal."""
        original = self.entries[number - 1]
        mirrored = [Posting(posting.account, debit=posting.credit, credit=posting.debit) for posting in original.postings]
        return self.post(Entry(day, f"Reversal of {number}: {original.memo}", mirrored))

    def balance(self, account: str) -> int:
        """Debits minus credits posted to an account."""
        return sum(posting.debit - posting.credit for entry in self.entries for posting in entry.postings if posting.account == account)

    def trial_balance(self) -> dict[str, int]:
        accounts = sorted({posting.account for entry in self.entries for posting in entry.postings})
        return {account: self.balance(account) for account in accounts}
