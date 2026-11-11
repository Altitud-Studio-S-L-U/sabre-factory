import pytest
from pydantic import ValidationError

from sabre.budget_contracts import BudgetPolicy, MetricBudget, activate_reserve, bounded, legacy_policy
from sabre.models import Budget, DomainError

pytest_plugins = ["tests.test_factory_workflow"]


def test_each_metric_can_be_uncapped_independently_and_spend_stays_separate():
    for metric in ("tokens", "invocations", "active_seconds", "repairs"):
        policy = BudgetPolicy(version=1)
        setattr(policy, metric, bounded(None))
        budget = Budget(policy=policy, max_cost_usd=0)
        assert getattr(budget.policy, metric).primary is None
        assert budget.max_cost_usd == 0 and not budget.progress_limits
    assert Budget(max_calls=None, max_tokens=None, active_seconds=None).progress_limits
    with pytest.raises(ValidationError):
        Budget(max_calls=None)


@pytest.mark.parametrize("data", [
    {"primary": None, "reserve": 2, "absolute": None},
    {"primary": 2, "reserve": 2, "absolute": 10},
    {"primary": "2", "reserve": 0, "absolute": 2},
    {"primary": True, "reserve": 0, "absolute": 1},
    {"primary": -1, "reserve": 0, "absolute": -1},
])
def test_reserve_is_finite_explicit_and_strict(data):
    with pytest.raises(ValidationError):
        MetricBudget.model_validate(data)


def test_reserve_activation_never_replenishes_and_zero_repairs_means_no_repairs():
    initial = MetricBudget(primary=2, reserve=3, absolute=5)
    activated = activate_reserve(initial, 3)
    assert activated == bounded(5)
    assert activate_reserve(activated, 6) is None
    assert initial.primary == 2 and initial.reserve == 3
    assert activate_reserve(bounded(0), 1) is None
    assert activate_reserve(bounded(None), 1000000000).primary is None


def test_legacy_launch_adapter_pins_original_default_caps_and_independent_repair_policy():
    budget = Budget()
    policy = legacy_policy(budget, 2)
    assert policy == BudgetPolicy(version=1)
    budget.max_tokens = 200000
    assert policy.tokens.primary == 100000
    cli = legacy_policy(Budget(max_calls=None, max_tokens=None, active_seconds=None), 0)
    assert all(getattr(cli, metric).primary is None for metric in ("tokens", "invocations", "active_seconds"))
    assert cli.repairs.primary == 0


async def apply_metric(work, metric, required):
    before = getattr(work.effective_budget_policy, metric)
    after = activate_reserve(before, required)
    if after is None:
        raise DomainError("BUDGET_" + metric.upper(), "Metric exhausted", 409)
    setattr(work.effective_budget_policy, metric, after)


@pytest.mark.parametrize("repairs,expected_attempts", [(0, 1), (1, 2)])
async def test_runtime_repairs_obey_independent_zero_and_one_cycle_policies(build_factory, repairs, expected_attempts):
    factory, repo, team, _, _, publisher = build_factory(failures=20)
    repo.current.budget.policy = BudgetPolicy(version=1, repairs=bounded(repairs))
    repo.current.effective_budget_policy = repo.current.budget.policy.model_copy(deep=True)
    repo.ensure_budget_metric = apply_metric
    result = await factory.drive(repo.current.id)
    assert result.error_code == "BUDGET_REPAIRS"
    assert team.calls.count("developer") == expected_attempts
    assert not publisher.calls


async def test_uncapped_repairs_stop_on_identical_evidence_without_using_agent_prose(build_factory):
    factory, repo, team, _, _, publisher = build_factory(failures=20)
    repo.current.budget.policy = BudgetPolicy(version=1, repairs=bounded(None))
    repo.current.effective_budget_policy = repo.current.budget.policy.model_copy(deep=True)
    repo.ensure_budget_metric = apply_metric
    result = await factory.drive(repo.current.id)
    assert result.error_code == "NO_PROGRESS"
    assert result.repair_cycles_used == 2
    assert team.calls.count("developer") == 3
    assert not publisher.calls
