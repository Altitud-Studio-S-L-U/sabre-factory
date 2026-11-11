import pytest
from pydantic import ValidationError

from sabre.budget_contracts import BudgetDenial
from sabre.budget_diagnostics import dispatch_denial, recorded_denial
from sabre.error_boundaries import safe_exception
from sabre.models import Budget, DomainError, WorkOrder
from sabre.security import SecretGuard


def test_denial_distinguishes_next_request_from_already_consumed_limit():
    denial = dispatch_denial("tokens", 700, 400, 1000, used=600, reserved=100)
    assert denial.basis == "next_reservation" and denial.required == 1100
    assert dispatch_denial("tokens", 1000, 1, 1000).basis == "consumed_limit"
    sanitized = safe_exception(DomainError("BUDGET_EXHAUSTED", "Reservation does not fit", budget_denial=denial), SecretGuard(), "FAILED")
    assert sanitized.budget_denial == denial


@pytest.mark.parametrize("change", [{"requested": float("inf")}, {"limit": -1}, {"used": True}, {"extra": 1}])
def test_denial_contract_rejects_malformed_numeric_evidence(change):
    with pytest.raises(ValidationError):
        BudgetDenial.model_validate({"version": 1, "metric": "tokens", "basis": "next_reservation", **change})


def test_legacy_denial_stays_unknown_and_resumed_run_does_not_project_old_error():
    work = WorkOrder(project_id="example", mode="audit", objective="Inspect", acceptance=["Evidence"], idempotency_key="example-key-000",
        budget=Budget(), status="blocked", error_code="BUDGET_EXHAUSTED", limiting_metric="exhausted")
    assert recorded_denial(work).basis == "historical_unknown"
    assert recorded_denial(work).requested is None
    work.budget_denial = dispatch_denial("tokens", 700, 400, 1000)
    assert recorded_denial(work) == work.budget_denial
    work.error_code = None
    assert recorded_denial(work) is None
