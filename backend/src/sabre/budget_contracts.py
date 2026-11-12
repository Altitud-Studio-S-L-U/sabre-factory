"""Independent cumulative ceilings. A finite reserve is an exact launch grant."""

from typing import Literal

from pydantic import Field, model_validator

from sabre.contracts import StrictContract

BudgetMetric = Literal["tokens", "invocations", "active_seconds", "repairs"]


class BudgetDenial(StrictContract):
    version: Literal[1] = 1
    metric: Literal["tokens", "invocations", "active_seconds", "repairs", "api_spend", "factory_spend", "unknown"]
    basis: Literal["next_reservation", "consumed_limit", "historical_unknown"]
    used: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    reserved: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    requested: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    required: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    limit: float | None = Field(default=None, ge=0, allow_inf_nan=False)


class MetricBudget(StrictContract):
    primary: int | None = Field(ge=0, le=1000000000)
    reserve: int = Field(default=0, ge=0, le=1000000000)
    absolute: int | None = Field(ge=0, le=1000000000)

    @model_validator(mode="after")
    def finite_authority(self):
        if self.primary is None:
            if self.absolute is not None or self.reserve:
                raise ValueError("An uncapped metric has no reserve or absolute ceiling")
        elif self.absolute != self.primary + self.reserve:
            raise ValueError("The absolute ceiling must equal the primary plus its finite authorized reserve")
        return self


def bounded(value):
    return MetricBudget(primary=value, reserve=0, absolute=value)


def legacy_policy(budget, repairs):
    return BudgetPolicy(version=1, tokens=bounded(budget.max_tokens), invocations=bounded(budget.max_calls),
                        active_seconds=bounded(budget.active_seconds), repairs=bounded(repairs))


class BudgetPolicy(StrictContract):
    version: Literal[1]
    tokens: MetricBudget = Field(default_factory=lambda: bounded(100000))
    invocations: MetricBudget = Field(default_factory=lambda: bounded(40))
    active_seconds: MetricBudget = Field(default_factory=lambda: bounded(3600))
    repairs: MetricBudget = Field(default_factory=lambda: bounded(2))
    no_progress_threshold: int = Field(default=3, ge=2, le=20)


class BudgetAmendment(StrictContract):
    version: Literal[1]
    expected_revision: int = Field(ge=0)
    metric: BudgetMetric
    policy: MetricBudget
    reason: str = Field(min_length=5, max_length=2000)
    resume: bool = False


class BudgetReconciliation(StrictContract):
    version: Literal[1]
    expected_revision: int = Field(ge=0)
    usage_ids: list[str] = Field(min_length=1, max_length=50)
    reason: str = Field(min_length=5, max_length=2000)


class BudgetAuthorization(StrictContract):
    version: Literal[1] = 1
    revision: int = Field(ge=1)
    metric: BudgetMetric
    operation: Literal["amend", "reserve_activation", "usage_reconciliation"]
    before: MetricBudget
    after: MetricBudget
    reason: str
    usage_ids: list[str] = Field(default_factory=list, max_length=50)


class BudgetMetricView(StrictContract):
    policy: MetricBudget
    used: float | None
    reserved: float
    remaining: float | None
    unknown: bool


class BudgetView(StrictContract):
    version: Literal[1] = 1
    revision: int
    metrics: dict[BudgetMetric, BudgetMetricView]
    authorizations: list[BudgetAuthorization]
    limiting_metric: str | None
    pending_step: str
    token_prevention: Literal["reservation_bound", "cli_post_invocation"]
    unsettled_usage_ids: list[str] = Field(default_factory=list, max_length=50)
    unreconciled_calls: int = Field(default=0, ge=0)
    denial: BudgetDenial | None = None


def activate_reserve(metric: MetricBudget, required: float) -> MetricBudget | None:
    if metric.primary is None or required <= metric.primary:
        return metric.model_copy(deep=True)
    if metric.reserve == 0 or metric.absolute is None or required > metric.absolute:
        return None
    # Activate the single finite tranche. No subsequent cycle replenishes it.
    return MetricBudget(primary=metric.absolute, reserve=0, absolute=metric.absolute)
