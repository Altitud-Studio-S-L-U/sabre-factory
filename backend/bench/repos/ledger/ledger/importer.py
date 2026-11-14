"""Import of entries from files produced by other systems.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_csv_row(record: dict) -> dict:
    """Return a copy of a csv row record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_csv_row() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "csv_row"
    return cleaned


def validate_csv_row(record: dict) -> list[str]:
    """List what is wrong with a csv row record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("csv row: a code is required")
    if record.get("kind") not in (None, "csv_row"):
        problems.append("csv row: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("csv row: amounts are whole minor units")
    return problems


def describe_csv_row(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a csv row record."""
    return f"csv row {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_ofx_transaction(record: dict) -> dict:
    """Return a copy of a ofx transaction record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_ofx_transaction() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "ofx_transaction"
    return cleaned


def validate_ofx_transaction(record: dict) -> list[str]:
    """List what is wrong with a ofx transaction record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("ofx transaction: a code is required")
    if record.get("kind") not in (None, "ofx_transaction"):
        problems.append("ofx transaction: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("ofx transaction: amounts are whole minor units")
    return problems


def describe_ofx_transaction(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a ofx transaction record."""
    return f"ofx transaction {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_mt940_line(record: dict) -> dict:
    """Return a copy of a mt940 line record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_mt940_line() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "mt940_line"
    return cleaned


def validate_mt940_line(record: dict) -> list[str]:
    """List what is wrong with a mt940 line record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("mt940 line: a code is required")
    if record.get("kind") not in (None, "mt940_line"):
        problems.append("mt940 line: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("mt940 line: amounts are whole minor units")
    return problems


def describe_mt940_line(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a mt940 line record."""
    return f"mt940 line {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_mapping(record: dict) -> dict:
    """Return a copy of a mapping record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_mapping() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "mapping"
    return cleaned


def validate_mapping(record: dict) -> list[str]:
    """List what is wrong with a mapping record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("mapping: a code is required")
    if record.get("kind") not in (None, "mapping"):
        problems.append("mapping: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("mapping: amounts are whole minor units")
    return problems


def describe_mapping(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a mapping record."""
    return f"mapping {record.get('code', '?')}: {record.get('name', 'unnamed')}"
