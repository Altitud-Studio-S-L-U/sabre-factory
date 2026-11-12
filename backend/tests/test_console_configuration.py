from types import SimpleNamespace

import httpx
import pytest
import yaml
from pydantic import SecretStr, ValidationError

from sabre.api import create_app
from sabre.console_configuration import (
    MANDATORY,
    ConsoleConfigurationService,
    FactoryConfiguration,
    FactoryPolicy,
    document,
    parse_document,
)
from sabre.flow_contracts import FlowConfiguration
from sabre.model_configuration import ROLES, ModelConfigurationData
from sabre.model_selection import ModelSelection
from sabre.models import DomainError
from sabre.security import SecretGuard


def configuration():
    return FactoryConfiguration(models=ModelConfigurationData(
        default=ModelSelection(provider="codex_cli", name="yes", destination="http://codex-runner:8091"), roles=dict.fromkeys(ROLES)),
        flows={mode: FlowConfiguration() for mode in ("patch", "maintain", "create", "audit")},
        policies=[FactoryPolicy(id=key, domain=values[0], mode="required", validator=values[1], value=values[2]) for key, values in MANDATORY.items()])


def test_guided_configuration_and_yaml_round_trip_with_explicit_primitive_types():
    value = configuration()
    value.context.max_input_bytes = 8192
    value.policies.append(FactoryPolicy(id="component_convention", domain="ui", mode="preference", value="Reuse existing components"))
    assert parse_document(document(value)).model_dump(mode="json") == value.model_dump(mode="json")


@pytest.mark.parametrize("document", ["version: 1\nversion: 1", "models: &models {}\nflows: *models", "!!python/object:builtins.object {}", "version: '1'", "version: true", "x" * 65537])
def test_configuration_rejects_ambiguous_unsupported_and_oversized_yaml(document):
    with pytest.raises((ValueError, yaml.YAMLError, TypeError)):
        parse_document(document)


def test_required_policies_cannot_be_removed_replaced_or_created_without_a_validator():
    value = configuration().model_dump()
    for change in ({"policies": []}, {"arbitrary_code": "run()"},
                   {"policies": [{**value["policies"][0], "validator": "arbitrary_python"}, *value["policies"][1:]]}):
        with pytest.raises(ValidationError):
            FactoryConfiguration.model_validate({**value, **change})


async def test_preview_reports_field_diagnostics_before_any_read_or_effect_and_never_exports_secrets():
    guard = SecretGuard(["synthetic-known-private-value"])
    service = ConsoleConfigurationService(SimpleNamespace(repository=None, guard=guard))
    value = configuration().model_dump()
    value["flows"]["patch"]["repair_cycles"] = "not-an-integer"
    preview = await service.preview(yaml.safe_dump(value))
    assert not preview.valid and preview.safe_diff == [] and preview.configuration is None
    assert any(item.path == "flows.patch.repair_cycles" for item in preview.diagnostics)
    value = configuration()
    value.policies.append(FactoryPolicy(id="private_preference", domain="ui", mode="preference", value="synthetic-known-private-value"))
    with pytest.raises(DomainError) as error:
        await service.preview(document(value))
    assert error.value.code == "SECRET_DETECTED"


async def test_builtin_catalog_describes_conditional_browser_capability_without_executing_it():
    service = SimpleNamespace(guard=SecretGuard())
    cfg = SimpleNamespace(auth_token=SecretStr("synthetic-owner-authentication"), allowed_origins=["http://localhost:8000"])
    app = create_app(service, cfg)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        result = await client.get("/api/v1/tools/catalog", headers={"Authorization": "Bearer synthetic-owner-authentication"})
    assert result.status_code == 200
    browser = next(item for item in result.json()["items"] if item["name"] == "browser_verify")
    assert browser["roles"] == ["qa", "designer"] and browser["effect"] == "read"
    assert "Requires an owner-registered synthetic preview" in browser["description"]


async def test_configuration_history_limit_is_bounded_and_owner_only():
    from types import SimpleNamespace

    import httpx
    from pydantic import SecretStr

    from sabre.api import create_app
    application = create_app(SimpleNamespace(), SimpleNamespace(auth_token=SecretStr("owner-test-token-at-least-24"), allowed_origins=["http://localhost:8000"]))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application), base_url="http://localhost:8000") as client:
        assert (await client.get("/api/v1/configuration/history")).status_code == 401
        for limit in (0, 101):
            response = await client.get(f"/api/v1/configuration/history?limit={limit}", headers={"Authorization": "Bearer owner-test-token-at-least-24"})
            assert response.status_code == 422
