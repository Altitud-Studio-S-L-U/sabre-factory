"""Export of the books for auditors and for other systems.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_audit_file(record: dict) -> dict:
    """Return a copy of a audit file record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_audit_file() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "audit_file"
    return cleaned


def validate_audit_file(record: dict) -> list[str]:
    """List what is wrong with a audit file record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("audit file: a code is required")
    if record.get("kind") not in (None, "audit_file"):
        problems.append("audit file: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("audit file: amounts are whole minor units")
    return problems


def describe_audit_file(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a audit file record."""
    return f"audit file {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_trial_balance_row(record: dict) -> dict:
    """Return a copy of a trial balance row record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_trial_balance_row() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "trial_balance_row"
    return cleaned


def validate_trial_balance_row(record: dict) -> list[str]:
    """List what is wrong with a trial balance row record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("trial balance row: a code is required")
    if record.get("kind") not in (None, "trial_balance_row"):
        problems.append("trial balance row: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("trial balance row: amounts are whole minor units")
    return problems


def describe_trial_balance_row(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a trial balance row record."""
    return f"trial balance row {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_ledger_line(record: dict) -> dict:
    """Return a copy of a ledger line record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_ledger_line() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "ledger_line"
    return cleaned


def validate_ledger_line(record: dict) -> list[str]:
    """List what is wrong with a ledger line record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("ledger line: a code is required")
    if record.get("kind") not in (None, "ledger_line"):
        problems.append("ledger line: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("ledger line: amounts are whole minor units")
    return problems


def describe_ledger_line(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a ledger line record."""
    return f"ledger line {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_attachment(record: dict) -> dict:
    """Return a copy of a attachment record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_attachment() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "attachment"
    return cleaned


def validate_attachment(record: dict) -> list[str]:
    """List what is wrong with a attachment record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("attachment: a code is required")
    if record.get("kind") not in (None, "attachment"):
        problems.append("attachment: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("attachment: amounts are whole minor units")
    return problems


def describe_attachment(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a attachment record."""
    return f"attachment {record.get('code', '?')}: {record.get('name', 'unnamed')}"
