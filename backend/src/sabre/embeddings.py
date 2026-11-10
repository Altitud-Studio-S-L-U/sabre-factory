from langchain_openai import OpenAIEmbeddings
from pydantic import SecretStr

from sabre.error_boundaries import guarded_call
from sabre.model_providers import OPENAI_BASE_URL
from sabre.models import DomainError, WorkOrder, new_id
from sabre.telemetry import span


class BudgetedEmbeddings:
    def __init__(self, repository, config, guard, credentials=None):
        if config.model_provider not in {"openai", "local"}:
            raise DomainError("EMBEDDING_PROVIDER_UNSUPPORTED", "Embeddings require an explicitly configured OpenAI or local provider")
        self.repository, self.config, self.guard = repository, config, guard
        self.credentials = credentials
        self.model = self._model(config)

    @staticmethod
    def _model(config):
        if config.model_provider != "local" and config.model_base_url:
            raise DomainError("PROVIDER_POLICY", "A custom endpoint must be configured as an explicit local provider")
        return OpenAIEmbeddings.model_validate({"model": config.embedding_model, "dimensions": 1536,
            "api_key": config.model_api_key if config.model_api_key.get_secret_value() else SecretStr("local-no-key"),
            "base_url": config.model_base_url if config.model_provider == "local" else OPENAI_BASE_URL,
            "max_retries": 0, "timeout": 60})

    async def aembed_query(self, text: str, *, work: WorkOrder | None = None):
        with span("model.call", role="memory") as observation:
            return await self._embed(text, observation, work)

    async def _embed(self, text: str, observation, work: WorkOrder | None):
        revision = await self.credentials.refresh() if self.credentials else None
        self.guard.check(text)
        cfg = self.config.model_copy(deep=True) if self.credentials else self.config
        if cfg.model_provider != "local" and not cfg.model_api_key.get_secret_value():
            raise DomainError("EMBEDDING_NOT_CONFIGURED", "Configure the embedding provider credential")
        if cfg.model_provider != "local" and (cfg.monthly_budget_usd <= 0 or cfg.embedding_usd_per_million <= 0):
            raise DomainError("EMBEDDING_BUDGET", "Configure the embedding budget and price")
        token_bound = len(text.encode()) + 64
        usd = token_bound * cfg.embedding_usd_per_million / 1_000_000
        if work is None:
            await self.repository.reserve_chat_usage("embedding:" + new_id(), token_bound, usd, cfg.monthly_budget_usd, max(usd, 0.01))
        else:
            await self.repository.reserve_usage(work, token_bound, usd, cfg.monthly_budget_usd)
        observation.set(reserved_tokens=token_bound, reserved_usd=usd)
        model = self._model(cfg) if self.credentials else self.model
        if self.credentials:
            await self.credentials.assert_current(revision)
        vector = await guarded_call(model.aembed_query, self.guard, "EMBEDDING_PROVIDER_FAILED", text)
        if self.credentials:
            await self.credentials.assert_current(revision)
        if len(vector) != 1536:
            raise DomainError("EMBEDDING_DIMENSION", "The model does not return 1536-dimensional vectors")
        # Embedding providers do not all report actual usage; keep the conservative reservation.
        return vector
