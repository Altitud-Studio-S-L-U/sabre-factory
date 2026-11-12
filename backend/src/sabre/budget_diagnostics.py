"""Numeric dispatch-denial evidence; never reconstructs an unrecorded request."""

from sabre.budget_contracts import BudgetDenial


def dispatch_denial(metric, accounted, requested, limit, *, used=None, reserved=None):
    return BudgetDenial(metric=metric,
        basis="next_reservation" if accounted < limit and requested > 0 else "consumed_limit",
        used=used, reserved=reserved, requested=requested, required=accounted + requested, limit=limit)


def recorded_denial(work):
    if work.error_code is None or not (work.error_code.startswith("BUDGET_") or work.error_code == "TIME_BUDGET"):
        return None
    if work.budget_denial is not None:
        return work.budget_denial
    known = {"BUDGET_TOKENS": "tokens", "BUDGET_INVOCATIONS": "invocations", "BUDGET_ACTIVE_SECONDS": "active_seconds",
        "BUDGET_REPAIRS": "repairs", "TIME_BUDGET": "active_seconds", "BUDGET_API_SPEND": "api_spend", "BUDGET_FACTORY_SPEND": "factory_spend"}
    return BudgetDenial.model_validate({"metric": known.get(work.error_code, "unknown"), "basis": "historical_unknown"})
