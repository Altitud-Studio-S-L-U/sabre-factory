"""One versioned, secret-free configuration for the console and YAML editor."""

import json
from datetime import datetime
from typing import Literal

import yaml
from fastapi import FastAPI, Query
from psycopg.types.json import Jsonb
from pydantic import Field, ValidationError, model_validator

from sabre.contracts import StrictContract
from sabre.flow_contracts import FlowConfiguration
from sabre.model_configuration import ModelConfigurationChange, ModelConfigurationData
from sabre.models import DomainError
from sabre.repository import digest

CONSOLE_CONFIGURATION_SCHEMA = """
CREATE TABLE factory_configuration(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision integer NOT NULL CHECK(revision>0),data jsonb NOT NULL);
CREATE TABLE factory_configuration_events(
 revision integer PRIMARY KEY,data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp());
"""
Mode = Literal["patch", "maintain", "create", "audit"]
PolicyDomain = Literal["delivery", "ui", "architecture", "infrastructure", "security"]
MANDATORY: dict[str, tuple[PolicyDomain, str, str]] = {
    "commits": ("delivery", "conventional_commit", "conventional"),
    "branches": ("delivery", "registered_branch", "sabre_revision"),
    "verification": ("security", "registered_checks", "required"),
    "review": ("security", "independent_review", "required"),
    "publication": ("delivery", "draft_pull_request", "draft_only"),
}


class FactoryPolicy(StrictContract):
    version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9_.-]*$")
    domain: PolicyDomain
    mode: Literal["required", "preference"]
    value: str = Field(min_length=1, max_length=4000)
    validator: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def registered_constraint(self):
        if self.mode == "required":
            expected = MANDATORY.get(self.id)
            if expected != (self.domain, self.validator, self.value):
                raise ValueError("Required rules must use the registered validation policy")
        elif self.validator is not None:
            raise ValueError("Advisory preferences do not have deterministic validators")
        return self


class ContextConfiguration(StrictContract):
    deduplicate: bool = True
    archive_reads: bool = True
    max_input_bytes: int = Field(default=98304, ge=4096, le=98304)


class FactoryConfiguration(StrictContract):
    version: Literal[1] = 1
    models: ModelConfigurationData
    flows: dict[Mode, FlowConfiguration]
    policies: list[FactoryPolicy] = Field(max_length=30)
    context: ContextConfiguration = Field(default_factory=ContextConfiguration)

    @model_validator(mode="after")
    def complete_contract(self):
        if set(self.flows) != {"patch", "maintain", "create", "audit"}:
            raise ValueError("Define all four registered flows")
        if len({rule.id for rule in self.policies}) != len(self.policies):
            raise ValueError("Policy identifiers must be unique")
        required = {rule.id for rule in self.policies if rule.mode == "required"}
        if required != set(MANDATORY):
            raise ValueError("Mandatory validation policies cannot be removed or changed into preferences")
        return self


class ConfigurationDocument(StrictContract):
    version: Literal[1]
    document: str = Field(min_length=1, max_length=65536)


class ConfigurationSave(ConfigurationDocument):
    expected_revision: int = Field(ge=0)
    approved_destinations: list[str] = Field(max_length=8)


class ConfigurationDiagnostic(StrictContract):
    path: str
    message: str


class ConfigurationChange(StrictContract):
    path: str
    before: str | None
    after: str | None


class ConfigurationPreview(StrictContract):
    version: Literal[1] = 1
    valid: bool
    configuration: FactoryConfiguration | None
    safe_diff: list[ConfigurationChange]
    diagnostics: list[ConfigurationDiagnostic]
    yaml: str | None


class ReadinessItem(StrictContract):
    id: str
    status: Literal["ready", "missing", "unavailable"]
    message: str
    action: str


class ConfigurationView(StrictContract):
    version: Literal[1] = 1
    revision: int
    configuration: FactoryConfiguration
    readiness: list[ReadinessItem]
    yaml: str


class BuiltinTool(StrictContract):
    name: str
    description: str
    effect: Literal["read", "workspace_write", "external_write"]
    roles: list[str]
    scope: Literal["workspace"] = "workspace"
    source: Literal["builtin"] = "builtin"
    input_schema: dict


class BuiltinToolCatalog(StrictContract):
    version: Literal[1] = 1
    items: list[BuiltinTool]


def document(configuration):
    return yaml.safe_dump(configuration.model_dump(mode="json"), sort_keys=False, allow_unicode=True)


def parse_document(value: str) -> FactoryConfiguration:
    class UniqueLoader(yaml.SafeLoader):
        def compose_node(self, parent, index):
            if self.check_event(yaml.AliasEvent):
                raise ValueError("YAML aliases are not supported")
            return super().compose_node(parent, index)

        def construct_mapping(self, node, deep=False):
            keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
            if len(keys) != len(set(keys)):
                raise ValueError("Duplicate configuration key")
            return super().construct_mapping(node, deep=deep)

    if len(value.encode()) > 65536:
        raise ValueError("Configuration exceeds 64 KiB")
    return FactoryConfiguration.model_validate(yaml.load(value, Loader=UniqueLoader))  # noqa: S506 - bounded SafeLoader rejects aliases and duplicate keys


