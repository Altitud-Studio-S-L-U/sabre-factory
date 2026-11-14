"""Currencies the books may hold, with their minor units and display rules.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_currency(record: dict) -> dict:
    """Return a copy of a currency record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_currency() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "currency"
    return cleaned


def validate_currency(record: dict) -> list[str]:
    """List what is wrong with a currency record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("currency: a code is required")
    if record.get("kind") not in (None, "currency"):
        problems.append("currency: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("currency: amounts are whole minor units")
    return problems


def describe_currency(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a currency record."""
    return f"currency {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_denomination(record: dict) -> dict:
    """Return a copy of a denomination record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_denomination() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "denomination"
    return cleaned


def validate_denomination(record: dict) -> list[str]:
    """List what is wrong with a denomination record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("denomination: a code is required")
    if record.get("kind") not in (None, "denomination"):
        problems.append("denomination: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("denomination: amounts are whole minor units")
    return problems


def describe_denomination(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a denomination record."""
    return f"denomination {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_symbol(record: dict) -> dict:
    """Return a copy of a symbol record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_symbol() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "symbol"
    return cleaned


def validate_symbol(record: dict) -> list[str]:
    """List what is wrong with a symbol record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("symbol: a code is required")
    if record.get("kind") not in (None, "symbol"):
        problems.append("symbol: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("symbol: amounts are whole minor units")
    return problems


def describe_symbol(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a symbol record."""
    return f"symbol {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_locale(record: dict) -> dict:
    """Return a copy of a locale record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_locale() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "locale"
    return cleaned


def validate_locale(record: dict) -> list[str]:
    """List what is wrong with a locale record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("locale: a code is required")
    if record.get("kind") not in (None, "locale"):
        problems.append("locale: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("locale: amounts are whole minor units")
    return problems


def describe_locale(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a locale record."""
    return f"locale {record.get('code', '?')}: {record.get('name', 'unnamed')}"
