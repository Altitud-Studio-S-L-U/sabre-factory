import asyncio

import pytest

from integration.test_postgres import fixture_work
from sabre.budget_contracts import BudgetAmendment, BudgetPolicy, BudgetReconciliation, MetricBudget, bounded
from sabre.budget_views import budget_view
from sabre.models import DomainError, Status

pytest_plugins = ["integration.test_postgres"]


async def policy_work(repository, policy):
    repo, project, work = await fixture_work(repository)
    work.budget.policy = policy.model_copy(deep=True)
    work.effective_budget_policy = policy.model_copy(deep=True)
    await repo.save(work)
    return repo, project, work


async def test_atomic_reserve_activation_is_once_and_preserves_initial_policy(repository):
    initial = BudgetPolicy(version=1, invocations=MetricBudget(primary=0, reserve=2, absolute=2), tokens=bounded(None))
    repo, _, work = await policy_work(repository, initial)
    outcomes = await asyncio.gather(*(repo.reserve_usage(work.model_copy(deep=True), 5, 0, 100) for _ in range(3)), return_exceptions=True)
    assert sum(isinstance(item, str) for item in outcomes) == 2
    assert sum(isinstance(item, DomainError) and item.code == "BUDGET_INVOCATIONS" for item in outcomes) == 1
    saved = await repo.work(work.id)
    assert saved.budget.policy == initial
    assert saved.effective_budget_policy.invocations == bounded(2)
    view = await budget_view(repo, work.id)
    assert len(view.authorizations) == 1 and view.authorizations[0].operation == "reserve_activation"
    assert view.metrics["tokens"].used is None and view.metrics["tokens"].unknown
    assert view.metrics["tokens"].reserved == 10


async def test_metrics_exhaust_independently_and_zero_spend_never_authorizes_paid_call(repository):
    repo, _, work = await policy_work(repository, BudgetPolicy(version=1, tokens=bounded(5), invocations=bounded(None)))
    with pytest.raises(DomainError) as error:
        await repo.reserve_usage(work, 6, 0, 100)
    assert error.value.code == "BUDGET_TOKENS"
    work.budget.max_cost_usd = 0
    await repo.save(work)
    with pytest.raises(DomainError) as error:
        await repo.reserve_usage(work, 1, 0.1, 100)
    assert error.value.code == "BUDGET_API_SPEND"
    assert (await repo.usage(work.id))["calls"] == 0
    with pytest.raises(DomainError) as error:
        await repo.ensure_budget_metric(work, "repairs", 3)
    assert error.value.code == "BUDGET_REPAIRS"


@pytest.mark.parametrize("modern", [False, True])
async def test_denial_records_next_reservation_without_claiming_all_tokens_consumed(repository, modern):
    repo, _, work = await fixture_work(repository)
    work.budget.max_tokens = 1000
    if modern:
        work.effective_budget_policy = BudgetPolicy(version=1, tokens=bounded(1000))
    await repo.save(work)
    first = await repo.reserve_usage(work, 800, 0, 100)
    await repo.settle_usage(first, 600, 0)
    await repo.reserve_usage(work, 100, 0, 100)
    with pytest.raises(DomainError) as error:
        await repo.reserve_usage(work, 400, 0, 100)
    assert error.value.code == ("BUDGET_TOKENS" if modern else "BUDGET_EXHAUSTED")
    denial = error.value.budget_denial
    assert denial.model_dump() == {"version": 1, "metric": "tokens", "basis": "next_reservation",
        "used": 600, "reserved": 100, "requested": 400, "required": 1100, "limit": 1000}
    assert (await repo.usage(work.id))["calls"] == 2
    work.status, work.error_code, work.budget_denial = Status.BLOCKED, error.value.code, denial
    await repo.save(work)
    assert (await repo.work(work.id)).budget_denial == denial
    assert (await budget_view(repo, work.id)).denial == denial