def differences(before, after, path=""):
    result = []
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(before.keys() | after.keys()):
            result.extend(differences(before.get(key), after.get(key), f"{path}.{key}" if path else key))
    elif before != after:
        result.append(ConfigurationChange(path=path, before=None if before is None else json.dumps(before), after=None if after is None else json.dumps(after)))
    return result


MAX_HISTORY_PATHS = 20


class ConfigurationRevision(StrictContract):
    revision: int
    actor: Literal["owner"] = Field(default="owner", description="Saving requires the owner's authentication; the channel is not recorded")
    created_at: datetime
    changed_paths: list[str] = Field(description="Dotted paths changed from the previous revision, at most 20")
    changed_paths_truncated: bool
    summary: str


class ConfigurationHistory(StrictContract):
    items: list[ConfigurationRevision]
    truncated: bool = Field(description="True when older revisions exist beyond the limit")


async def configuration_history_page(repository, limit: int) -> ConfigurationHistory:
    """Newest saved factory configuration revisions, each compared with the one before it."""
    async with repository.connection() as conn:
        rows = await (await conn.execute("SELECT revision,data,created_at FROM factory_configuration_events ORDER BY revision DESC LIMIT %s",
                                         (limit + 1,))).fetchall()
    previous = {row["revision"]: row["data"] for row in rows}
    items = []
    for row in rows[:limit]:
        before = previous.get(row["revision"] - 1)
        if before is None and row["revision"] > 1:
            async with repository.connection() as conn:
                found = await (await conn.execute("SELECT data FROM factory_configuration_events WHERE revision=%s", (row["revision"] - 1,))).fetchone()
            before = found["data"] if found else None
        paths = [change.path for change in differences(before, row["data"])] if before is not None else []
        summary = (("Initial saved configuration" if row["revision"] == 1 else "Previous revision unavailable") if before is None else
                   "No changes" if not paths else
                   "Changed " + ", ".join(paths[:5]) + (f" and {len(paths) - 5} more" if len(paths) > 5 else ""))
        items.append(ConfigurationRevision(revision=row["revision"], created_at=row["created_at"], changed_paths=paths[:MAX_HISTORY_PATHS],
                                           changed_paths_truncated=len(paths) > MAX_HISTORY_PATHS, summary=summary))
    return ConfigurationHistory(items=items, truncated=len(rows) > limit)


