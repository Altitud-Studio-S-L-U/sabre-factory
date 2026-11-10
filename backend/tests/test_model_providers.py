import pytest
from langchain.agents import create_agent
from langchain_core.tools import tool
from pydantic import ValidationError

from sabre.embeddings import BudgetedEmbeddings
from sabre.model_providers import chat_model
from sabre.models import AgentResult, DomainError
from sabre.security import SecretGuard
from sabre.settings import RoleModelSettings, Settings


def configured(provider, **changes):
    values = {"database_url": "postgresql://synthetic", "auth_token": "synthetic-auth-token-123456",
        "executor_token": "synthetic-executor-token-123456", "model_provider": provider,
        "model_name": {"openai": "gpt-fixture", "local": "fixture", "anthropic": "claude-fixture", "google": "gemini-fixture"}[provider],
        "model_api_key": "synthetic-provider-key-123456", "monthly_budget_usd": 10,
        "model_input_usd_per_million": 1, "model_output_usd_per_million": 2,
        "model_max_output_tokens": 128}
    if provider == "local":
        values["model_base_url"] = "http://127.0.0.1:8899/v1"
    values.update(changes)
    return Settings(**values)


@tool
def fixture_status() -> str:
    """Read fixture status without any external request."""
    return "ready"


@pytest.mark.parametrize("provider", ["openai", "local", "anthropic", "google"])
def test_real_provider_integrations_bind_tools_and_agent_result_without_network(provider):
    model = chat_model(configured(provider))
    assert model.bind_tools([fixture_status]) is not None
    assert model.with_structured_output(AgentResult) is not None
    graph = create_agent(model=model, tools=[fixture_status], response_format=AgentResult)
    assert "model" in graph.nodes


@pytest.mark.parametrize("provider", ["openai", "anthropic", "google"])
@pytest.mark.parametrize("missing", ["model_api_key", "monthly_budget_usd", "model_input_usd_per_million", "model_output_usd_per_million"])
def test_paid_providers_require_credentials_prices_and_budget(provider, missing):
    config = configured(provider, **{missing: "" if missing == "model_api_key" else 0})
    with pytest.raises(DomainError) as error:
        chat_model(config)
    assert error.value.code == "MODEL_NOT_CONFIGURED"


@pytest.mark.parametrize("provider", ["openai", "anthropic", "google"])
def test_custom_destination_requires_explicit_local_provider(provider):
    with pytest.raises(DomainError) as error:
        chat_model(configured(provider, model_base_url="http://127.0.0.1:8899/v1"))
    assert error.value.code == "PROVIDER_POLICY"


def test_role_specific_provider_uses_its_explicit_credentials_and_limits():
    config = configured("openai", role_models={"security": RoleModelSettings(model_provider="anthropic", model_name="claude-fixture", model_api_key="separate-synthetic-role-key", model_max_output_tokens=256, model_input_usd_per_million=3, model_output_usd_per_million=9)})
    model = chat_model(config.for_role("security"))
    assert model.anthropic_api_key.get_secret_value() == "separate-synthetic-role-key"
    assert model.max_tokens == 256
    assert config.model_api_key.get_secret_value() != model.anthropic_api_key.get_secret_value()


@pytest.mark.parametrize("provider", ["anthropic", "google"])
def test_provider_change_never_reuses_the_other_providers_key(provider):
    config = configured("openai", role_models={"security": RoleModelSettings(model_provider=provider, model_name="fixture")})
    role = config.for_role("security")
    assert not role.model_api_key.get_secret_value()
    with pytest.raises(DomainError) as error:
        chat_model(role)
    assert error.value.code == "MODEL_NOT_CONFIGURED"


@pytest.mark.parametrize("missing", ["model_name", "model_input_usd_per_million", "model_output_usd_per_million"])
def test_provider_change_requires_its_own_model_and_both_prices(missing):
    values = {"model_provider": "anthropic", "model_name": "claude-fixture", "model_api_key": "separate-synthetic-role-key", "model_input_usd_per_million": 3, "model_output_usd_per_million": 9}
    values.pop(missing)
    config = configured("openai", role_models={"security": RoleModelSettings(**values)})
    role = config.for_role("security")
    assert getattr(role, missing) in {"", 0}
    with pytest.raises(DomainError) as error:
        chat_model(role)
    assert error.value.code == "MODEL_NOT_CONFIGURED"


@pytest.mark.parametrize("provider", ["anthropic", "google"])
def test_chat_provider_does_not_send_embedding_credentials_to_openai(provider):
    with pytest.raises(DomainError) as error:
        BudgetedEmbeddings(None, configured(provider), SecretGuard())
    assert error.value.code == "EMBEDDING_PROVIDER_UNSUPPORTED"


def test_unregistered_provider_is_rejected_at_configuration():
    with pytest.raises(ValidationError):
        configured("openai", model_provider="unregistered")
