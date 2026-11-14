"""Accounting periods: months, quarters and years, and whether each is open.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_month(record: dict) -> dict:
    """Return a copy of a month record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_month() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "month"
    return cleaned


def validate_month(record: dict) -> list[str]:
    """List what is wrong with a month record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("month: a code is required")
    if record.get("kind") not in (None, "month"):
        problems.append("month: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("month: amounts are whole minor units")
    return problems


def describe_month(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a month record."""
    return f"month {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_quarter(record: dict) -> dict:
    """Return a copy of a quarter record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_quarter() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "quarter"
    return cleaned


def validate_quarter(record: dict) -> list[str]:
    """List what is wrong with a quarter record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("quarter: a code is required")
    if record.get("kind") not in (None, "quarter"):
        problems.append("quarter: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("quarter: amounts are whole minor units")
    return problems


def describe_quarter(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a quarter record."""
    return f"quarter {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_year(record: dict) -> dict:
    """Return a copy of a year record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_year() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "year"
    return cleaned


def validate_year(record: dict) -> list[str]:
    """List what is wrong with a year record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("year: a code is required")
    if record.get("kind") not in (None, "year"):
        problems.append("year: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("year: amounts are whole minor units")
    return problems


def describe_year(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a year record."""
    return f"year {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_adjustment(record: dict) -> dict:
    """Return a copy of a adjustment record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_adjustment() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "adjustment"
    return cleaned


def validate_adjustment(record: dict) -> list[str]:
    """List what is wrong with a adjustment record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("adjustment: a code is required")
    if record.get("kind") not in (None, "adjustment"):
        problems.append("adjustment: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("adjustment: amounts are whole minor units")
    return problems


def describe_adjustment(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a adjustment record."""
    return f"adjustment {record.get('code', '?')}: {record.get('name', 'unnamed')}"