@pytest.mark.parametrize(("metric", "budget", "tokens", "usd", "monthly_limit"), [
    ("invocations", {"max_calls": 1}, 1, 0, 100),
    ("api_spend", {"max_cost_usd": 0}, 1, 0.1, 100),
    ("factory_spend", {"max_cost_usd": 10}, 1, 0.1, 0),
])
async def test_legacy_generic_code_keeps_precise_denied_metric(repository, metric, budget, tokens, usd, monthly_limit):
    repo, _, work = await fixture_work(repository)
    work.budget = work.budget.model_copy(update=budget)
    await repo.save(work)
    if metric == "invocations":
        await repo.reserve_usage(work, 1, 0, monthly_limit)
    with pytest.raises(DomainError) as error:
        await repo.reserve_usage(work, tokens, usd, monthly_limit)
    assert error.value.code == "BUDGET_EXHAUSTED" and error.value.budget_denial.metric == metric
    assert error.value.budget_denial.requested == (1 if metric == "invocations" else 0.1)
    assert (await repo.usage(work.id))["calls"] == (1 if metric == "invocations" else 0)


async def test_old_generic_denial_does_not_invent_a_historical_request(repository):
    repo, _, work = await fixture_work(repository)
    work.status, work.error_code, work.limiting_metric = Status.BLOCKED, "BUDGET_EXHAUSTED", "exhausted"
    await repo.save(work)
    projection = await budget_view(repo, work.id)
    assert projection.denial.basis == "historical_unknown" and projection.denial.metric == "unknown"
    assert projection.denial.requested is None and projection.denial.required is None


async def test_revision_checked_amendment_survives_stale_checkpoint_and_stops_inflight_dispatch(repository):
    initial = BudgetPolicy(version=1)
    repo, _, work = await policy_work(repository, initial)
    work.status = Status.BLOCKED
    await repo.save(work)
    request = BudgetAmendment(version=1, expected_revision=0, metric="tokens", policy=bounded(None), reason="Owner authorizes uncapped cumulative tokens")
    updated = await repo.amend_budget(work.id, request)
    assert updated.budget.policy == initial and updated.effective_budget_policy.tokens.primary is None
    with pytest.raises(DomainError) as error:
        await repo.amend_budget(work.id, request)
    assert error.value.code == "STALE_BUDGET"
    with pytest.raises(DomainError) as error:
        await repo.check_dispatch_budget(work)
    assert error.value.code == "STALE_BUDGET"
    await repo.save(work)  # A late old graph checkpoint cannot erase the owner's receipt.
    reloaded = await repo.work(work.id)
    assert reloaded.budget_revision == 1 and reloaded.effective_budget_policy.tokens.primary is None
    assert len((await budget_view(repo, work.id)).authorizations) == 1


async def test_active_time_reserve_persists_across_reload_and_is_not_replenished(repository):
    initial = BudgetPolicy(version=1, active_seconds=MetricBudget(primary=1, reserve=1, absolute=2))
    repo, _, work = await policy_work(repository, initial)
    await repo.ensure_budget_metric(work, "active_seconds", 1.01)
    reloaded = await repo.work(work.id)
    assert reloaded.effective_budget_policy.active_seconds == bounded(2)
    with pytest.raises(DomainError) as error:
        await repo.ensure_budget_metric(reloaded, "active_seconds", 2.01)
    assert error.value.code == "BUDGET_ACTIVE_SECONDS"
    assert len((await budget_view(repo, work.id)).authorizations) == 1


async def test_owner_conservative_reconciliation_preserves_unknown_usage_and_full_reservation(repository):
    repo, _, work = await policy_work(repository, BudgetPolicy(version=1))
    usage_id = await repo.reserve_usage(work, 100, 0, 100)
    work.status = Status.BLOCKED
    await repo.save(work)
    assert len(await repo.unreconciled_usage(work.id)) == 1
    request = BudgetReconciliation(version=1, expected_revision=0, usage_ids=[usage_id], reason="Inspected checkpoint and retain all unknown consumption")
    updated = await repo.reconcile_budget_usage(work.id, request)
    assert updated.budget_revision == 1
    assert await repo.unreconciled_usage(work.id) == []
    usage = await repo.audit_usage(work.id)
    assert usage["unsettled_calls"] == 1 and usage["unknown_reserved_tokens"] == 100
    view = await budget_view(repo, work.id)
    assert view.metrics["tokens"].used is None and view.metrics["tokens"].reserved == 100
    assert view.authorizations[0].operation == "usage_reconciliation"
    with pytest.raises(DomainError) as error:
        await repo.reconcile_budget_usage(work.id, request)
    assert error.value.code == "STALE_BUDGET"
