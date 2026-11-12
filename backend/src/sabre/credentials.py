"""Destination-bound credential resolution; values never enter agent state."""

import asyncio
import hashlib
import re
from typing import TYPE_CHECKING
from urllib.parse import urlsplit, urlunsplit

from pydantic import SecretStr

from sabre.models import DomainError, SecretTarget

if TYPE_CHECKING:
    from sabre.integrations import IntegrationService
    from sabre.mcp_connections import MCPConnectionStore
    from sabre.model_configuration import ModelConfigurationService

ROLES = ("supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security")
ROLE_LABELS = dict(zip(ROLES, ("supervisor", "analista", "arquitecto", "desarrollador", "pruebas", "technical reviewer", "seguridad"), strict=True))


def endpoint_digest(endpoint: str) -> str:
    try:
        parsed = urlsplit(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError
        host = parsed.hostname.lower()
        host = f"[{host}]" if ":" in host else host
        port = parsed.port
        authority = host if port is None or port == {"http": 80, "https": 443}[parsed.scheme] else f"{host}:{port}"
        canonical = urlunsplit((parsed.scheme, authority, parsed.path or "/", "", ""))
    except ValueError:
        raise DomainError("CREDENTIAL_DESTINATION", "The credential endpoint must use HTTP(S), without user information, query or fragment", 422) from None
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def model_secret_id(config, role: str = "default") -> str | None:
    provider = config.model_provider
    if provider in {"codex_cli", "claude_cli"}:
        if config.model_base_url:
            raise DomainError("CREDENTIAL_DESTINATION", "The CLI provider requires its authorized runner", 422)
        return None
    if provider == "local":
        if not config.model_base_url:
            raise DomainError("CREDENTIAL_DESTINATION", "Configure the local provider endpoint", 422)
        return f"model.local.{endpoint_digest(config.model_base_url)}.{role}"
    if provider not in {"openai", "anthropic", "google"} or config.model_base_url:
        raise DomainError("CREDENTIAL_DESTINATION", "The hosted provider requires its official destination", 422)
    return f"model.{provider}.{role}"


class Credentials:
    def __init__(self, vault, config, guard):
        self.vault, self.config, self.guard = vault, config, guard
        self.lock = asyncio.Lock()
        self.revision = None
        self.values: dict[str, SecretStr] = {}
        self.integrations: IntegrationService | None = None
        self.mcp_connections: MCPConnectionStore | None = None
        self.a2a_connections = None
        self.model_configuration: ModelConfigurationService | None = None
        self.static_mcp_servers = {name: server.model_copy(deep=True) for name, server in config.mcp_servers.items()}
        self.dynamic_mcp_names: frozenset[str] = frozenset()
        self.targets: dict[str, str] = {
            "github.read": "GitHub · lectura de repositorios", "github.publish": "GitHub · rama y PR draft",
            "github.create": "GitHub · repository creation approved by the owner",
            "slack.bot": "Slack · bot", "slack.app": "Slack · Socket Mode",
        }
        for name in getattr(config, "webhooks", {}):
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name):
                raise DomainError("WEBHOOK_NAME_INVALID", "Use an alphanumeric webhook name of at most 40 characters", 422)
            self.targets[f"webhook.{name}"] = f"Webhook signing key · {name}"
        self._model_targets(config)
        self.mcp_ids = {}
        for name, server in config.mcp_servers.items():
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name):
                raise DomainError("CREDENTIAL_DESTINATION", "The MCP server name is invalid", 422)
            target = f"mcp.{name}.{endpoint_digest(server.endpoint)}.token"
            self._target(target, f"MCP · {name}", server.secret_ref)
            self.mcp_ids[name] = target

    def _target(self, identifier, label, reference):
        if identifier is None:
            if reference not in {None, ""}:
                raise DomainError("CREDENTIAL_DESTINATION", "The CLI provider uses its own session rather than a vault key", 422)
            return
        if reference not in {None, "", identifier}:
            raise DomainError("CREDENTIAL_DESTINATION", "The reference does not match the configured provider or endpoint", 422)
        self.targets[identifier] = label

    def _model_targets(self, config):
        self.targets = {key: value for key, value in self.targets.items() if not key.startswith("model.")}
        self.default_id = model_secret_id(config)
        self._target(self.default_id, "Model · default", config.model_secret_ref)
        self.role_ids = {}
        for role in ROLES:
            override = config.role_models.get(role)
            target = model_secret_id(config.for_role(role), role)
            self._target(target, f"Model · {ROLE_LABELS[role]}", override.secret_ref if override else None)
            self.role_ids[role] = target

    def target_list(self):
        return [SecretTarget(id=key, label=label) for key, label in sorted(self.targets.items())]

    def validate_target(self, identifier):
        if identifier not in self.targets:
            raise DomainError("SECRET_TARGET_NOT_ALLOWED", "Select a configured credential destination", 422)

    @staticmethod
    def fingerprint(rows):
        return tuple(sorted((row.id, row.version, row.configured) for row in rows))

    async def refresh(self):
        async with self.lock:
            model_revision = None
            cfg = self.config
            if self.model_configuration:
                model_revision, model_data = await self.model_configuration.snapshot()
                cfg = self.model_configuration.configured(model_revision, model_data)
            registry_revision = ()
            dynamic = None
            if self.mcp_connections:
                dynamic, registry_revision = await self.mcp_connections.snapshot()
            rows = await self.vault.list_metadata()
            if self.a2a_connections:
                self.targets = {key: value for key, value in self.targets.items() if not key.startswith("a2a.")}
                self.targets.update(await self.a2a_connections.credential_targets())
            preferences = await self.integrations.preference_revision() if self.integrations else ()
            revision = (self.fingerprint(rows), preferences, registry_revision, model_revision)
            if revision == self.revision:
                return revision
            self._model_targets(cfg)
            if dynamic is not None:
                cfg.mcp_servers = {**{name: server.model_copy(deep=True) for name, server in self.static_mcp_servers.items()}, **dynamic}
                self.dynamic_mcp_names = frozenset(dynamic)
                self.targets = {key: value for key, value in self.targets.items() if not key.startswith("mcp.")}
                self.mcp_ids = {}
                for name, server in cfg.mcp_servers.items():
                    target = f"mcp.{name}.{endpoint_digest(server.endpoint)}.token"
                    self._target(target, f"MCP · {name}", server.secret_ref)
                    self.mcp_ids[name] = target
            # Read all active values, including destinations currently unselected, for egress protection.
            values = {row.id: await self.vault.resolve(row.id) for row in rows if row.configured}
            if revision[0] != self.fingerprint(await self.vault.list_metadata()) or (self.integrations and preferences != await self.integrations.preference_revision()) or (self.mcp_connections and registry_revision != await self.mcp_connections.revision()) or (self.model_configuration and model_revision != await self.model_configuration.revision()):
                raise DomainError("CREDENTIALS_CHANGED", "Credentials changed; try the operation again")
            known = {row.id for row in rows}
            self.guard.known_secrets = tuple(dict.fromkeys((*self.guard.known_secrets, *(value.get_secret_value() for value in values.values()))))
            empty = SecretStr("")
            cfg.model_api_key = values.get(self.default_id, empty) if self.default_id and cfg.model_secret_ref != "" else empty
            for role, identifier in self.role_ids.items():
                override = cfg.role_models.get(role)
                if override is None:
                    from sabre.settings import RoleModelSettings
                    override = RoleModelSettings()
                    cfg.role_models[role] = override
                if identifier is None:
                    override.model_api_key = empty
                    continue
                same_destination = self.default_id is not None and identifier.rsplit(".", 1)[0] == self.default_id.rsplit(".", 1)[0]
                inherit = override.secret_ref is None and identifier not in known and same_destination
                override.model_api_key = values.get(identifier, cfg.model_api_key if inherit else empty) if override.secret_ref != "" else empty
            for name, identifier in self.mcp_ids.items():
                cfg.mcp_servers[name].token = values.get(identifier, empty) if cfg.mcp_servers[name].secret_ref != "" else empty
            cfg.github_token = values.get("github.publish", empty)
            cfg.slack_bot_token, cfg.slack_app_token = values.get("slack.bot", empty), values.get("slack.app", empty)
            if cfg is not self.config:
                # Commit the destination and resolved credentials together, without an await.
                for name in type(cfg).model_fields:
                    setattr(self.config, name, getattr(cfg, name))
            self.values, self.revision = values, revision
            return revision

    async def assert_current(self, revision, *, include_models=True):
        preferences = await self.integrations.preference_revision() if self.integrations else ()
        registry_revision = await self.mcp_connections.revision() if self.mcp_connections else ()
        model_revision = await self.model_configuration.revision() if self.model_configuration else None
        current = (self.fingerprint(await self.vault.list_metadata()), preferences, registry_revision, model_revision)
        if (revision if include_models else revision[:3]) != (current if include_models else current[:3]):
            # Update the guard before a dependency can include a newly configured key in an error.
            await self.refresh()
            raise DomainError("CREDENTIALS_CHANGED", "Credentials, connections or models changed; resume with the current configuration")

    async def ensure_enabled(self, identifier):
        if self.integrations:
            await self.integrations.ensure_enabled(identifier)

    async def resolve(self, identifier):
        if identifier in {"github.read", "github.publish", "github.create"}:
            await self.ensure_enabled(identifier)
        await self.refresh()
        return self.values.get(identifier, SecretStr(""))