class ConsoleConfigurationService:
    def __init__(self, service):
        self.service = service
        self.repository = service.repository

    async def snapshot(self):
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(813799)")
            await conn.execute("SELECT pg_advisory_xact_lock(813788)")
            model_revision, models = await self.service.model_configuration().snapshot(connection=conn)
            row = await (await conn.execute("SELECT revision,data FROM factory_configuration WHERE singleton=true")).fetchone()
        if row:
            configuration = FactoryConfiguration.model_validate(row["data"])
            configuration.models = models
        else:
            configuration = FactoryConfiguration(models=models, flows={"patch": FlowConfiguration(), "maintain": FlowConfiguration(), "create": FlowConfiguration(), "audit": FlowConfiguration()}, policies=[
                FactoryPolicy(id=key, domain=values[0], mode="required", validator=values[1], value=values[2]) for key, values in MANDATORY.items()
            ])
        self.service.guard.check(configuration)
        # A model edit through the granular editor also invalidates a stale whole-factory document.
        return ((row["revision"] if row else 0) << 32) | model_revision, configuration

    async def get(self):
        revision, configuration = await self.snapshot()
        status = await self.service.status()
        models = status["model"]
        connected = models.get("cli", {}).get("authenticated") if models.get("cli") else models.get("configured")
        selected = bool(configuration.models.default.name)
        projects = await self.repository.projects()
        integrations = await self.service.integrations().list()
        publisher = next((item for item in integrations if item.id == "github.publish"), None)
        readiness = [
            ReadinessItem(id="provider", status="ready" if connected else "missing", message="Provider connected" if connected else "Provider connection required", action="Connect the selected provider in Tools"),
            ReadinessItem(id="model", status="ready" if selected else "missing", message=configuration.models.default.name or "Choose an explicit model", action="Choose the default model or provide explicit phase overrides"),
            ReadinessItem(id="project", status="ready" if projects else "missing", message=f"{len(projects)} registered projects", action="Register a repository and executable checks"),
            ReadinessItem(id="delivery", status="unavailable" if publisher and publisher.enabled and publisher.credential_configured else "missing", message="Delivery credential configured; repository access has not been verified" if publisher and publisher.credential_configured else "Draft PR delivery requires a GitHub connection", action="Configure and diagnose GitHub deliveries in Tools; audit flows can run without publication"),
        ]
        return ConfigurationView(revision=revision, configuration=configuration, readiness=readiness, yaml=document(configuration))

    async def preview(self, value):
        try:
            configuration = parse_document(value)
            self.service.guard.check(configuration)
        except ValidationError as error:
            return ConfigurationPreview(valid=False, configuration=None, safe_diff=[], diagnostics=[ConfigurationDiagnostic(path=".".join(map(str, item["loc"])), message=item["msg"]) for item in error.errors(include_input=False)[:30]], yaml=None)
        except (yaml.YAMLError, ValueError, TypeError, RecursionError):
            return ConfigurationPreview(valid=False, configuration=None, safe_diff=[], diagnostics=[ConfigurationDiagnostic(path="document", message="Use the versioned configuration schema without aliases, duplicate keys or executable tags")], yaml=None)
        _, current = await self.snapshot()
        return ConfigurationPreview(valid=True, configuration=configuration, safe_diff=differences(current.model_dump(mode="json"), configuration.model_dump(mode="json")), diagnostics=[], yaml=document(configuration))

    async def save(self, request):
        preview = await self.preview(request.document)
        if not preview.valid:
            raise DomainError("CONFIGURATION_INVALID", "; ".join(f"{item.path}: {item.message}" for item in preview.diagnostics)[:1500], 422)
        configuration = preview.configuration
        model_change = ModelConfigurationChange(**configuration.models.model_dump(), expected_revision=request.expected_revision & 0xFFFFFFFF, approved_destinations=request.approved_destinations)
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(813799)")
            row = await (await conn.execute("SELECT revision FROM factory_configuration WHERE singleton=true FOR UPDATE")).fetchone()
            revision = row["revision"] if row else 0
            if revision != request.expected_revision >> 32:
                raise DomainError("CONFIGURATION_CHANGED", "Refresh and compare the current configuration before saving your retained draft", 409)
            await self.service.model_configuration().change(model_change, connection=conn)
            await conn.execute("INSERT INTO factory_configuration(singleton,revision,data) VALUES(true,%s,%s) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data", (revision + 1, Jsonb(configuration.model_dump(mode="json"))))
            await conn.execute("INSERT INTO factory_configuration_events(revision,data) VALUES(%s,%s)", (revision + 1, Jsonb(configuration.model_dump(mode="json"))))
        await self.service._credentials().refresh()
        return await self.get()


async def prepare_run_configuration(service, work, request):
    revision, configuration = await ConsoleConfigurationService(service).snapshot()
    if "flow_config" not in request.model_fields_set:
        request = request.model_copy(update={"flow_config": configuration.flows[request.mode].model_copy(deep=True)})
        work.flow_config = request.flow_config
    material = configuration.model_dump(mode="json")
    work.configuration_snapshot = {"version": 1, "revision": revision, "digest": digest(material), "configuration": material}
    return work, request


def pinned_models(work):
    if work.configuration_snapshot is None:
        return None
    snapshot = work.configuration_snapshot
    material = snapshot["configuration"]
    if digest(material) != snapshot["digest"]:
        raise DomainError("CONFIGURATION_SNAPSHOT_INVALID", "The launch configuration does not match its pinned digest", 409)
    return snapshot["revision"] & 0xFFFFFFFF, ModelConfigurationData.model_validate(material["models"])


def install_console_routes(app: FastAPI, service):
    from sabre.process_topology import ProcessTopology, process_topology

    @app.get("/api/v1/flows/{mode}/topology", response_model=ProcessTopology)
    async def flow_topology(mode: Mode):
        return process_topology(mode)

    @app.get("/api/v1/tools/catalog", response_model=BuiltinToolCatalog)
    async def builtin_tools():
        from sabre.browser_qa import browser_tool_metadata
        from sabre.tools import workspace_tools

        svc = service()
        catalog = workspace_tools(None, "catalog-inspection", svc.guard)
        items = [BuiltinTool(name=tool.name, description=tool.description,
            effect=tool.policy.effect, roles=sorted(tool.policy.roles), input_schema=tool.input_schema)
            for tool in catalog.tools.values()]
        items.append(BuiltinTool(**browser_tool_metadata()))
        return BuiltinToolCatalog(items=items)

    @app.get("/api/v1/configuration", response_model=ConfigurationView)
    async def configuration():
        return await ConsoleConfigurationService(service()).get()

    @app.post("/api/v1/configuration/preview", response_model=ConfigurationPreview)
    async def preview_configuration(body: ConfigurationDocument):
        return await ConsoleConfigurationService(service()).preview(body.document)

    @app.put("/api/v1/configuration", response_model=ConfigurationView)
    async def save_configuration(body: ConfigurationSave):
        return await ConsoleConfigurationService(service()).save(body)

    @app.get("/api/v1/configuration/history", response_model=ConfigurationHistory)
    async def configuration_history(limit: int = Query(default=20, ge=1, le=100)):
        return await configuration_history_page(service().repository, limit)
