"""Ordered transactional migrations, protected against edits after application."""

import hashlib

from sabre.models import DomainError

EVENTS = """
CREATE TABLE run_events(
 seq bigserial PRIMARY KEY, id text NOT NULL UNIQUE,
 work_id text NOT NULL REFERENCES work_orders(id), data jsonb NOT NULL);
CREATE INDEX run_events_cursor ON run_events(work_id,seq);
CREATE TABLE notification_outbox(
 id text PRIMARY KEY, event_id text NOT NULL, destination text NOT NULL,
 payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'pending', next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_id,destination));
CREATE INDEX notification_outbox_due ON notification_outbox(state,next_attempt_at);
"""


async def migrate(conn, baseline: str):
    await conn.execute("SELECT pg_advisory_xact_lock(813774)")
    await conn.execute("""CREATE TABLE IF NOT EXISTS schema_migrations(
        version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())""")
    rows = await (await conn.execute("SELECT version,checksum FROM schema_migrations ORDER BY version")).fetchall()
    applied = {row["version"]: row["checksum"] for row in rows}
    migrations = {1: baseline, 2: EVENTS, 3: """
        ALTER TABLE run_events DROP CONSTRAINT run_events_work_id_fkey;
        ALTER TABLE run_events ADD CONSTRAINT run_events_work_id_fkey FOREIGN KEY(work_id) REFERENCES work_orders(id) ON DELETE CASCADE;
        ALTER TABLE notifications ADD COLUMN attempts integer NOT NULL DEFAULT 0;
        ALTER TABLE notifications ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
        ALTER TABLE notifications ADD COLUMN last_error text;
        ALTER TABLE notifications ADD COLUMN failed boolean NOT NULL DEFAULT false;
        """, 4: """
        CREATE TABLE repository_flow_launches(
            proposal_id text PRIMARY KEY, request_digest text NOT NULL,
            project jsonb NOT NULL, work jsonb NOT NULL);
        """, 5: """
        CREATE TABLE operator_messages(
            id text PRIMARY KEY, scope text NOT NULL, request_key text NOT NULL,
            request_digest text NOT NULL, data jsonb NOT NULL,
            state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','blocked')),
            reply text, error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            UNIQUE(scope,request_key));
        CREATE INDEX operator_message_scope ON operator_messages(scope,created_at,id);
        """}
    if set(applied) - set(migrations):
        raise DomainError("SCHEMA_NEWER_THAN_RUNTIME", "Restore the matching application version before opening this database", 503)
    for version, statement in migrations.items():
        checksum = hashlib.sha256(statement.encode()).hexdigest()
        if version in applied:
            if applied[version] != checksum:
                raise DomainError("MIGRATION_CHANGED", "An applied database migration was modified", 503)
            continue
        await conn.execute(statement)
        await conn.execute("INSERT INTO schema_migrations(version,checksum) VALUES(%s,%s)", (version, checksum))
