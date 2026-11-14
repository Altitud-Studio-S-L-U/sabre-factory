"""The chart of accounts: codes, types and the normal side of each account.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_asset(record: dict) -> dict:
    """Return a copy of a asset record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_asset() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "asset"
    return cleaned


def validate_asset(record: dict) -> list[str]:
    """List what is wrong with a asset record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("asset: a code is required")
    if record.get("kind") not in (None, "asset"):
        problems.append("asset: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("asset: amounts are whole minor units")
    return problems


def describe_asset(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a asset record."""
    return f"asset {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_liability(record: dict) -> dict:
    """Return a copy of a liability record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_liability() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "liability"
    return cleaned


def validate_liability(record: dict) -> list[str]:
    """List what is wrong with a liability record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("liability: a code is required")
    if record.get("kind") not in (None, "liability"):
        problems.append("liability: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("liability: amounts are whole minor units")
    return problems


def describe_liability(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a liability record."""
    return f"liability {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_equity(record: dict) -> dict:
    """Return a copy of a equity record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_equity() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "equity"
    return cleaned


def validate_equity(record: dict) -> list[str]:
    """List what is wrong with a equity record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("equity: a code is required")
    if record.get("kind") not in (None, "equity"):
        problems.append("equity: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("equity: amounts are whole minor units")
    return problems


def describe_equity(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a equity record."""
    return f"equity {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_income(record: dict) -> dict:
    """Return a copy of a income record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_income() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "income"
    return cleaned


def validate_income(record: dict) -> list[str]:
    """List what is wrong with a income record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("income: a code is required")
    if record.get("kind") not in (None, "income"):
        problems.append("income: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("income: amounts are whole minor units")
    return problems


def describe_income(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a income record."""
    return f"income {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_expense(record: dict) -> dict:
    """Return a copy of a expense record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_expense() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "expense"
    return cleaned


def validate_expense(record: dict) -> list[str]:
    """List what is wrong with a expense record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("expense: a code is required")
    if record.get("kind") not in (None, "expense"):
        problems.append("expense: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("expense: amounts are whole minor units")
    return problems


def describe_expense(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a expense record."""
    return f"expense {record.get('code', '?')}: {record.get('name', 'unnamed')}"
