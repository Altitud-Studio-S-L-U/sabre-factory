"""Definitions of the reports the books can produce.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_balance_sheet(record: dict) -> dict:
    """Return a copy of a balance sheet record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_balance_sheet() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "balance_sheet"
    return cleaned


def validate_balance_sheet(record: dict) -> list[str]:
    """List what is wrong with a balance sheet record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("balance sheet: a code is required")
    if record.get("kind") not in (None, "balance_sheet"):
        problems.append("balance sheet: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("balance sheet: amounts are whole minor units")
    return problems


def describe_balance_sheet(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a balance sheet record."""
    return f"balance sheet {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_income_statement(record: dict) -> dict:
    """Return a copy of a income statement record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_income_statement() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "income_statement"
    return cleaned


def validate_income_statement(record: dict) -> list[str]:
    """List what is wrong with a income statement record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("income statement: a code is required")
    if record.get("kind") not in (None, "income_statement"):
        problems.append("income statement: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("income statement: amounts are whole minor units")
    return problems


def describe_income_statement(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a income statement record."""
    return f"income statement {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_cash_flow(record: dict) -> dict:
    """Return a copy of a cash flow record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_cash_flow() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "cash_flow"
    return cleaned


def validate_cash_flow(record: dict) -> list[str]:
    """List what is wrong with a cash flow record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("cash flow: a code is required")
    if record.get("kind") not in (None, "cash_flow"):
        problems.append("cash flow: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("cash flow: amounts are whole minor units")
    return problems


def describe_cash_flow(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a cash flow record."""
    return f"cash flow {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_aging(record: dict) -> dict:
    """Return a copy of a aging record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_aging() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "aging"
    return cleaned


def validate_aging(record: dict) -> list[str]:
    """List what is wrong with a aging record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("aging: a code is required")
    if record.get("kind") not in (None, "aging"):
        problems.append("aging: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("aging: amounts are whole minor units")
    return problems


def describe_aging(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a aging record."""
    return f"aging {record.get('code', '?')}: {record.get('name', 'unnamed')}"
