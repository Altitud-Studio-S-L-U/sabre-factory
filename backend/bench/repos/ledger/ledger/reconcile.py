"""Bank reconciliation: statements, matches and the differences left over.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_statement(record: dict) -> dict:
    """Return a copy of a statement record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_statement() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "statement"
    return cleaned


def validate_statement(record: dict) -> list[str]:
    """List what is wrong with a statement record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("statement: a code is required")
    if record.get("kind") not in (None, "statement"):
        problems.append("statement: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("statement: amounts are whole minor units")
    return problems


def describe_statement(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a statement record."""
    return f"statement {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_match(record: dict) -> dict:
    """Return a copy of a match record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_match() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "match"
    return cleaned


def validate_match(record: dict) -> list[str]:
    """List what is wrong with a match record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("match: a code is required")
    if record.get("kind") not in (None, "match"):
        problems.append("match: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("match: amounts are whole minor units")
    return problems


def describe_match(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a match record."""
    return f"match {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_difference(record: dict) -> dict:
    """Return a copy of a difference record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_difference() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "difference"
    return cleaned


def validate_difference(record: dict) -> list[str]:
    """List what is wrong with a difference record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("difference: a code is required")
    if record.get("kind") not in (None, "difference"):
        problems.append("difference: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("difference: amounts are whole minor units")
    return problems


def describe_difference(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a difference record."""
    return f"difference {record.get('code', '?')}: {record.get('name', 'unnamed')}"


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
