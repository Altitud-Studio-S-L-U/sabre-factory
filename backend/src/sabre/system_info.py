"""Owner-facing runtime inventory; configuration is not a health check."""

import platform
from importlib import metadata
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit

from pydantic import ConfigDict, Field

from sabre.models import AwareTimestamp, Contract, now
from sabre.settings import Settings
from sabre.workflows import GRAPH_VERSION

PACKAGES = (
    "fastapi", "pydantic", "langgraph", "langchain", "langgraph-checkpoint-postgres",
    "mcp", "procrastinate", "psycopg", "pgvector", "opentelemetry-sdk",
    "opentelemetry-exporter-otlp-proto-http",
)


class StatusSource(Protocol):
    async def status(self) -> dict[str, Any]: ...


class ApplicationInfo(Contract):
    name: Literal["SABRE"] = "SABRE"
    version: str | None
    graph_version: str


class RuntimeInfo(Contract):
    python: str
    implementation: str
    system: str
    architecture: str


class PackageVersion(Contract):
    distribution: str
    version: str | None


class SystemComponent(Contract):
    id: Literal["api", "database", "worker", "executor", "codex", "claude", "github", "slack", "memory", "security", "telemetry"]
    label: str
    configured: bool | None
    state: Literal["available", "unavailable", "busy", "unknown"]
    detail: str


class SystemLimits(Contract):
    concurrent_work: int = Field(ge=1)
    writers_per_repository: int = Field(ge=1)
    repair_cycles: int = Field(ge=0)
    codex_invocations: int | None = Field(ge=1)
    claude_invocations: int | None = Field(default=None, ge=1)


class RoleModelInfo(Contract):
    role: Literal["supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security"]
    provider: str
    name: str
    configured: bool | None


class SystemInfo(Contract):
    # runtime_settings is newer than existing clients; keep it optional in the response schema.
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)
    checked_at: AwareTimestamp
    application: ApplicationInfo
    runtime: RuntimeInfo
    packages: list[PackageVersion]
    components: list[SystemComponent]
    limits: SystemLimits
    models: list[RoleModelInfo]
    runtime_settings: RuntimeSettings | None = Field(default=None, description="Non-secret runtime configuration; null when unavailable")


def installed_version(distribution: str) -> str | None:
    try:
        return metadata.version(distribution)
    except metadata.PackageNotFoundError:
        return None


async def system_info(service: StatusSource) -> SystemInfo:
    # One existing bounded probe. The UI requests this on entry or explicit refresh, never on a timer.
    status = await service.status()
    selected_providers = {status["model"]["provider"], *(role["provider"] for role in status["roles"].values())}
    runners = dict(status.get("runners", {}))
    if status["model"].get("cli") is not None:
        runners.setdefault(status["model"]["provider"], status["model"]["cli"])
    components = [
        SystemComponent(id="api", label="SABRE API", configured=True, state="available",
                        detail="The API responded to this query; this does not establish the health of all services."),
        SystemComponent(id="database", label="PostgreSQL", configured=True,
                        state="available" if status["database"] == "connected" else "unavailable",
                        detail="Result of the database connectivity query."),
        SystemComponent(id="worker", label="Background worker", configured=None, state="unknown",
                        detail="This query does not check the worker process or queue progress."),
        SystemComponent(id="executor", label="Isolated executor", configured=None, state="unknown",
                        detail="This query does not execute tools or check job containers."),
    ]
    for provider, identifier, label, account in (("codex_cli", "codex", "Codex", "ChatGPT"), ("claude_cli", "claude", "Claude", "Claude personal")):
        if provider not in selected_providers:
            continue
        cli = runners.get(provider)
        available = bool(cli and cli.get("available") is True)
        authenticated = bool(cli and cli.get("authenticated") is True)
        busy = bool(cli and cli.get("busy") is True)
        components.append(SystemComponent(
            id=identifier, label=f"{label} CLI", configured=authenticated if not busy else None,
            state="busy" if busy else "available" if available else "unavailable",
            detail="The runner is busy; the session is not checked again during inference." if busy else
                   f"The runner responds and its session for {account} is authenticated." if available and authenticated else
                   f"The runner responds, but has no authenticated session for {account}." if available else
                   f"Could not confirm runner availability for {label}.",
        ))
    integrations: tuple[tuple[Literal["github", "slack"], str], ...] = (("github", "GitHub"), ("slack", "Slack"))
    for identifier, label in integrations:
        components.append(SystemComponent(id=identifier, label=label, configured=status[identifier]["configured"],
                                          state="unknown", detail="Configuration recorded; no request has been made to this service."))
    components.extend([
        SystemComponent(id="memory", label="Project memory", configured=True, state="unknown",
                        detail="PostgreSQL and pgvector; semantic search is configured. Retrieval has not been tested." if status["memory"]["semantic_search"] else
                               "PostgreSQL and pgvector; semantic search is not configured. Retrieval has not been tested."),
        SystemComponent(id="security", label="Security pipeline", configured=True, state="unknown",
                        detail="Required scanners block on failure. This query does not verify their execution or database freshness."),
        SystemComponent(id="telemetry", label="OpenTelemetry", configured=status["telemetry"]["configured"], state="unknown",
                        detail="The destination is configured; trace reception has not been checked." if status["telemetry"]["configured"] else
                               "No trace export destination is configured."),
    ])
    return SystemInfo(
        checked_at=now(),
        application=ApplicationInfo(version=installed_version("sabre-factory"), graph_version=GRAPH_VERSION),
        runtime=RuntimeInfo(python=platform.python_version(), implementation=platform.python_implementation(),
                            system=platform.system(), architecture=platform.machine()),
        packages=[PackageVersion(distribution=name, version=installed_version(name)) for name in PACKAGES],
        components=components,
        limits=SystemLimits(**status["limits"], codex_invocations=1 if "codex_cli" in selected_providers else None,
                            claude_invocations=1 if "claude_cli" in selected_providers else None),
        models=[RoleModelInfo(role=role, provider=value["provider"], name=value["name"],
                              configured=None if runners.get(value["provider"], {}).get("busy") is True else value["configured"])
                for role in ("supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security")
                if (value := status["roles"].get(role))],
        runtime_settings=runtime_settings(config) if isinstance(config := getattr(service, "config", None), Settings) else None,
    )


