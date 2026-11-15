from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from sabre.api import create_app
from sabre.credentials import Credentials
from sabre.model_configuration import (
    DESTINATIONS,
    ROLES,
    ModelConfigurationChange,
    ModelConfigurationData,
    ModelConfigurationService,
    ModelSelection,
)
from sabre.models import DomainError
from sabre.security import SecretGuard
from sabre.service import FactoryService
from sabre.settings import Settings
from tests.test_credentials import VaultFixture, config


def choice(provider="codex_cli", **updates):
    return ModelSelection(provider=provider, destination=DESTINATIONS.get(provider, "http://model.example/v1"), **updates)


def change(**updates):
    return ModelConfigurationChange(default=choice(), roles=dict.fromkeys(ROLES), expected_revision=0,
        approved_destinations=[DESTINATIONS["codex_cli"]], **updates)


@pytest.mark.parametrize("provider,destination", [
    ("claude_cli", DESTINATIONS["codex_cli"]), ("anthropic", "http://claude-runner:8092"),
    ("local", "https://user:credential@model.example"), ("local", "https://model.example?token=value"),
    ("local", "https://model.example/#fragment"), ("local", "file:///etc/fixture"),
    ("local", "http://model.example\\@private"), ("local", "http://model.example\n"),
])
def test_destination_is_explicit_and_cannot_smuggle_a_credential(provider, destination):
    with pytest.raises(ValidationError):
        ModelSelection(provider=provider, destination=destination)


def test_complete_inheritance_and_exact_destination_approval_are_required():
    raw = change().model_dump()
    assert all(value is None for value in change().roles.values())
    for changes in ({"roles": {}}, {"roles": raw["roles"] | {"foreign": None}},
                    {"approved_destinations": []}, {"approved_destinations": raw["approved_destinations"] * 2},
                    {"approved_destinations": [*raw["approved_destinations"], DESTINATIONS["claude_cli"]]},
                    {"expected_revision": True}):
        with pytest.raises(ValidationError):
            ModelConfigurationChange.model_validate(raw | changes)
    with pytest.raises(ValidationError):
        choice(name="bad model --flag")


async def test_refresh_binds_new_destinations_and_invalidates_old_inference_snapshot():
    cfg = config(model_provider="openai", model_name="fixture")
    service = ModelConfigurationService(None, cfg, SecretGuard())
    data = ModelConfigurationData(default=choice("openai", name="fixture"), roles=dict.fromkeys(ROLES))
    service.snapshot = AsyncMock(return_value=(1, data))
    service.revision = AsyncMock(return_value=1)
    vault = VaultFixture({"model.openai.default": "synthetic-openai-value", "model.anthropic.default": "synthetic-anthropic-value"})
    credentials = Credentials(vault, cfg, service.guard)
    credentials.model_configuration = service
    original = await credentials.refresh()
    assert cfg.for_role("reviewer").model_api_key.get_secret_value() == "synthetic-openai-value"
    changed = ModelConfigurationData(default=choice("anthropic", name="fixture"),
        roles=dict.fromkeys(ROLES) | {"reviewer": choice("claude_cli")})
    service.snapshot.return_value = (2, changed)
    service.revision.return_value = 2
    with pytest.raises(DomainError) as error:
        await credentials.assert_current(original)
    assert error.value.code == "CREDENTIALS_CHANGED"
    assert cfg.model_configuration_revision == 2
    assert cfg.model_provider == "anthropic" and cfg.model_api_key.get_secret_value() == "synthetic-anthropic-value"
    assert cfg.for_role("reviewer").model_provider == "claude_cli"
    assert cfg.for_role("reviewer").model_api_key.get_secret_value() == ""
    assert "model.claude_cli.reviewer" not in {target.id for target in credentials.target_list()}
    assert cfg.for_role("developer").model_api_key.get_secret_value() == "synthetic-anthropic-value"
    assert "model_configuration_revision" not in cfg.model_dump()


async def test_configuration_race_during_refresh_does_not_apply_partial_selection():
    cfg = config(model_provider="codex_cli")
    service = ModelConfigurationService(None, cfg, SecretGuard())
    service.snapshot = AsyncMock(return_value=(1, ModelConfigurationData(default=choice("claude_cli"), roles=dict.fromkeys(ROLES))))
    service.revision = AsyncMock(return_value=2)
    credentials = Credentials(VaultFixture(), cfg, service.guard)
    credentials.model_configuration = service
    with pytest.raises(DomainError) as error:
        await credentials.refresh()
    assert error.value.code == "CREDENTIALS_CHANGED"
    assert cfg.model_provider == "codex_cli" and cfg.model_configuration_revision is None


