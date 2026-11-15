"""Owner-approved model destinations, shared by all control processes."""

from typing import Literal

from psycopg.types.json import Jsonb
from pydantic import Field, model_validator

from sabre.model_selection import DESTINATIONS, ModelSelection
from sabre.models import Contract, DomainError
from sabre.settings import RoleModelSettings

Role = Literal["supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security"]
ROLES: tuple[Role, ...] = ("supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security")

MODEL_CONFIGURATION_SCHEMA = """
CREATE TABLE IF NOT EXISTS model_configuration (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    revision integer NOT NULL CHECK(revision>0), data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS model_configuration_events (
    revision integer PRIMARY KEY, data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
"""


class ModelConfigurationData(Contract):
    default: ModelSelection
    roles: dict[Role, ModelSelection | None]

    @model_validator(mode="after")
    def complete_roles(self):
        if set(self.roles) != set(ROLES):
            raise ValueError("Every role must explicitly override or inherit the default")
        return self


class ModelConfigurationChange(ModelConfigurationData):
    expected_revision: int = Field(ge=0, strict=True)
    approved_destinations: list[str] = Field(max_length=8)

    @model_validator(mode="after")
    def approve_destinations(self):
        destinations = {self.default.destination, *(choice.destination for choice in self.roles.values() if choice)}
        if len(self.approved_destinations) != len(set(self.approved_destinations)) or set(self.approved_destinations) != destinations:
            raise ValueError("Explicitly approve exactly the selected data destinations")
        return self


class RoleModelConfiguration(Contract):
    role: Role
    override: ModelSelection | None
    effective: ModelSelection
    credential_target: str | None


class ModelRunnerStatus(Contract):
    provider: Literal["codex_cli", "claude_cli"]
    available: bool
    authenticated: bool | None
    busy: bool
    error_code: str | None = None


class ModelConfiguration(Contract):
    revision: int = Field(ge=0)
    default: ModelSelection
    roles: list[RoleModelConfiguration]
    runners: list[ModelRunnerStatus] = Field(default_factory=list)


def selection(config) -> ModelSelection:
    return ModelSelection(provider=config.model_provider, name=config.model_name,
        destination=config.model_base_url if config.model_provider == "local" else DESTINATIONS[config.model_provider],
        input_usd_per_million=config.model_input_usd_per_million,
        output_usd_per_million=config.model_output_usd_per_million,
        cache_read_usd_per_million=getattr(config, "model_cache_read_usd_per_million", None),
        cache_write_usd_per_million=getattr(config, "model_cache_write_usd_per_million", None),
        max_output_tokens=config.model_max_output_tokens, effort=getattr(config, "model_effort", None))


def selection_updates(choice: ModelSelection) -> dict:
    return {"model_provider": choice.provider, "model_name": choice.name,
        "model_base_url": choice.destination if choice.provider == "local" else None,
        "model_input_usd_per_million": choice.input_usd_per_million,
        "model_output_usd_per_million": choice.output_usd_per_million,
        "model_cache_read_usd_per_million": choice.cache_read_usd_per_million,
        "model_cache_write_usd_per_million": choice.cache_write_usd_per_million,
        "model_max_output_tokens": choice.max_output_tokens, "model_effort": choice.effort}


class ModelConfigurationService:
    def __init__(self, repository, config, guard):
        self.repository, self.config, self.guard = repository, config, guard
        # Keep the deployment seed immutable: credential refresh materializes inherited roles.
        self.seed = config.model_copy(deep=True)
        metadata = self.seed.model_copy(deep=True)
        # Capability restrictions block execution, not inspection of its selected destination.
        for override in metadata.role_models.values():
            override.supports_tools = override.supports_structured_output = True
        self.baseline = ModelConfigurationData(default=selection(self.seed), roles={
            role: selection(metadata.for_role(role)) if role in metadata.role_models else None for role in ROLES})

    async def snapshot(self, connection=None) -> tuple[int, ModelConfigurationData]:
        if connection is not None:
            row = await (await connection.execute("SELECT revision,data FROM model_configuration WHERE singleton=true")).fetchone()
        else:
            async with self.repository.connection() as conn:
                row = await (await conn.execute("SELECT revision,data FROM model_configuration WHERE singleton=true")).fetchone()
        data = ModelConfigurationData.model_validate(row["data"]) if row else self.baseline.model_copy(deep=True)
        self.guard.check(data)
        return (row["revision"] if row else 0), data

    async def revision(self) -> int:
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT revision FROM model_configuration WHERE singleton=true")).fetchone()
        return row["revision"] if row else 0

    def configured(self, revision: int, data: ModelConfigurationData):
        cfg = self.config.model_copy(deep=True)
        if revision == 0:
            # Legacy deployment secret_ref/capability policies remain intact until explicitly replaced.
            for name in selection_updates(data.default):
                setattr(cfg, name, getattr(self.seed, name))
            cfg.model_secret_ref = self.seed.model_secret_ref
            cfg.role_models = {role: item.model_copy(deep=True) for role, item in self.seed.role_models.items()}
        else:
            for name, value in selection_updates(data.default).items():
                setattr(cfg, name, value)
            cfg.model_secret_ref = None
            cfg.role_models = {}
            for role, choice in data.roles.items():
                seed = self.seed.role_models.get(role)
                restrictions = {name: getattr(seed, name) for name in ("supports_tools", "supports_structured_output")} if seed else {}
                if choice or restrictions:
                    cfg.role_models[role] = RoleModelSettings(**(selection_updates(choice) if choice else {}), **restrictions)
        cfg.model_configuration_revision = revision
        return cfg

    def view(self, revision: int, data: ModelConfigurationData) -> ModelConfiguration:
        from sabre.credentials import model_secret_id
        cfg = self.configured(revision, data)
        return ModelConfiguration(revision=revision, default=data.default, roles=[RoleModelConfiguration(
            role=role, override=data.roles[role], effective=data.roles[role] or data.default,
            credential_target=model_secret_id(cfg.model_copy(update=selection_updates(data.roles[role] or data.default)), role)) for role in ROLES])

    async def get(self) -> ModelConfiguration:
        return self.view(*await self.snapshot())

    async def change(self, change: ModelConfigurationChange, *, connection=None) -> ModelConfiguration:
        self.guard.check(change)
        data = ModelConfigurationData(default=change.default, roles=change.roles)
        if connection is not None:
            return await self._change(connection, change, data)
        async with self.repository.connection() as conn:
            return await self._change(conn, change, data)

    async def _change(self, conn, change, data):
        await conn.execute("SELECT pg_advisory_xact_lock(813788)")
        row = await (await conn.execute("SELECT revision FROM model_configuration WHERE singleton=true FOR UPDATE")).fetchone()
        revision = row["revision"] if row else 0
        if revision != change.expected_revision:
            raise DomainError("MODEL_CONFIGURATION_CHANGED", "Model configuration changed; refresh before saving", 409)
        await conn.execute("""INSERT INTO model_configuration(singleton,revision,data) VALUES(true,%s,%s)
            ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data""",
            (revision + 1, Jsonb(data.model_dump(mode="json"))))
        await conn.execute("INSERT INTO model_configuration_events(revision,data) VALUES(%s,%s)",
            (revision + 1, Jsonb(data.model_dump(mode="json"))))
        return self.view(revision + 1, data)
