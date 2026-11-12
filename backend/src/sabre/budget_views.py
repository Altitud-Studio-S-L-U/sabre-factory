"""Budget projections retain unsettled usage as unknown, never free consumption."""

from sabre.budget_contracts import (
    BudgetAuthorization,
    BudgetMetric,
    BudgetMetricView,
    BudgetPolicy,
    BudgetView,
    bounded,
)
from sabre.budget_diagnostics import recorded_denial


async def budget_view(repository, work_id):
    work = await repository.work(work_id)
    usage = await repository.audit_usage(work_id)
    unreconciled = await repository.unreconciled_usage(work_id)
    async with repository.connection() as conn:
        rows = await (await conn.execute("SELECT data FROM work_budget_authorizations WHERE work_id=%s ORDER BY revision", (work_id,))).fetchall()
    policy = work.effective_budget_policy or BudgetPolicy(version=1,
        tokens=bounded(work.budget.max_tokens), invocations=bounded(work.budget.max_calls),
        active_seconds=bounded(work.budget.active_seconds), repairs=bounded(work.flow_config.repair_cycles))
    metrics: dict[BudgetMetric, BudgetMetricView] = {}
    used = {"tokens": usage["measured_tokens"] if usage["settled_calls"] or not usage["calls"] else None,
            "invocations": usage["calls"], "active_seconds": work.active_seconds_used, "repairs": work.repair_cycles_used}
    metric_names: tuple[BudgetMetric, ...] = ("tokens", "invocations", "active_seconds", "repairs")
    for metric in metric_names:
        selected = getattr(policy, metric)
        reserved = usage["unknown_reserved_tokens"] if metric == "tokens" else 0
        amount = used[metric]
        total = (amount or 0) + reserved
        metrics[metric] = BudgetMetricView(policy=selected, used=amount, reserved=reserved,
            remaining=None if selected.primary is None else max(0, selected.primary - total),
            unknown=bool(usage["unsettled_calls"]) if metric == "tokens" else False)
    cli = work.resolved_flow and any(phase.model.provider in {"codex_cli", "claude_cli"} for phase in work.resolved_flow.phases.values())
    return BudgetView(revision=work.budget_revision, metrics=metrics,
        authorizations=[BudgetAuthorization.model_validate(row["data"]) for row in rows],
        limiting_metric=work.limiting_metric, pending_step=work.phase,
        token_prevention="cli_post_invocation" if cli or work.budget.progress_limits else "reservation_bound",
        unsettled_usage_ids=[row["id"] for row in unreconciled[:50]], unreconciled_calls=len(unreconciled), denial=recorded_denial(work))
