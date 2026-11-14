"""The record of who changed what in the books, and when.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_change(record: dict) -> dict:
    """Return a copy of a change record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_change() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "change"
    return cleaned


def validate_change(record: dict) -> list[str]:
    """List what is wrong with a change record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("change: a code is required")
    if record.get("kind") not in (None, "change"):
        problems.append("change: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("change: amounts are whole minor units")
    return problems


def describe_change(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a change record."""
    return f"change {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_approval(record: dict) -> dict:
    """Return a copy of a approval record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_approval() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "approval"
    return cleaned


def validate_approval(record: dict) -> list[str]:
    """List what is wrong with a approval record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("approval: a code is required")
    if record.get("kind") not in (None, "approval"):
        problems.append("approval: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("approval: amounts are whole minor units")
    return problems


def describe_approval(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a approval record."""
    return f"approval {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_login(record: dict) -> dict:
    """Return a copy of a login record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_login() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "login"
    return cleaned


def validate_login(record: dict) -> list[str]:
    """List what is wrong with a login record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("login: a code is required")
    if record.get("kind") not in (None, "login"):
        problems.append("login: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("login: amounts are whole minor units")
    return problems


def describe_login(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a login record."""
    return f"login {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_export_event(record: dict) -> dict:
    """Return a copy of a export event record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_export_event() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "export_event"
    return cleaned


def validate_export_event(record: dict) -> list[str]:
    """List what is wrong with a export event record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("export event: a code is required")
    if record.get("kind") not in (None, "export_event"):
        problems.append("export event: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("export event: amounts are whole minor units")
    return problems


def describe_export_event(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a export event record."""
    return f"export event {record.get('code', '?')}: {record.get('name', 'unnamed')}"
