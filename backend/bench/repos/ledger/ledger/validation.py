"""Checks applied to records before they are stored.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_code_rule(record: dict) -> dict:
    """Return a copy of a code rule record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_code_rule() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "code_rule"
    return cleaned


def validate_code_rule(record: dict) -> list[str]:
    """List what is wrong with a code rule record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("code rule: a code is required")
    if record.get("kind") not in (None, "code_rule"):
        problems.append("code rule: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("code rule: amounts are whole minor units")
    return problems


def describe_code_rule(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a code rule record."""
    return f"code rule {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_amount_rule(record: dict) -> dict:
    """Return a copy of a amount rule record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_amount_rule() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "amount_rule"
    return cleaned


def validate_amount_rule(record: dict) -> list[str]:
    """List what is wrong with a amount rule record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("amount rule: a code is required")
    if record.get("kind") not in (None, "amount_rule"):
        problems.append("amount rule: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("amount rule: amounts are whole minor units")
    return problems


def describe_amount_rule(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a amount rule record."""
    return f"amount rule {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_date_rule(record: dict) -> dict:
    """Return a copy of a date rule record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_date_rule() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "date_rule"
    return cleaned


def validate_date_rule(record: dict) -> list[str]:
    """List what is wrong with a date rule record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("date rule: a code is required")
    if record.get("kind") not in (None, "date_rule"):
        problems.append("date rule: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("date rule: amounts are whole minor units")
    return problems


def describe_date_rule(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a date rule record."""
    return f"date rule {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_reference_rule(record: dict) -> dict:
    """Return a copy of a reference rule record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_reference_rule() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "reference_rule"
    return cleaned


def validate_reference_rule(record: dict) -> list[str]:
    """List what is wrong with a reference rule record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("reference rule: a code is required")
    if record.get("kind") not in (None, "reference_rule"):
        problems.append("reference rule: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("reference rule: amounts are whole minor units")
    return problems


def describe_reference_rule(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a reference rule record."""
    return f"reference rule {record.get('code', '?')}: {record.get('name', 'unnamed')}"
