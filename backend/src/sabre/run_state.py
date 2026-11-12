"""Run-state semantics shared by notifications and the Supervisor; mirrors web/src/runState.ts.

The status decides what is current. A retained error code is a stop reason only while the run can resume;
on a closed run it is history. These are predicates over the persisted projection, not a state machine.
"""

from sabre.models import Status, WorkOrder

CLOSED = frozenset({Status.COMPLETED, Status.CANCELLED})
STOPPED = frozenset({Status.PAUSED, Status.BLOCKED, Status.FAILED})
# Owner pause/cancel requests are control outcomes; older rows stored them as error codes.
CONTROL_OUTCOMES = {"PAUSE_REQUESTED": Status.PAUSED, "CANCEL_REQUESTED": Status.CANCELLED}


def is_control_outcome(error: BaseException) -> bool:
    """An owner pause/cancel request raised at a safe boundary: an interruption, not a failure."""
    return getattr(error, "code", None) in CONTROL_OUTCOMES


def open_questions(work: WorkOrder) -> list:
    """Unanswered questions of the current plan revision; a closed run has none."""
    if work.status in CLOSED:
        return []
    return [item for item in work.questions if item.answer is None and item.plan_revision == work.plan_revision]


def stop_reason(work: WorkOrder) -> dict | None:
    """The retained error code and whether it is the current stop reason or history."""
    code = work.error_code
    if not code or code in CONTROL_OUTCOMES:
        return None
    if work.status in STOPPED:
        return {"code": code, "basis": "current"}
    if work.status in CLOSED:
        return {"code": code, "basis": "historical"}
    return None
