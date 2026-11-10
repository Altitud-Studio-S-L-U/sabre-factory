from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from sabre.models import Budget, DomainError, WorkOrderCreate
from sabre.security import SecretGuard
from sabre.service import FactoryService


def test_progress_policy_preserves_default_caps_and_allows_only_explicit_zero_cost_cli_mode():
    assert Budget().model_dump() == {"max_calls": 40, "max_tokens": 100000, "max_cost_usd": 0, "active_seconds": 3600}
    budget = Budget(max_calls=None, max_tokens=None, active_seconds=None, max_cost_usd=0)
    assert Budget.model_validate_json(budget.model_dump_json()) == budget


@pytest.mark.parametrize("overrides", [
    {"max_calls": None}, {"max_tokens": None}, {"active_seconds": None},
    {"max_calls": None, "max_tokens": None, "active_seconds": None, "max_cost_usd": 0.01},
])
def test_partial_or_paid_unbounded_budgets_are_invalid(overrides):
    with pytest.raises(ValidationError):
        Budget(**overrides)


@pytest.mark.parametrize("provider", ["claude_cli", "openai"])
async def test_new_progress_work_requires_cli_selection_before_admission(provider, monkeypatch):
    from sabre.flow_contracts import ResolvedFlow, ResolvedPhase
    from sabre.model_selection import DESTINATIONS, ModelSelection
    monkeypatch.setattr("sabre.flows.resolve_flow", AsyncMock(return_value=ResolvedFlow(model_revision=0, phases={"analysis": ResolvedPhase(role="analyst", model=ModelSelection(provider=provider, name="synthetic-model", destination=DESTINATIONS[provider]), credential_target=None, skills={})}, configuration_digest="a" * 64)))
    repository = SimpleNamespace(project=AsyncMock(), admit=AsyncMock())
    selected = SimpleNamespace(revision=0, default=SimpleNamespace(provider="codex_cli"),
        roles=[SimpleNamespace(effective=SimpleNamespace(provider=provider))])
    queue = SimpleNamespace(model_configuration=SimpleNamespace(get=AsyncMock(return_value=selected)), credentials=object())
    service = FactoryService(repository, None, None, queue, SecretGuard(), None)
    service._runner_status = AsyncMock(return_value={"available": True, "authenticated": True})
    request = WorkOrderCreate(project_id="project", mode="patch", objective="Correct the fixture", acceptance=["Valid output"],
        budget=Budget(max_calls=None, max_tokens=None, active_seconds=None), idempotency_key="synthetic-admission")
    if provider == "openai":
        with pytest.raises(DomainError) as error:
            await service.submit(request)
        assert error.value.code == "MODEL_LIMITS_REQUIRED"
        repository.admit.assert_not_awaited()
    else:
        await service.submit(request)
        assert repository.admit.await_args.args[0].budget == request.budget
