"""One JSON line on standard error per operational event: identifiers and codes, never payload.

The factory's record of a run is the event log and the ledger. These lines are for the operator
who reads the containers' output: what was admitted, which stage changed, which provider or
executor call failed and what the owner decided, each with the run, the invocation and the trace
it belongs to. A field that is not a known identifier, code or count is left out, so no prompt,
answer, command or message can travel here.
"""

import json
import re
import sys
from contextlib import suppress
from functools import wraps

from sabre.models import now
from sabre.telemetry import trace_identifiers

EVENTS = frozenset({
    "work.admitted", "stage.started", "stage.completed", "stage.failed", "stage.interrupted",
    "model.failed", "executor.failed",
    "owner.answer", "owner.control", "owner.budget", "owner.scope", "owner.security_exception", "owner.confirmation",
})
IDENTIFIER = re.compile(r"[A-Za-z0-9_/:.-]{1,200}")
# Values of these fields are identifiers or members of a closed vocabulary.
TEXT_FIELDS = frozenset({"work_id", "project_id", "agent_id", "phase", "role", "mode", "channel", "decision", "kind",
                         "failure_class", "error_code"})
NUMBER_FIELDS = frozenset({"duration_ms", "attempt", "plan_revision"})


def record(event: str, **fields) -> dict | None:
    """The line for an event, or None when the event is not one the factory logs."""
    if event not in EVENTS:
        return None
    line: dict = {"ts": now().isoformat(), "event": event}
    for key, value in fields.items():
        if key in TEXT_FIELDS and isinstance(value, str) and IDENTIFIER.fullmatch(value):
            line[key] = value
        elif key in NUMBER_FIELDS and type(value) is int and 0 <= value < 10**12:
            line[key] = value
    line.update({key: value for key, value in trace_identifiers().items() if value})
    return line


def log(event: str, **fields) -> None:
    line = record(event, **fields)
    if line is None:
        return
    # A closed or broken stream must not change what the factory does.
    with suppress(Exception):
        sys.stderr.write(json.dumps(line, separators=(",", ":")) + "\n")
        sys.stderr.flush()


def owner_decision(event: str, decision: str | None = None):
    """Log an owner decision about a run once the operation it asked for returned.

    The decorated method takes the run's identifier first. Without ``decision`` the command
    that follows it names the decision (pause, resume, cancel).
    """

    def wrap(operation):
        @wraps(operation)
        async def call(self, work_id, *args, **kwargs):
            result = await operation(self, work_id, *args, **kwargs)
            command = args[0] if args else kwargs.get("command")
            log(event, work_id=work_id, decision=decision or (command if isinstance(command, str) else None))
            return result

        return call

    return wrap
