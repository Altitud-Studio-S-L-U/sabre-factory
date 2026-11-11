import pytest

from sabre.models import Budget, HumanQuestion, Status, WorkOrder
from sabre.run_state import open_questions, stop_reason


def work(status, error_code="BUDGET_EXHAUSTED", **updates):
    return WorkOrder(id="run-a", project_id="project-a", mode="patch", objective="Correct the example",
        acceptance=["Tests pass"], idempotency_key="synthetic-run-state-000", budget=Budget(), status=status, error_code=error_code, **updates)


@pytest.mark.parametrize(("status", "basis"), [
    (Status.PAUSED, "current"), (Status.BLOCKED, "current"), (Status.FAILED, "current"),
    (Status.CANCELLED, "historical"), (Status.COMPLETED, "historical"),
    (Status.QUEUED, None), (Status.RUNNING, None), (Status.WAITING_INPUT, None)])
def test_status_decides_whether_a_retained_code_is_current_or_history(status, basis):
    reason = stop_reason(work(status))
    assert (reason or {}).get("basis") == basis
    if basis:
        assert reason["code"] == "BUDGET_EXHAUSTED"


def test_owner_control_codes_are_not_stop_reasons():
    assert stop_reason(work(Status.CANCELLED, "CANCEL_REQUESTED")) is None
    assert stop_reason(work(Status.PAUSED, "PAUSE_REQUESTED")) is None
    assert stop_reason(work(Status.CANCELLED, None)) is None


def test_closed_runs_have_no_open_questions():
    question = HumanQuestion(work_id="run-a", plan_revision=1, prompt="Continue?", kind="clarification")
    stale = HumanQuestion(work_id="run-a", plan_revision=0, prompt="Old?", kind="clarification")
    assert open_questions(work(Status.WAITING_INPUT, None, questions=[question, stale])) == [question]
    assert open_questions(work(Status.CANCELLED, None, questions=[question])) == []
