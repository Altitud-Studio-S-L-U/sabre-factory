#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT pg_read_file('/run/secrets/postgres/app.password') AS app_password \gset
SELECT pg_read_file('/run/secrets/postgres/vault.password') AS vault_password \gset
SELECT format('CREATE ROLE sabre_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password') WHERE NOT EXISTS(SELECT FROM pg_roles WHERE rolname='sabre_app') \gexec
SELECT format('CREATE ROLE sabre_vault LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'vault_password') WHERE NOT EXISTS(SELECT FROM pg_roles WHERE rolname='sabre_vault') \gexec
ALTER DATABASE sabre OWNER TO sabre_app;
GRANT USAGE, CREATE ON SCHEMA public TO sabre_app;
SELECT 'CREATE DATABASE sabre_vault OWNER sabre_vault' WHERE NOT EXISTS(SELECT FROM pg_database WHERE datname='sabre_vault') \gexec
REVOKE CONNECT ON DATABASE sabre_vault FROM PUBLIC, sabre_app;
GRANT CONNECT ON DATABASE sabre_vault TO sabre_vault;
REVOKE CONNECT ON DATABASE sabre FROM PUBLIC, sabre_vault;
GRANT CONNECT ON DATABASE sabre TO sabre_app;
\connect sabre_vault
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS vault AUTHORIZATION sabre_vault;
SQL
