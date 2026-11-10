"""Owner-managed credentials; encrypted storage is isolated from project memory."""

import argparse
import asyncio
import hmac
import json
import os
import re
import stat
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import psycopg
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg.rows import dict_row
from pydantic import Field, SecretStr, ValidationError

from sabre.models import SECRET_ID_PATTERN, DomainError, SecretMetadata, SecretUpsert

SCHEMA = """
CREATE SCHEMA IF NOT EXISTS vault;
REVOKE ALL ON SCHEMA vault FROM PUBLIC, sabre_app;
CREATE TABLE IF NOT EXISTS vault.master_check(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext)>=17));
CREATE TABLE IF NOT EXISTS vault.secrets(
 id text PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
 version bigint NOT NULL CHECK(version>=1), configured boolean NOT NULL,
 nonce bytea, ciphertext bytea,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((configured AND nonce IS NOT NULL AND octet_length(nonce)=12
        AND ciphertext IS NOT NULL AND octet_length(ciphertext)>=17)
       OR (NOT configured AND nonce IS NULL AND ciphertext IS NULL)));
REVOKE ALL ON TABLE vault.master_check,vault.secrets FROM PUBLIC, sabre_app;
"""
MASTER_AAD = b"sabre.vault.master-check.v1"
MASTER_CANARY = b"SABRE vault master verification v1"


def valid_secret_id(secret_id: str) -> str:
    if not isinstance(secret_id, str) or re.fullmatch(SECRET_ID_PATTERN, secret_id) is None:
        raise DomainError("SECRET_ID_INVALID", "The secret identifier is invalid", 422)
    return secret_id


def associated_data(secret_id: str, version: int) -> bytes:
    return json.dumps(["sabre.vault.entry.v1", valid_secret_id(secret_id), version], separators=(",", ":")).encode()