class IntegerSetting(Contract):
    value: int
    env_var: str | None = Field(description="Environment variable that sets it; null when fixed in code")


class NumberSetting(Contract):
    value: float
    env_var: str | None


class TextSetting(Contract):
    value: str
    env_var: str | None


class TextListSetting(Contract):
    value: list[str]
    env_var: str | None


class TelemetrySetting(Contract):
    configured: bool
    host: str | None = Field(description="Host and port of the OTLP destination; never its path, query or credentials")
    env_var: str


class SandboxLimits(Contract):
    memory: TextSetting
    cpus: NumberSetting
    pids: IntegerSetting
    default_timeout_s: IntegerSetting
    max_timeout_s: IntegerSetting
    network_default: TextSetting


class RuntimeSettings(Contract):
    """Non-secret runtime configuration and where each value comes from."""

    execution_slots: IntegerSetting
    panel_session_days: IntegerSetting
    allowed_origins: TextListSetting
    monthly_budget_usd: NumberSetting
    chat_budget_usd: NumberSetting
    webhooks: TextListSetting = Field(description="Configured webhook names only; endpoints are never returned")
    otlp: TelemetrySetting
    sandbox: SandboxLimits


def endpoint_host(endpoint: str | None) -> str | None:
    if not endpoint:
        return None
    try:
        parts = urlsplit(endpoint)
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if not host:
        return None
    return f"[{host}]:{port}" if port and ":" in host else f"{host}:{port}" if port else host


def runtime_settings(config) -> RuntimeSettings:
    from sabre import executor
    return RuntimeSettings(
        execution_slots=IntegerSetting(value=config.execution_slots, env_var="SABRE_EXECUTION_SLOTS"),
        panel_session_days=IntegerSetting(value=config.panel_session_days, env_var="SABRE_PANEL_SESSION_DAYS"),
        allowed_origins=TextListSetting(value=list(config.allowed_origins), env_var="SABRE_ALLOWED_ORIGINS"),
        monthly_budget_usd=NumberSetting(value=config.monthly_budget_usd, env_var="SABRE_MONTHLY_BUDGET_USD"),
        chat_budget_usd=NumberSetting(value=config.chat_budget_usd, env_var="SABRE_CHAT_BUDGET_USD"),
        webhooks=TextListSetting(value=sorted(config.webhooks), env_var="SABRE_WEBHOOKS"),
        otlp=TelemetrySetting(configured=bool(config.otlp_endpoint), host=endpoint_host(config.otlp_endpoint), env_var="SABRE_OTLP_ENDPOINT"),
        sandbox=SandboxLimits(
            memory=TextSetting(value=executor.SANDBOX_MEMORY, env_var=None),
            cpus=NumberSetting(value=executor.SANDBOX_NANO_CPUS / 1_000_000_000, env_var=None),
            pids=IntegerSetting(value=executor.SANDBOX_PIDS, env_var=None),
            default_timeout_s=IntegerSetting(value=executor.COMMAND_TIMEOUT_DEFAULT_S, env_var=None),
            max_timeout_s=IntegerSetting(value=executor.COMMAND_TIMEOUT_MAX_S, env_var=None),
            network_default=TextSetting(value="none", env_var=None)),
    )
SystemInfo.model_rebuild()
