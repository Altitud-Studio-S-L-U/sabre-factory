"""Request and response shapes of the HTTP interface.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_entry_request(record: dict) -> dict:
    """Return a copy of a entry request record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_entry_request() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "entry_request"
    return cleaned


def validate_entry_request(record: dict) -> list[str]:
    """List what is wrong with a entry request record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("entry request: a code is required")
    if record.get("kind") not in (None, "entry_request"):
        problems.append("entry request: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("entry request: amounts are whole minor units")
    return problems


def describe_entry_request(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a entry request record."""
    return f"entry request {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_account_request(record: dict) -> dict:
    """Return a copy of a account request record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_account_request() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "account_request"
    return cleaned


def validate_account_request(record: dict) -> list[str]:
    """List what is wrong with a account request record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("account request: a code is required")
    if record.get("kind") not in (None, "account_request"):
        problems.append("account request: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("account request: amounts are whole minor units")
    return problems


def describe_account_request(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a account request record."""
    return f"account request {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_report_request(record: dict) -> dict:
    """Return a copy of a report request record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_report_request() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "report_request"
    return cleaned


def validate_report_request(record: dict) -> list[str]:
    """List what is wrong with a report request record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("report request: a code is required")
    if record.get("kind") not in (None, "report_request"):
        problems.append("report request: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("report request: amounts are whole minor units")
    return problems


def describe_report_request(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a report request record."""
    return f"report request {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_error_response(record: dict) -> dict:
    """Return a copy of a error response record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_error_response() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "error_response"
    return cleaned


def validate_error_response(record: dict) -> list[str]:
    """List what is wrong with a error response record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("error response: a code is required")
    if record.get("kind") not in (None, "error_response"):
        problems.append("error response: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("error response: amounts are whole minor units")
    return problems


def describe_error_response(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a error response record."""
    return f"error response {record.get('code', '?')}: {record.get('name', 'unnamed')}"