class Vault:
    def __init__(self, dsn: str | SecretStr, master_key_path: str | Path):
        self._dsn = dsn.get_secret_value() if isinstance(dsn, SecretStr) else dsn
        failed = False
        try:
            descriptor = os.open(master_key_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
            with os.fdopen(descriptor, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or (os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.geteuid())):
                    raise ValueError("unprotected master file")
                master = stream.read(33)
                if len(master) != 32:
                    raise ValueError("invalid master length")
            self._cipher = AESGCM(master)
        except (OSError, ValueError):
            failed = True
        if failed:
            raise DomainError("VAULT_MASTER_KEY_UNAVAILABLE", "The master key must be a protected 32-byte file", 503) from None

    @asynccontextmanager
    async def _connection(self):
        failure = None
        try:
            async with await psycopg.AsyncConnection.connect(self._dsn, row_factory=dict_row, connect_timeout=5,
                    options="-c statement_timeout=15000 -c lock_timeout=5000") as conn:
                yield conn
        except DomainError:
            raise
        except psycopg.Error:
            failure = DomainError("VAULT_UNAVAILABLE", "The vault is unavailable; review the service and its permissions", 503)
        if failure:
            raise failure from None

    def _decrypt(self, nonce: bytes, ciphertext: bytes, aad: bytes) -> bytes:
        failed = False
        try:
            plaintext = self._cipher.decrypt(nonce, ciphertext, aad)
        except (InvalidTag, ValueError, TypeError):
            failed = True
        if failed:
            raise DomainError("VAULT_INTEGRITY_ERROR", "Could not verify encrypted secret integrity", 503) from None
        return plaintext

    async def _check_master(self, conn):
        row = await (await conn.execute("SELECT nonce,ciphertext FROM vault.master_check WHERE singleton=true FOR SHARE")).fetchone()
        if not row:
            raise DomainError("VAULT_NOT_INITIALIZED", "The vault requires initialization of its master key check", 503)
        failed = False
        try:
            plaintext = self._decrypt(bytes(row["nonce"]), bytes(row["ciphertext"]), MASTER_AAD)
        except DomainError:
            failed = True
        if failed or plaintext != MASTER_CANARY:
            raise DomainError("VAULT_MASTER_KEY_MISMATCH", "The master key does not validate this vault; no secrets were changed", 503) from None

    async def initialize(self) -> None:
        async with self._connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(813782)")
            await conn.execute(SCHEMA)
            existing = await (await conn.execute("SELECT singleton FROM vault.master_check WHERE singleton=true")).fetchone()
            if not existing:
                populated = await (await conn.execute("SELECT EXISTS(SELECT 1 FROM vault.secrets) AS present")).fetchone()
                if populated["present"]:
                    raise DomainError("VAULT_INTEGRITY_ERROR", "The master key check is missing from a vault containing data", 503)
                nonce = os.urandom(12)
                await conn.execute("INSERT INTO vault.master_check(singleton,nonce,ciphertext) VALUES(true,%s,%s)",
                    (nonce, self._cipher.encrypt(nonce, MASTER_CANARY, MASTER_AAD)))
            await self._check_master(conn)

    async def list_metadata(self) -> list[SecretMetadata]:
        async with self._connection() as conn:
            await self._check_master(conn)
            rows = await conn.execute("SELECT id,version,configured,updated_at FROM vault.secrets ORDER BY id")
            return [SecretMetadata.model_validate(row) async for row in rows]

    async def put(self, secret_id: str, request: SecretUpsert) -> SecretMetadata:
        valid_secret_id(secret_id)
        failed = False
        try:
            plaintext = request.value.get_secret_value().encode("utf-8")
        except UnicodeEncodeError:
            failed = True
        if failed:
            raise DomainError("SECRET_VALUE_INVALID", "The secret value does not contain valid text", 422) from None
        async with self._connection() as conn:
            await self._check_master(conn)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,813783))", (secret_id,))
            previous = await (await conn.execute("SELECT version FROM vault.secrets WHERE id=%s FOR UPDATE", (secret_id,))).fetchone()
            if (previous is None and request.expected_version is not None) or (previous is not None and previous["version"] != request.expected_version):
                raise DomainError("SECRET_VERSION_CONFLICT", "The secret changed; refresh its metadata before saving", 409)
            version = previous["version"] + 1 if previous else 1
            nonce = os.urandom(12)
            ciphertext = self._cipher.encrypt(nonce, plaintext, associated_data(secret_id, version))
            row = await (await conn.execute("""INSERT INTO vault.secrets(id,version,configured,nonce,ciphertext)
                VALUES(%s,%s,true,%s,%s) ON CONFLICT(id) DO UPDATE SET version=excluded.version,
                configured=true,nonce=excluded.nonce,ciphertext=excluded.ciphertext,updated_at=clock_timestamp()
                RETURNING id,version,configured,updated_at""", (secret_id, version, nonce, ciphertext))).fetchone()
            return SecretMetadata.model_validate(row)

    async def deactivate(self, secret_id: str, expected_version: int) -> SecretMetadata:
        valid_secret_id(secret_id)
        if not isinstance(expected_version, int) or isinstance(expected_version, bool) or expected_version < 1:
            raise DomainError("SECRET_VERSION_CONFLICT", "The current secret version is required", 409)
        async with self._connection() as conn:
            await self._check_master(conn)
            previous = await (await conn.execute("SELECT id,version,configured,updated_at FROM vault.secrets WHERE id=%s FOR UPDATE", (secret_id,))).fetchone()
            if not previous:
                raise DomainError("SECRET_NOT_CONFIGURED", "No secret is configured for this destination", 404)
            if previous["version"] != expected_version:
                raise DomainError("SECRET_VERSION_CONFLICT", "The secret changed; refresh its metadata before deactivating", 409)
            if not previous["configured"]:
                return SecretMetadata.model_validate(previous)
            row = await (await conn.execute("""UPDATE vault.secrets SET version=version+1,configured=false,
                nonce=NULL,ciphertext=NULL,updated_at=clock_timestamp() WHERE id=%s RETURNING id,version,configured,updated_at""", (secret_id,))).fetchone()
            return SecretMetadata.model_validate(row)

    async def resolve(self, secret_id: str) -> SecretStr:
        valid_secret_id(secret_id)
        async with self._connection() as conn:
            await self._check_master(conn)
            row = await (await conn.execute("SELECT version,configured,nonce,ciphertext FROM vault.secrets WHERE id=%s", (secret_id,))).fetchone()
            if not row or not row["configured"]:
                raise DomainError("SECRET_NOT_CONFIGURED", "No active secret exists for this destination", 404)
            plaintext = self._decrypt(bytes(row["nonce"]), bytes(row["ciphertext"]), associated_data(secret_id, row["version"]))
            failed = False
            try:
                value = plaintext.decode("utf-8")
            except UnicodeDecodeError:
                failed = True
            if failed:
                raise DomainError("VAULT_INTEGRITY_ERROR", "The encrypted secret does not contain valid text", 503) from None
            return SecretStr(value)


