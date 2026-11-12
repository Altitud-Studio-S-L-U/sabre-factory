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

# Paired browsers: a public identifier for revocation, a coarse client label and usage times.
PANEL_SESSION_DIRECTORY = """
ALTER TABLE panel_sessions ADD COLUMN id text NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE panel_sessions ADD CONSTRAINT panel_sessions_id_key UNIQUE(id);
ALTER TABLE panel_sessions ADD COLUMN client text NOT NULL DEFAULT '';
ALTER TABLE panel_sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE panel_sessions ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT clock_timestamp();
"""

# Per-call measurement: provider-reported token split and settlement time. Older
# rows keep NULL, which projections report as unknown rather than zero.
USAGE_BREAKDOWN = """
ALTER TABLE model_usage ADD COLUMN input_tokens bigint CHECK(input_tokens>=0);
ALTER TABLE model_usage ADD COLUMN output_tokens bigint CHECK(output_tokens>=0);
ALTER TABLE model_usage ADD COLUMN cache_read_tokens bigint CHECK(cache_read_tokens>=0);
ALTER TABLE model_usage ADD COLUMN settled_at timestamptz;
"""


async def migrate(conn, baseline: str):
    from sabre.console_configuration import CONSOLE_CONFIGURATION_SCHEMA
    from sabre.delegation import DELEGATION_SCHEMA
    from sabre.memory_store import MEMORY_GRAPH_SCHEMA, MEMORY_RECALL_SCHEMA
    from sabre.release_candidates import RELEASE_SCHEMA
    from sabre.repository_ingestion import INGESTION_SCHEMA
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
        """, 6: """
        CREATE TABLE agent_definitions(
            id text PRIMARY KEY, revision integer NOT NULL CHECK(revision>0),
            draft jsonb NOT NULL, published jsonb NOT NULL);
        CREATE TABLE agent_definition_versions(
            agent_id text NOT NULL, version integer NOT NULL CHECK(version>0),
            data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            PRIMARY KEY(agent_id,version));
        """, 7: DELEGATION_SCHEMA, 8: CONSOLE_CONFIGURATION_SCHEMA, 9: """
        CREATE TABLE work_budget_authorizations(
            work_id text NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
            revision integer NOT NULL, data jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(work_id,revision));
        """, 10: INGESTION_SCHEMA, 11: RELEASE_SCHEMA, 12: PANEL_SESSION_DIRECTORY,
        13: USAGE_BREAKDOWN, 14: MEMORY_GRAPH_SCHEMA, 15: MEMORY_RECALL_SCHEMA}
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
