import json
import os

import pytest

from sabre.models import DomainError
from sabre.settings import Settings, load_bootstrap


def bootstrap(tmp_path, **changes):
    values = {"format": 1, "database_url": "postgresql://fixture:password@fixture/sabre",
        "vault_database_url": "postgresql://vault:password@fixture/sabre_vault",
        "auth_token": "synthetic-owner-token-24-characters", "executor_token": "synthetic-executor-token-24-characters",
        "gateway_token": "synthetic-gateway-token-24-characters"} | changes
    file = tmp_path / "control.json"
    file.write_text(json.dumps(values), encoding="utf-8")
    file.chmod(0o600)
    return file


def test_private_bootstrap_loads_secrets_and_never_serializes_them(tmp_path, monkeypatch):
    file = bootstrap(tmp_path)
    monkeypatch.setenv("SABRE_BOOTSTRAP_FILE", str(file))
    cfg = Settings()
    assert cfg.database_url.get_secret_value().startswith("postgresql://fixture")
    assert cfg.auth_token.get_secret_value() == "synthetic-owner-token-24-characters"
    assert not {"database_url", "vault_database_url", "auth_token", "executor_token", "gateway_token"} & cfg.model_dump().keys()
    assert "synthetic-owner" not in repr(cfg)


@pytest.mark.parametrize("name", ["SABRE_AUTH_TOKEN", "SABRE_DATABASE_URL", "OPENAI_API_KEY", "LANGSMITH_API_KEY", "LANGCHAIN_API_KEY"])
@pytest.mark.parametrize("value", ["", "synthetic-env-key"])
def test_raw_secret_environment_is_rejected_even_when_empty(tmp_path, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(DomainError) as error:
        load_bootstrap(bootstrap(tmp_path))
    assert error.value.code == "RAW_SECRET_ENV_FORBIDDEN"


@pytest.mark.parametrize("name,value", [("SABRE_ROLE_MODELS", '{"developer":{"model_api_key":"synthetic-key"}}'),
        ("SABRE_MCP_SERVERS", '{"fixture":{"token":"synthetic-key"}}')])
def test_public_json_cannot_carry_a_credential(tmp_path, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(DomainError) as error:
        load_bootstrap(bootstrap(tmp_path))
    assert error.value.code == "RAW_SECRET_ENV_FORBIDDEN"


@pytest.mark.parametrize("name", ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"])
def test_external_content_tracing_is_rejected(tmp_path, monkeypatch, name):
    monkeypatch.setenv(name, "true")
    with pytest.raises(DomainError) as error:
        load_bootstrap(bootstrap(tmp_path))
    assert error.value.code == "EXTERNAL_TRACING_FORBIDDEN"


@pytest.mark.parametrize("changes", [{"format": True}, {"format": 2}, {"auth_token": ""}, {"extra": "synthetic"}])
def test_wrong_bootstrap_contract_is_rejected(tmp_path, changes):
    with pytest.raises(DomainError) as error:
        load_bootstrap(bootstrap(tmp_path, **changes))
    assert error.value.code == "BOOTSTRAP_INVALID"


@pytest.mark.skipif(os.name != "posix", reason="POSIX private-file boundary is enforced inside Linux containers")
def test_public_permissions_and_symlinks_are_rejected(tmp_path):
    file = bootstrap(tmp_path)
    file.chmod(0o644)
    with pytest.raises(DomainError):
        load_bootstrap(file)
    file.chmod(0o600)
    link = tmp_path / "link.json"
    link.symlink_to(file)
    with pytest.raises(DomainError):
        load_bootstrap(link)


def test_service_cannot_load_another_service_bootstrap(tmp_path):
    with pytest.raises(DomainError) as error:
        load_bootstrap(bootstrap(tmp_path), kind="broker")
    assert error.value.code == "BOOTSTRAP_INVALID"
