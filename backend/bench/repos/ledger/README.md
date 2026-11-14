# ledger

A small double-entry bookkeeping library used as a SABRE Bench fixture. Amounts are integers of
minor units (cents). A journal entry balances when its debits equal its credits.

    python -m unittest

Modules live in `ledger/`; `tests/` holds the checks that must keep passing.
