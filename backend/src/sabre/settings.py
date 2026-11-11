import json
import os
import stat
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from sabre.models import DomainError
from sabre.notifications import WebhookDestination

RAW_SECRET_ENV = {
    "SABRE_DATABASE_URL", "SABRE_VAULT_DATABASE_URL", "SABRE_AUTH_TOKEN", "SABRE_EXECUTOR_TOKEN", "SABRE_GATEWAY_TOKEN",
    "SABRE_MODEL_API_KEY", "SABRE_GITHUB_TOKEN", "SABRE_GITHUB_READ_TOKEN", "SABRE_SLACK_BOT_TOKEN", "SABRE_SLACK_APP_TOKEN",
    "SABRE_DB_PASSWORD", "SABRE_DB_ADMIN_PASSWORD", "SABRE_VAULT_PASSWORD", "SABRE_VAULT_MASTER_KEY",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
    "LANGSMITH_API_KEY", "LANGCHAIN_API_KEY",
    "SABRE_CLAUDE_CLI_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
}
BOOTSTRAP_FIELDS = {
    "control": {"database_url", "vault_database_url", "auth_token", "executor_token", "gateway_token"},
    "broker": {"executor_token"},
    "gateway": {"gateway_token"},
}


def reject_secret_environment() -> None:
    names = {name.upper() for name in os.environ}
    if names & RAW_SECRET_ENV:
        raise DomainError("RAW_SECRET_ENV_FORBIDDEN", "Credentials must be loaded from private files or the vault, never environment variables", 503)
    if any(os.environ.get(name, "").lower() in {"1", "true", "yes", "on"} for name in ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING")):
        raise DomainError("EXTERNAL_TRACING_FORBIDDEN", "Agent content cannot be exported through automatic external tracing", 503)
    for variable, forbidden in (("SABRE_ROLE_MODELS", {"model_api_key", "api_key"}), ("SABRE_MCP_SERVERS", {"token", "api_key", "headers"})):
        raw = next((value for key, value in os.environ.items() if key.upper() == variable), None)
        if raw is None:
            continue
        try:
            public = json.loads(raw)
        except (TypeError, ValueError):
            raise DomainError("PUBLIC_CONFIGURATION_INVALID", "Public configuration must contain valid JSON without credentials", 503) from None
        if isinstance(public, dict) and any(isinstance(item, dict) and {str(key).lower() for key in item} & forbidden for item in public.values()):
            raise DomainError("RAW_SECRET_ENV_FORBIDDEN", "Public configuration must use secret_ref rather than credential values", 503)


def load_bootstrap(path: str | Path | None = None, kind: Literal["control", "broker", "gateway"] = "control") -> dict[str, str]:
    reject_secret_environment()
    selected = path or os.environ.get("SABRE_BOOTSTRAP_FILE")
    if selected is None:
        raise DomainError("BOOTSTRAP_REQUIRED", "The private bootstrap file for this service is missing", 503)
    try:
        file = Path(selected)
        descriptor = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or (os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.geteuid())):
                raise ValueError
            raw = stream.read(16385)
            if len(raw) > 16384:
                raise ValueError
            data = json.loads(raw)
        expected = BOOTSTRAP_FIELDS[kind]
        if not isinstance(data, dict) or type(data.get("format")) is not int or data["format"] != 1 or set(data) != expected | {"format"}:
            raise ValueError
        if any(not isinstance(data[name], str) or not data[name] for name in expected):
            raise ValueError
        return {name: data[name] for name in expected}
    except (OSError, TypeError, ValueError, KeyError):
        raise DomainError("BOOTSTRAP_INVALID", "The bootstrap file must be private, valid and exclusive to this service", 503) from None


class MCPToolSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    roles: set[Literal["supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security"]]
    effect: Literal["read"] = "read"
    timeout_s: int = Field(default=60, ge=1, le=300)


class MCPServerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    endpoint: str
    token: SecretStr = Field(default=SecretStr(""), exclude=True, repr=False)
    secret_ref: str | None = None
    tools: dict[str, MCPToolSettings]
    tool_digests: dict[str, str] = Field(default_factory=dict)


class RoleModelSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    model_provider: Literal["openai", "local", "anthropic", "google", "codex_cli", "claude_cli"] | None = None
    model_name: str | None = None
    model_base_url: str | None = None
    model_api_key: SecretStr | None = Field(default=None, exclude=True, repr=False)
    secret_ref: str | None = None
    model_input_usd_per_million: float | None = Field(default=None, ge=0)
    model_output_usd_per_million: float | None = Field(default=None, ge=0)
    model_max_output_tokens: int | None = Field(default=None, ge=128, le=32768)
    supports_tools: bool = True
    supports_structured_output: bool = True




