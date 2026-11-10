"""Vault encryption, CAS and database-role separation on the private PostgreSQL cluster."""

import asyncio
import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from pydantic import SecretStr

from sabre.models import DomainError, SecretMetadata, SecretUpsert
from sabre.settings import load_bootstrap
from sabre.vault import Vault

VALUE = "synthetic-vault-integration-value"


@pytest.fixture
async def stored_secret():
    private = load_bootstrap(kind="control")
    master = os.environ.get("SABRE_VAULT_MASTER_KEY_FILE")
    if not master:
        pytest.fail("Vault integration requires the protected master-file mount")
    store = Vault(private["vault_database_url"], Path(master))
    await store.initialize()
    secret_id = "mcp.Fixture-" + str(uuid4()) + ".0123456789abcdef.token"
    try:
        yield store, secret_id, private
    finally:
        async with store._connection() as conn:
            await conn.execute("DELETE FROM vault.secrets WHERE id=%s", (secret_id,))


async def test_encrypted_roundtrip_metadata_cas_deactivation_and_reactivation(stored_secret):
    store, secret_id, _ = stored_secret
    first = await store.put(secret_id, SecretUpsert(value=SecretStr(VALUE)))
    assert first.version == 1 and first.configured
    assert (await store.resolve(secret_id)).get_secret_value() == VALUE
    async with store._connection() as conn:
        row = await (await conn.execute("SELECT nonce,ciphertext FROM vault.secrets WHERE id=%s", (secret_id,))).fetchone()
    assert len(row["nonce"]) == 12 and VALUE.encode() not in row["ciphertext"]
    assert set(first.model_dump()) == {"id", "version", "configured", "updated_at"}
    with pytest.raises(DomainError) as conflict:
        await store.put(secret_id, SecretUpsert(value=SecretStr("replacement-without-CAS")))
    assert conflict.value.code == "SECRET_VERSION_CONFLICT"
    second = await store.put(secret_id, SecretUpsert(value=SecretStr("replacement"), expected_version=1))
    assert second.version == 2
    inactive = await store.deactivate(secret_id, second.version)
    assert inactive.version == 3 and not inactive.configured
    assert (await store.deactivate(secret_id, inactive.version)).version == 3
    async with store._connection() as conn:
        erased = await (await conn.execute("SELECT nonce,ciphertext FROM vault.secrets WHERE id=%s", (secret_id,))).fetchone()
    assert erased == {"nonce": None, "ciphertext": None}
    with pytest.raises(DomainError) as unavailable:
        await store.resolve(secret_id)
    assert unavailable.value.code == "SECRET_NOT_CONFIGURED"
    reactivated = await store.put(secret_id, SecretUpsert(value=SecretStr("new-value"), expected_version=inactive.version))
    assert reactivated.version == 4 and reactivated.configured


async def test_concurrent_creation_has_one_winner_without_overwrite(stored_secret):
    store, secret_id, _ = stored_secret
    results = await asyncio.gather(store.put(secret_id, SecretUpsert(value=SecretStr(VALUE))),
        store.put(secret_id, SecretUpsert(value=SecretStr("other-proposed-value"))), return_exceptions=True)
    assert sum(isinstance(result, DomainError) for result in results) == 1
    errors = [result for result in results if isinstance(result, DomainError)]
    assert errors[0].code == "SECRET_VERSION_CONFLICT"
    winner = 0 if isinstance(results[0], SecretMetadata) else 1
    assert isinstance(results[winner], SecretMetadata)
    values = (VALUE, "other-proposed-value")
    resolved = (await store.resolve(secret_id)).get_secret_value()
    assert resolved == values[winner]
    assert resolved != values[1 - winner]
    active = next(item for item in await store.list_metadata() if item.id == secret_id)
    assert active.version == 1


@pytest.mark.parametrize("change", ["version", "ciphertext"])
async def test_database_tampering_cannot_be_resolved(stored_secret, change):
    store, secret_id, _ = stored_secret
    await store.put(secret_id, SecretUpsert(value=SecretStr(VALUE)))
    async with store._connection() as conn:
        if change == "version":
            await conn.execute("UPDATE vault.secrets SET version=version+1 WHERE id=%s", (secret_id,))
        else:
            row = await (await conn.execute("SELECT ciphertext FROM vault.secrets WHERE id=%s", (secret_id,))).fetchone()
            raw = bytes(row["ciphertext"])
            await conn.execute("UPDATE vault.secrets SET ciphertext=%s WHERE id=%s", (bytes([raw[0] ^ 1]) + raw[1:], secret_id))
    with pytest.raises(DomainError) as error:
        await store.resolve(secret_id)
    assert error.value.code == "VAULT_INTEGRITY_ERROR"
    assert VALUE not in str(error.value)


async def test_wrong_master_cannot_reinitialize_or_overwrite_existing_storage(stored_secret, tmp_path):
    store, secret_id, private = stored_secret
    await store.put(secret_id, SecretUpsert(value=SecretStr(VALUE)))
    wrong_path = tmp_path / "wrong-master.key"
    wrong_path.write_bytes(os.urandom(32))
    wrong_path.chmod(0o400)
    wrong = Vault(private["vault_database_url"], wrong_path)
    for operation in (wrong.initialize, lambda: wrong.put(secret_id, SecretUpsert(value=SecretStr("different-value"), expected_version=1))):
        with pytest.raises(DomainError) as error:
            await operation()
        assert error.value.code == "VAULT_MASTER_KEY_MISMATCH"
    assert (await store.resolve(secret_id)).get_secret_value() == VALUE
    assert next(item for item in await store.list_metadata() if item.id == secret_id).version == 1


async def test_metadata_role_cannot_connect_or_select_encrypted_vault(stored_secret):
    store, secret_id, private = stored_secret
    await store.put(secret_id, SecretUpsert(value=SecretStr(VALUE)))
    app = conninfo_to_dict(private["database_url"])
    async with store._connection() as conn:
        privileges = await (await conn.execute("""SELECT
            has_database_privilege(%s,current_database(),'CONNECT') AS app_connect,
            has_table_privilege(%s,'vault.secrets','SELECT') AS app_select,
            has_table_privilege(%s,'vault.secrets','UPDATE') AS app_update,
            has_database_privilege(current_user,%s,'CONNECT') AS vault_to_memory""", (app["user"], app["user"], app["user"], app["dbname"]))).fetchone()
    assert privileges == {"app_connect": False, "app_select": False, "app_update": False, "vault_to_memory": False}
    async with await psycopg.AsyncConnection.connect(private["database_url"], row_factory=dict_row, connect_timeout=5) as conn:
        assert (await (await conn.execute("SELECT current_user AS name")).fetchone())["name"] == app["user"]
    app["dbname"] = conninfo_to_dict(private["vault_database_url"])["dbname"]
    with pytest.raises(psycopg.Error):
        async with await psycopg.AsyncConnection.connect(make_conninfo(**app), row_factory=dict_row, connect_timeout=5):
            pytest.fail("The memory role connected to the credential database")
