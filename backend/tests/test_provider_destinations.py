import pytest

from sabre.embeddings import BudgetedEmbeddings
from sabre.model_providers import chat_model
from sabre.models import DomainError
from sabre.security import SecretGuard
from tests.test_model_providers import configured


@pytest.mark.parametrize("provider,variable,expected", [
    ("openai", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
    ("openai", "OPENAI_API_BASE", "https://api.openai.com/v1"),
    ("anthropic", "ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
    ("google", "GOOGLE_GEMINI_BASE_URL", "https://generativelanguage.googleapis.com"),
])
def test_hosted_provider_keeps_its_official_destination_despite_sdk_environment(monkeypatch, provider, variable, expected):
    monkeypatch.setenv(variable, "https://synthetic-unapproved-gateway.invalid/v1")
    model = chat_model(configured(provider))
    if provider == "openai":
        urls = [model.root_client.base_url, model.root_async_client.base_url]
    elif provider == "anthropic":
        urls = [model._client.base_url, model._async_client.base_url]
    else:
        urls = [model.client._api_client._http_options.base_url]
        assert not model.client._api_client.vertexai
    assert all(str(url).rstrip("/") == expected for url in urls)


def test_google_hosted_configuration_cannot_silently_enable_vertex_via_environment(monkeypatch):
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    with pytest.raises(DomainError) as error:
        chat_model(configured("google"))
    assert error.value.code == "PROVIDER_POLICY"


@pytest.mark.parametrize("variable", ["OPENAI_BASE_URL", "OPENAI_API_BASE"])
def test_embedding_credential_keeps_official_openai_destination(monkeypatch, variable):
    monkeypatch.setenv(variable, "https://synthetic-unapproved-gateway.invalid/v1")
    embeddings = BudgetedEmbeddings(None, configured("openai", embedding_model="fixture-embedding"), SecretGuard())
    assert str(embeddings.model.client._client.base_url).rstrip("/") == "https://api.openai.com/v1"
    assert str(embeddings.model.async_client._client.base_url).rstrip("/") == "https://api.openai.com/v1"


def test_local_provider_uses_only_its_explicit_destination(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://synthetic-unapproved-gateway.invalid/v1")
    monkeypatch.setenv("OPENAI_API_BASE", "https://synthetic-unapproved-gateway.invalid/v1")
    model = chat_model(configured("local"))
    assert str(model.root_client.base_url).rstrip("/") == "http://127.0.0.1:8899/v1"
