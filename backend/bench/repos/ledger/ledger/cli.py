"""Arguments of the command-line tool.

Every record is a plain dictionary. Amounts are integers of minor units, codes are upper-case
and dates are ISO strings; the functions below keep those three rules for each record type.
"""


def normalize_post_command(record: dict) -> dict:
    """Return a copy of a post command record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_post_command() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "post_command"
    return cleaned


def validate_post_command(record: dict) -> list[str]:
    """List what is wrong with a post command record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("post command: a code is required")
    if record.get("kind") not in (None, "post_command"):
        problems.append("post command: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("post command: amounts are whole minor units")
    return problems


def describe_post_command(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a post command record."""
    return f"post command {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_report_command(record: dict) -> dict:
    """Return a copy of a report command record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_report_command() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "report_command"
    return cleaned


def validate_report_command(record: dict) -> list[str]:
    """List what is wrong with a report command record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("report command: a code is required")
    if record.get("kind") not in (None, "report_command"):
        problems.append("report command: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("report command: amounts are whole minor units")
    return problems


def describe_report_command(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a report command record."""
    return f"report command {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_close_command(record: dict) -> dict:
    """Return a copy of a close command record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_close_command() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "close_command"
    return cleaned


def validate_close_command(record: dict) -> list[str]:
    """List what is wrong with a close command record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("close command: a code is required")
    if record.get("kind") not in (None, "close_command"):
        problems.append("close command: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("close command: amounts are whole minor units")
    return problems


def describe_close_command(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a close command record."""
    return f"close command {record.get('code', '?')}: {record.get('name', 'unnamed')}"


def normalize_import_command(record: dict) -> dict:
    """Return a copy of a import command record with trimmed text and a canonical code.

    Lookups by code are exact, so the code is stored upper-case and without surrounding
    whitespace. Keys this module does not know are kept as they are: whether they are allowed
    is for validate_import_command() to say.
    """
    cleaned = {key: value.strip() if isinstance(value, str) else value for key, value in record.items()}
    cleaned["code"] = str(cleaned.get("code", "")).upper()
    cleaned["kind"] = "import_command"
    return cleaned


def validate_import_command(record: dict) -> list[str]:
    """List what is wrong with a import command record; an empty list means it can be stored."""
    problems = []
    if not record.get("code"):
        problems.append("import command: a code is required")
    if record.get("kind") not in (None, "import_command"):
        problems.append("import command: the record belongs to another type")
    amount = record.get("amount", 0)
    if isinstance(amount, bool) or not isinstance(amount, int):
        problems.append("import command: amounts are whole minor units")
    return problems


def describe_import_command(record: dict) -> str:
    """One line for listings and logs: the type, the code and the name of a import command record."""
    return f"import command {record.get('code', '?')}: {record.get('name', 'unnamed')}"