class _ImportEntry(SecretUpsert):
    id: str = Field(pattern=SECRET_ID_PATTERN)


async def import_entries(vault: Vault, entries: list[_ImportEntry]) -> list[SecretMetadata]:
    """Reconcile an interrupted owner migration without overwriting existing values."""
    results = []
    for entry in entries:
        conflict = False
        try:
            metadata = await vault.put(entry.id, entry)
        except DomainError as error:
            if error.code != "SECRET_VERSION_CONFLICT" or entry.expected_version is not None:
                raise
            conflict = True
        if conflict:
            current = await vault.resolve(entry.id)
            if not hmac.compare_digest(current.get_secret_value().encode(), entry.value.get_secret_value().encode()):
                raise DomainError("SECRET_VERSION_CONFLICT", "Migration will not overwrite a different existing secret", 409)
            metadata = next(item for item in await vault.list_metadata() if item.id == entry.id)
        results.append(metadata)
    return results


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise DomainError("INVALID_SECRET_REQUEST", "Review import command arguments", 422)


async def _import_command(arguments) -> None:
    from sabre.settings import load_bootstrap

    failed = False
    try:
        bootstrap = load_bootstrap(arguments.bootstrap, kind="control")
        dsn = bootstrap["vault_database_url"]
        raw = sys.stdin.buffer.read(1_000_001)
        values = json.loads(raw)
        if not isinstance(dsn, str) or len(raw) > 1_000_000 or not isinstance(values, list) or len(values) > 100:
            raise ValueError("invalid migration input")
        entries = [_ImportEntry.model_validate(value) for value in values]
    except (OSError, ValueError, KeyError, TypeError, ValidationError):
        failed = True
    if failed:
        raise DomainError("INVALID_SECRET_REQUEST", "Import requires valid secret JSON through standard input", 422) from None
    vault = Vault(dsn, arguments.master_key)
    await vault.initialize()
    results = await import_entries(vault, entries)
    print(json.dumps([metadata.model_dump(mode="json") for metadata in results]))


def main() -> int:
    failure = None
    try:
        parser = _Parser(description="Import owner credentials through standard input; values are never returned.")
        parser.add_argument("command", choices=["import-json"])
        parser.add_argument("--bootstrap", default="/run/secrets/sabre/control.json")
        parser.add_argument("--master-key", default="/run/secrets/sabre/master.key")
        arguments = parser.parse_args()
        asyncio.run(_import_command(arguments))
    except DomainError as error:
        failure = {"code": error.code, "message": error.message}
    except Exception:
        failure = {"code": "VAULT_IMPORT_FAILED", "message": "Could not complete import; retain the source secrets"}
    if failure:
        print(json.dumps(failure), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
