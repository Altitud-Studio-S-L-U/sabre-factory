from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from sabre.models import DomainError
from sabre.supervisor import ChatGuard
from tests.test_slack import service


@pytest.mark.parametrize("provider", ["openai", "anthropic", "google"])
@pytest.mark.parametrize("field,value,expected", [
    ("model_input_usd_per_million", 0, "MODEL_PRICING_REQUIRED"),
    ("model_input_usd_per_million", None, "MODEL_PRICING_REQUIRED"),
    ("model_output_usd_per_million", 0, "MODEL_PRICING_REQUIRED"),
    ("model_output_usd_per_million", float("nan"), "MODEL_PRICING_REQUIRED"),
    ("monthly_budget_usd", 0, "API_BUDGET_REQUIRED"),
    ("chat_budget_usd", 0, "API_BUDGET_REQUIRED"),
])
async def test_paid_conversation_rejects_unknown_prices_or_missing_allowance_before_any_dispatch(provider, field, value, expected):
    owner = service()
    owner.config.model_provider = provider
    setattr(owner.config, field, value)
    credentials, provider_call = AsyncMock(), AsyncMock()
    guard = ChatGuard(owner.repository, owner.config, owner.guard, "message", credential_check=credentials)
    request = SimpleNamespace(messages=[HumanMessage(content="Inspect current status")], tools=[], system_message=None)
    with pytest.raises(DomainError) as error:
        await guard.awrap_model_call(request, provider_call)
    assert error.value.code == expected
    assert owner.repository.reservations == []
    credentials.assert_not_awaited()
    provider_call.assert_not_awaited()


@pytest.mark.parametrize("provider", ["codex_cli", "claude_cli"])
async def test_cli_conversation_keeps_zero_api_spend_without_paid_pricing(provider):
    owner = service()
    owner.config.model_provider = provider
    owner.config.model_input_usd_per_million = owner.config.model_output_usd_per_million = 0
    owner.config.monthly_budget_usd = owner.config.chat_budget_usd = 0
    provider_call = AsyncMock(return_value=SimpleNamespace(result=[AIMessage(content="Observed status", usage_metadata={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2})]))
    guard = ChatGuard(owner.repository, owner.config, owner.guard, "message")
    await guard.awrap_model_call(SimpleNamespace(messages=[HumanMessage(content="Inspect status")], tools=[], system_message=None), provider_call)
    assert len(owner.repository.reservations) == 1
    assert owner.repository.reservations[0][2] == 0
    assert owner.repository.settled[0][2] == 0
