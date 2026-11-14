"""One-time import from stdin; output contains public configuration only."""

import asyncio
import json
import sys

from pydantic import SecretStr

from sabre.credentials import Credentials, endpoint_digest, model_secret_id
from sabre.models import DomainError
from sabre.security import SecretGuard
from sabre.settings import RAW_SECRET_ENV, Settings
from sabre.vault import Vault, _ImportEntry, import_entries


async def main():
    legacy = json.load(sys.stdin)
    roles = json.loads(legacy.get("SABRE_ROLE_MODELS", "{}"))
    servers = json.loads(legacy.get("SABRE_MCP_SERVERS", "{}"))
    cfg = Settings(model_provider=legacy.get("SABRE_MODEL_PROVIDER", "openai"),
        model_base_url=legacy.get("SABRE_MODEL_BASE_URL") or None, role_models=roles, mcp_servers=servers)
    entries = []

    def add(identifier, value):
        if value:
            entries.append(_ImportEntry(id=identifier, value=SecretStr(value)))

    first, second = legacy.get("SABRE_MODEL_API_KEY", ""), legacy.get("OPENAI_API_KEY", "")
    if second and cfg.model_provider != "openai":
        raise DomainError("LEGACY_SECRET_CONFLICT", "A legacy OpenAI credential cannot be assigned to another provider", 409)
    if first and second and first != second:
        raise DomainError("LEGACY_SECRET_CONFLICT", "The legacy configuration holds different credentials for the same destination", 409)
    add(model_secret_id(cfg), first or second)
    for role, override in roles.items():
        if "model_api_key" in override:
            value = override.pop("model_api_key")
            if value is not None:
                identifier = model_secret_id(cfg.for_role(role), role)
                add(identifier, value)
                override["secret_ref"] = identifier if value else ""
        if "api_key" in override:
            raise DomainError("LEGACY_SECRET_CONFLICT", "The legacy configuration uses a field this version does not recognize", 409)
    for name, server in servers.items():
        if "token" in server:
            value = server.pop("token")
            identifier = f"mcp.{name}.{endpoint_digest(server['endpoint'])}.token"
            add(identifier, value)
            server["secret_ref"] = identifier if value else ""
    for key, identifier in (("SABRE_GITHUB_TOKEN", "github.publish"), ("SABRE_GITHUB_READ_TOKEN", "github.read"),
            ("SABRE_SLACK_BOT_TOKEN", "slack.bot"), ("SABRE_SLACK_APP_TOKEN", "slack.app")):
        add(identifier, legacy.get(key, ""))
    public = {key: value for key, value in legacy.items() if key not in RAW_SECRET_ENV}
    public["SABRE_ROLE_MODELS"] = json.dumps(roles, separators=(",", ":"))
    public["SABRE_MCP_SERVERS"] = json.dumps(servers, separators=(",", ":"))
    validated = Settings(model_provider=cfg.model_provider, model_base_url=cfg.model_base_url, role_models=roles, mcp_servers=servers)
    vault = Vault(cfg.vault_database_url, cfg.vault_master_key_file)
    registry = Credentials(vault, validated, SecretGuard())
    for entry in entries:
        registry.validate_target(entry.id)
    await vault.initialize()
    metadata = await import_entries(vault, entries)
    # A failed or interrupted import leaves the original .env untouched; retries reconcile the same values.
    print(json.dumps({"public": public, "imported": len(metadata)}))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        print("The migration did not complete. Keep the legacy configuration and check the vault permissions.", file=sys.stderr)
        raise SystemExit(1) from None