async def test_same_provider_local_override_does_not_inherit_a_foreign_endpoint_key():
    from sabre.credentials import endpoint_digest
    cfg = config(model_provider="codex_cli")
    service = ModelConfigurationService(None, cfg, SecretGuard())
    local = choice("local", name="fixture")
    other = local.model_copy(update={"destination": "http://other-model.example/v1"})
    service.snapshot = AsyncMock(return_value=(1, ModelConfigurationData(default=local,
        roles=dict.fromkeys(ROLES) | {"reviewer": other})))
    service.revision = AsyncMock(return_value=1)
    vault = VaultFixture({f"model.local.{endpoint_digest(local.destination)}.default": "synthetic-local-value"})
    credentials = Credentials(vault, cfg, service.guard)
    credentials.model_configuration = service
    await credentials.refresh()
    assert cfg.for_role("developer").model_api_key.get_secret_value() == "synthetic-local-value"
    assert cfg.for_role("reviewer").model_api_key.get_secret_value() == ""
    assert cfg.for_role("reviewer").model_base_url == other.destination


@pytest.mark.parametrize("name", ["SABRE_CLAUDE_CLI_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
def test_cli_credentials_cannot_enter_control_environment_even_empty(monkeypatch, name):
    monkeypatch.setenv(name, "")
    with pytest.raises(DomainError) as error:
        Settings()
    assert error.value.code == "RAW_SECRET_ENV_FORBIDDEN"


def test_legacy_seed_is_immutable_and_does_not_expose_secret_values():
    from sabre.settings import RoleModelSettings
    cfg = config(role_models={"qa": RoleModelSettings(secret_ref="")})
    service = ModelConfigurationService(None, cfg, SecretGuard())
    cfg.model_provider = "claude_cli"
    cfg.role_models.clear()
    restored = service.configured(0, service.baseline)
    assert restored.model_provider == "openai" and restored.role_models["qa"].secret_ref == ""
    view = service.view(0, service.baseline).model_dump_json()
    assert "api_key" not in view and "auth_token" not in view


@pytest.mark.parametrize("override", [None, choice("claude_cli")])
def test_owner_model_selection_preserves_deployment_capability_restrictions(override):
    from sabre.settings import RoleModelSettings
    cfg = config(model_provider="codex_cli", role_models={"reviewer": RoleModelSettings(supports_tools=False)})
    service = ModelConfigurationService(None, cfg, SecretGuard())
    data = ModelConfigurationData(default=choice(), roles=dict.fromkeys(ROLES) | {"reviewer": override})
    effective = service.configured(1, data)
    assert effective.role_models["reviewer"].supports_tools is False
    with pytest.raises(DomainError) as error:
        effective.for_role("reviewer")
    assert error.value.code == "MODEL_CAPABILITIES"
    assert service.view(1, data).revision == 1


async def test_model_configuration_api_authorization_and_shared_service_contract():
    cfg = config()
    module = ModelConfigurationService(None, cfg, SecretGuard())
    response = module.view(0, module.baseline)
    service = SimpleNamespace(get_model_configuration=AsyncMock(return_value=response),
        change_model_configuration=AsyncMock(return_value=response))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(service, cfg)), base_url="http://localhost:8000") as client:
        assert (await client.put("/api/v1/model-configuration", json=change().model_dump())).status_code == 401
        service.change_model_configuration.assert_not_awaited()
        headers = {"Authorization": "Bearer " + cfg.auth_token.get_secret_value()}
        result = await client.get("/api/v1/model-configuration", headers=headers)
        assert result.status_code == 200 and result.json()["revision"] == 0
        assert "no-store" in result.headers["cache-control"]
        result = await client.put("/api/v1/model-configuration", headers=headers, json=change().model_dump())
        assert result.status_code == 200
        assert isinstance(service.change_model_configuration.call_args.args[0], ModelConfigurationChange)


async def test_busy_runner_session_is_unknown_and_metadata_projection_is_bounded():
    cfg = config()
    module = ModelConfigurationService(None, cfg, SecretGuard())
    module.get = AsyncMock(return_value=module.view(0, module.baseline))
    module.change = AsyncMock(return_value=module.view(1, module.baseline))
    service = FactoryService(None, None, None,
        SimpleNamespace(model_configuration=module, credentials=SimpleNamespace(refresh=AsyncMock())), SecretGuard(), cfg)
    service._runner_status = AsyncMock(return_value={"available": True, "authenticated": None, "busy": True,
        "provider": "codex_cli", "usage_kind": "cli_invocation"})
    response = await service.get_model_configuration()
    assert [item.provider for item in response.runners] == ["codex_cli", "claude_cli"]
    assert all(item.authenticated is None and item.busy for item in response.runners)
    saved = await service.change_model_configuration(change())
    assert saved.revision == 1 and len(saved.runners) == 2
    assert all(item.authenticated is None and item.busy for item in saved.runners)


