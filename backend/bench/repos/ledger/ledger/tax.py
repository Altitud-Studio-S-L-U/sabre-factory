"""Tax codes applied to postings and the accounts they are collected in.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_vat_rate(record: dict) -> dict:
    """Return a copy of a vat rate record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_vat_rate() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "vat_rate"
    return cleaned


def validate_vat_rate(record: dict) -> list[str]:
    """List what is wrong with a vat rate record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("vat rate: a code is required")
    if record.get("kind") not in (None, "vat_rate"):
        problems.append("vat rate: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("vat rate: amounts are whole minor units")
    return problems


def describe_vat_rate(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a vat rate record."""
    return f"vat rate {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_exemption(record: dict) -> dict:
    """Return a copy of a exemption record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_exemption() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "exemption"
    return cleaned


def validate_exemption(record: dict) -> list[str]:
    """List what is wrong with a exemption record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("exemption: a code is required")
    if record.get("kind") not in (None, "exemption"):
        problems.append("exemption: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("exemption: amounts are whole minor units")
    return problems


def describe_exemption(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a exemption record."""
    return f"exemption {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_withholding(record: dict) -> dict:
    """Return a copy of a withholding record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_withholding() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "withholding"
    return cleaned


def validate_withholding(record: dict) -> list[str]:
    """List what is wrong with a withholding record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("withholding: a code is required")
    if record.get("kind") not in (None, "withholding"):
        problems.append("withholding: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("withholding: amounts are whole minor units")
    return problems


def describe_withholding(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a withholding record."""
    return f"withholding {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_jurisdiction(record: dict) -> dict:
    """Return a copy of a jurisdiction record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_jurisdiction() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "jurisdiction"
    return cleaned


def validate_jurisdiction(record: dict) -> list[str]:
    """List what is wrong with a jurisdiction record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("jurisdiction: a code is required")
    if record.get("kind") not in (None, "jurisdiction"):
        problems.append("jurisdiction: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("jurisdiction: amounts are whole minor units")
    return problems


def describe_jurisdiction(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a jurisdiction record."""
    return f"jurisdiction {record.get('code', '?')}: {record.get('name', 'unnamed')}"
