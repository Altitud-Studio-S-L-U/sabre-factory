"""Explicit chat integrations; provider changes never select another destination implicitly."""

import os

from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from sabre.models import DomainError

OPENAI_BASE_URL = "https://api.openai.com/v1"
ANTHROPIC_BASE_URL = "https://api.anthropic.com"
GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com"


def chat_model(config):
    provider = config.model_provider
    if provider == "claude_cli":
        from sabre.claude_model import ClaudeChatModel
        if config.model_base_url:
            raise DomainError("PROVIDER_POLICY", "Claude CLI requiere el ejecutor aislado autorizado")
        return ClaudeChatModel(model_name=config.model_name, runner_url=config.claude_cli_url,
            token_file=config.claude_cli_token_file)
    if provider == "codex_cli":
        from sabre.codex_model import CodexChatModel
        if config.model_base_url:
            raise DomainError("PROVIDER_POLICY", "Codex CLI requiere el ejecutor aislado autorizado")
        return CodexChatModel(model_name=config.model_name, runner_url=config.codex_cli_url,
            token_file=config.codex_cli_token_file)
    if provider not in {"openai", "local", "anthropic", "google"}:
        raise DomainError("PROVIDER_UNSUPPORTED", "This provider requires an enabled integration")
    if provider != "local" and config.model_base_url:
        raise DomainError("PROVIDER_POLICY", "A custom endpoint must be configured as an explicit local provider")
    if not config.model_ready():
        raise DomainError("MODEL_NOT_CONFIGURED", "Configure the model, credential, prices and limits before running")
    key = config.model_api_key
    if provider in {"openai", "local"}:
        return ChatOpenAI(model=config.model_name, api_key=key if key.get_secret_value() else SecretStr("local-no-key"),
            base_url=config.model_base_url if provider == "local" else OPENAI_BASE_URL, timeout=120, max_retries=0,
            max_completion_tokens=config.model_max_output_tokens, use_responses_api=provider == "openai")
    if provider == "anthropic":
        return ChatAnthropic(model=config.model_name, api_key=key, max_tokens=config.model_max_output_tokens,
            base_url=ANTHROPIC_BASE_URL, timeout=120, max_retries=0)
    # This SDK reads the flag again even when LangChain receives vertexai=False.
    if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in {"1", "true"}:
        raise DomainError("PROVIDER_POLICY", "The Google provider requires the approved GenAI destination, without Vertex environment configuration")
    return ChatGoogleGenerativeAI(model=config.model_name, google_api_key=key,
        base_url=GOOGLE_BASE_URL, vertexai=False,
        max_output_tokens=config.model_max_output_tokens, timeout=120, max_retries=0)