class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SABRE_", extra="ignore", hide_input_in_errors=True)
    bootstrap_file: Path | None = None
    vault_master_key_file: Path | None = None
    database_url: SecretStr = Field(exclude=True, repr=False)
    vault_database_url: SecretStr = Field(default=SecretStr(""), exclude=True, repr=False)
    auth_token: SecretStr = Field(min_length=24, exclude=True, repr=False)
    executor_url: str = "http://executor:8090"
    executor_token: SecretStr = Field(min_length=24, exclude=True, repr=False)
    gateway_token: SecretStr = Field(default=SecretStr(""), exclude=True, repr=False)
    data_dir: Path = Path("/data")
    model_provider: Literal["openai", "local", "anthropic", "google", "codex_cli", "claude_cli"] = "openai"
    model_configuration_revision: int | None = Field(default=None, exclude=True, ge=0)
    codex_cli_url: Literal["http://codex-runner:8091"] = "http://codex-runner:8091"
    codex_cli_token_file: Path = Path("/run/secrets/codex-bridge/token")
    claude_cli_url: Literal["http://claude-runner:8092"] = "http://claude-runner:8092"
    claude_cli_token_file: Path = Path("/run/secrets/claude-bridge/token")
    model_name: str = ""
    model_base_url: str | None = None
    model_api_key: SecretStr = Field(default=SecretStr(""), exclude=True, repr=False)
    model_secret_ref: str | None = None
    model_input_usd_per_million: float = Field(default=0, ge=0)
    model_output_usd_per_million: float = Field(default=0, ge=0)
    monthly_budget_usd: float = Field(default=0, ge=0)
    model_max_output_tokens: int = Field(default=4096, ge=128, le=32768)
    context_dedup_enabled: bool = True
    context_dedup_trigger_bytes: int = Field(default=65536, ge=8192, le=4194304)
    context_dedup_min_result_bytes: int = Field(default=4096, ge=1024, le=1048576)
    context_dedup_keep_model_turns: int = Field(default=2, ge=2, le=20)
    context_archive_enabled: bool = True
    context_input_max_bytes: int = Field(default=98304, ge=16384, le=1048576)
    github_token: SecretStr = Field(default=SecretStr(""), exclude=True, repr=False)
    slack_bot_token: SecretStr = Field(default=SecretStr(""), exclude=True, repr=False)
    slack_app_token: SecretStr = Field(default=SecretStr(""), exclude=True, repr=False)
    slack_owner_id: str = ""
    webhooks: dict[str, WebhookDestination] = Field(default_factory=dict)
    execution_slots: int = Field(default=2, ge=1, le=16)
    embedding_model: str = ""
    embedding_usd_per_million: float = Field(default=0, ge=0)
    chat_budget_usd: float = Field(default=0.25, gt=0)
    api_url: str = "http://api:8000"
    panel_origin: str = "http://127.0.0.1:8000"
    panel_session_days: int = Field(default=30, ge=1, le=90)
    mcp_servers: dict[str, MCPServerSettings] = Field(default_factory=dict)
    role_models: dict[str, RoleModelSettings] = Field(default_factory=dict)
    otlp_endpoint: str | None = None
    web_dir: Path = Path("/app/web/dist")
    allowed_origins: list[str] = ["http://localhost:8000", "http://127.0.0.1:8000", "http://localhost:5173", "http://127.0.0.1:5173"]

    def __init__(self, **values):
        reject_secret_environment()
        bootstrap = values.get("bootstrap_file") or os.environ.get("SABRE_BOOTSTRAP_FILE")
        if bootstrap:
            private = load_bootstrap(bootstrap)
            values = {**private, **values}
            values.setdefault("bootstrap_file", Path(bootstrap))
        super().__init__(**values)

    def for_role(self, role: str):
        override = self.role_models.get(role)
        if not override:
            return self
        if not override.supports_tools or not override.supports_structured_output:
            from sabre.models import DomainError
            raise DomainError("MODEL_CAPABILITIES", "The model for this role requires tools and structured output")
        updates = {name: getattr(override, name) for name in type(override).model_fields if name.startswith("model_") and getattr(override, name) is not None}
        if override.secret_ref is not None:
            updates["model_secret_ref"] = override.secret_ref
            if override.model_api_key is None:
                updates["model_api_key"] = SecretStr("")
        if override.model_provider is not None and override.model_provider != self.model_provider:
            # Credentials and endpoints belong to their explicitly selected destination.
            updates["model_api_key"] = override.model_api_key or SecretStr("")
            updates["model_base_url"] = override.model_base_url
            updates["model_name"] = override.model_name or ""
            updates["model_input_usd_per_million"] = override.model_input_usd_per_million if override.model_input_usd_per_million is not None else 0
            updates["model_output_usd_per_million"] = override.model_output_usd_per_million if override.model_output_usd_per_million is not None else 0
        return self.model_copy(update=updates)

    def model_ready(self) -> bool:
        if self.model_provider in {"codex_cli", "claude_cli"}:
            return not self.model_base_url
        if not self.model_name:
            return False
        if self.model_provider == "local":
            return bool(self.model_base_url)
        return self.monthly_budget_usd > 0 and bool(self.model_api_key.get_secret_value()) and self.model_input_usd_per_million > 0 and self.model_output_usd_per_million > 0


@lru_cache
def settings() -> Settings:
    return Settings()
