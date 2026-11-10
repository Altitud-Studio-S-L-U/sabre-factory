import io
import json
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import SecretStr, ValidationError

from sabre import settings
from sabre import vault as vault_module
from sabre.models import DomainError, SecretDeactivate, SecretMetadata, SecretUpsert, now
from sabre.vault import (
    MASTER_AAD,
    MASTER_CANARY,
    Vault,
    _ImportEntry,
    associated_data,
    import_entries,
    valid_secret_id,
)

VALUE = "synthetic-vault-credential-never-echo"


@pytest.fixture
def vault(tmp_path):
    path = tmp_path / "master.key"
    path.write_bytes(AESGCM.generate_key(bit_length=256))
    path.chmod(0o400)
    return Vault("postgresql://fixture", path)


@pytest.mark.parametrize("change", ["id", "version", "nonce", "ciphertext", "key"])
def test_authenticated_encryption_rejects_tampering_and_wrong_key(vault, change):
    nonce = os.urandom(12)
    aad = associated_data("model.openai.default", 1)
    ciphertext = vault._cipher.encrypt(nonce, VALUE.encode(), aad)
    assert vault._decrypt(nonce, ciphertext, aad) == VALUE.encode()
    assert VALUE.encode() not in ciphertext
    if change == "id":
        aad = associated_data("model.google.default", 1)
    elif change == "version":
        aad = associated_data("model.openai.default", 2)
    elif change == "nonce":
        nonce = bytes([nonce[0] ^ 1]) + nonce[1:]
    elif change == "ciphertext":
        ciphertext = bytes([ciphertext[0] ^ 1]) + ciphertext[1:]
    else:
        vault._cipher = AESGCM(AESGCM.generate_key(bit_length=256))
    with pytest.raises(DomainError) as error:
        vault._decrypt(nonce, ciphertext, aad)
    assert error.value.code == "VAULT_INTEGRITY_ERROR"
    assert VALUE not in str(error.value)
    assert error.value.__context__ is None and error.value.__cause__ is None


@pytest.mark.parametrize("length", [0, 31, 33])
def test_master_key_requires_exactly_32_protected_bytes(tmp_path, length):
    path = tmp_path / "master.key"
    path.write_bytes(b"x" * length)
    path.chmod(0o400)
    with pytest.raises(DomainError) as error:
        Vault("postgresql://fixture", path)
    assert error.value.code == "VAULT_MASTER_KEY_UNAVAILABLE"


def test_master_symlink_and_public_permissions_are_rejected(tmp_path):
    path = tmp_path / "master.key"
    path.write_bytes(AESGCM.generate_key(bit_length=256))
    path.chmod(0o644)
    with pytest.raises(DomainError):
        Vault("postgresql://fixture", path)
    path.chmod(0o400)
    link = tmp_path / "master-link.key"
    link.symlink_to(path)
    with pytest.raises(DomainError):
        Vault("postgresql://fixture", link)


async def test_wrong_master_fails_closed_before_writing_any_secret(vault, monkeypatch):
    nonce = os.urandom(12)
    other = AESGCM(AESGCM.generate_key(bit_length=256))
    row = {"nonce": nonce, "ciphertext": other.encrypt(nonce, MASTER_CANARY, MASTER_AAD)}
    conn = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(fetchone=AsyncMock(return_value=row))))

    @asynccontextmanager
    async def connection():
        yield conn

    monkeypatch.setattr(vault, "_connection", connection)
    with pytest.raises(DomainError) as error:
        await vault.put("model.openai.default", SecretUpsert(value=SecretStr(VALUE)))
    assert error.value.code == "VAULT_MASTER_KEY_MISMATCH"
    assert conn.execute.await_count == 1
    assert conn.execute.await_args.args[0].startswith("SELECT nonce,ciphertext")
    assert error.value.__context__ is None


@pytest.mark.parametrize("secret_id", ["../owner", "/model/key", "model/key", "a" * 129, "", "model.default\n"])
def test_secret_ids_are_flat_and_bounded(secret_id):
    with pytest.raises(DomainError) as error:
        valid_secret_id(secret_id)
    assert error.value.code == "SECRET_ID_INVALID"


def test_write_only_contracts_and_metadata_do_not_echo_values():
    request = SecretUpsert(value=SecretStr(VALUE))
    assert VALUE not in repr(request)
    assert VALUE not in request.model_dump_json()
    metadata = SecretMetadata(id="model.openai.default", version=1, configured=True, updated_at=now())
    assert set(metadata.model_dump()) == {"id", "version", "configured", "updated_at"}
    for version in (0, True, "1"):
        with pytest.raises(ValidationError) as error:
            SecretUpsert(value=SecretStr(VALUE), expected_version=version)
        assert VALUE not in str(error.value)
    with pytest.raises(ValidationError):
        SecretDeactivate()


@pytest.mark.parametrize("same", [False, True])
async def test_import_retry_confirms_only_identical_existing_value(same):
    metadata = SecretMetadata(id="model.openai.default", version=2, configured=True, updated_at=now())
    store = SimpleNamespace(put=AsyncMock(side_effect=DomainError("SECRET_VERSION_CONFLICT", "Changed")),
        resolve=AsyncMock(return_value=SecretStr(VALUE if same else "another-owner-value")), list_metadata=AsyncMock(return_value=[metadata]))
    entry = _ImportEntry(id=metadata.id, value=SecretStr(VALUE))
    if same:
        assert await import_entries(store, [entry]) == [metadata]
    else:
        with pytest.raises(DomainError) as error:
            await import_entries(store, [entry])
        assert error.value.code == "SECRET_VERSION_CONFLICT"
    assert store.put.await_count == 1


def test_cli_invalid_input_returns_only_safe_error(monkeypatch, capsys):
    monkeypatch.setattr(settings, "load_bootstrap", lambda *args, **kwargs: {"vault_database_url": "postgresql://fixture"}, raising=False)
    monkeypatch.setattr(vault_module.sys, "argv", ["sabre.vault", "import-json"])
    body = [{"id": "model.openai.default", "value": VALUE, "expected_version": 0}]
    monkeypatch.setattr(vault_module.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(body).encode())))
    assert vault_module.main() == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert VALUE not in captured.err
    assert json.loads(captured.err)["code"] == "INVALID_SECRET_REQUEST"