def test_cache_prices_are_optional_and_an_unset_price_leaves_the_stored_selection_as_it_was():
    plain = choice("openai", name="fixture", input_usd_per_million=3, output_usd_per_million=15)
    assert set(plain.model_dump(mode="json")) == {"provider", "name", "destination", "input_usd_per_million",
                                                  "output_usd_per_million", "max_output_tokens"}
    priced = plain.model_copy(update={"cache_read_usd_per_million": 0.3, "cache_write_usd_per_million": 3.75})
    stored = priced.model_dump(mode="json")
    assert (stored["cache_read_usd_per_million"], stored["cache_write_usd_per_million"]) == (0.3, 3.75)
    assert ModelSelection.model_validate(stored) == priced and ModelSelection.model_validate(plain.model_dump(mode="json")) == plain
    for invalid in (-1, float("inf"), 1000001):
        with pytest.raises(ValidationError):
            choice("openai", name="fixture", cache_read_usd_per_million=invalid)


def test_cache_prices_travel_between_the_selection_and_the_settings_and_are_not_inherited_by_an_override():
    from sabre.model_configuration import selection, selection_updates
    from sabre.settings import RoleModelSettings

    priced = choice("openai", name="fixture", input_usd_per_million=3, output_usd_per_million=15,
                    cache_read_usd_per_million=0.3, cache_write_usd_per_million=3.75)
    updates = selection_updates(priced)
    assert (updates["model_cache_read_usd_per_million"], updates["model_cache_write_usd_per_million"]) == (0.3, 3.75)
    cfg = config(model_provider="openai", model_name="fixture").model_copy(update=updates)
    assert selection(cfg) == priced
    # A role with its own selection has that selection's prices, on another provider or on the same one.
    for provider in ("anthropic", "openai"):
        own = RoleModelSettings(model_provider=provider, model_name="other", model_input_usd_per_million=1, model_output_usd_per_million=5)
        other = cfg.model_copy(update={"role_models": {"qa": own}})
        qa = other.for_role("qa")
        assert (qa.model_input_usd_per_million, qa.model_cache_read_usd_per_million, qa.model_cache_write_usd_per_million) == (1, None, None)
        assert other.for_role("developer").model_cache_read_usd_per_million == 0.3
    # An override that only bounds the output keeps the model, and with it the model's prices.
    bounded = cfg.model_copy(update={"role_models": {"qa": RoleModelSettings(model_max_output_tokens=1024)}})
    assert (bounded.for_role("qa").model_cache_read_usd_per_million, bounded.for_role("qa").model_max_output_tokens) == (0.3, 1024)


def test_effort_is_optional_named_by_the_provider_and_leaves_an_unset_selection_as_it_was():
    from sabre.model_selection import EFFORT_LEVELS

    plain = choice("claude_cli", name="claude-fixture")
    # A selection without an effort is stored exactly as before the field existed, so what a run pinned still matches.
    assert "effort" not in plain.model_dump(mode="json") and plain.effort is None
    for level in EFFORT_LEVELS["claude_cli"]:
        chosen = choice("claude_cli", name="claude-fixture", effort=level)
        stored = chosen.model_dump(mode="json")
        assert stored["effort"] == level and ModelSelection.model_validate(stored) == chosen
    # A level the provider does not have, and a provider where the factory does not set one, are refused.
    for provider, level in (("claude_cli", "minimal"), ("claude_cli", "HIGH"), ("claude_cli", ""), ("codex_cli", "high"),
                            ("openai", "low"), ("anthropic", "high"), ("google", "low"), ("local", "low")):
        with pytest.raises(ValidationError):
            choice(provider, name="fixture", effort=level)


def test_effort_travels_between_the_selection_and_the_settings_and_is_not_inherited_by_an_override():
    from sabre.model_configuration import selection, selection_updates
    from sabre.model_providers import chat_model
    from sabre.settings import RoleModelSettings

    careful = choice("claude_cli", name="claude-fixture", effort="max")
    updates = selection_updates(careful)
    assert updates["model_effort"] == "max"
    cfg = config(model_provider="claude_cli", model_name="claude-fixture").model_copy(update=updates)
    assert selection(cfg) == careful and chat_model(cfg).effort == "max"
    # Unset, the CLI is given no effort and uses its own.
    unset = cfg.model_copy(update=selection_updates(choice("claude_cli", name="claude-fixture")))
    assert unset.model_effort is None and chat_model(unset).effort == ""
    # A role with its own selection has that selection's effort, or none: never the default's.
    for own, expected in ((choice("claude_cli", name="claude-other", effort="low"), "low"), (choice("claude_cli", name="claude-other"), None)):
        role = cfg.model_copy(update={"role_models": {"qa": RoleModelSettings(**selection_updates(own))}})
        assert role.for_role("qa").model_effort == expected and chat_model(role.for_role("qa")).effort == (expected or "")
        assert role.for_role("developer").model_effort == "max"
    # An override that only bounds the output keeps the model, and with it the model's effort.
    bounded = cfg.model_copy(update={"role_models": {"qa": RoleModelSettings(model_max_output_tokens=1024)}})
    assert bounded.for_role("qa").model_effort == "max"
