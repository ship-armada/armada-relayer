#!/bin/bash
# ABOUTME: Provisions the role separation of spec §5: watcher_rw (Ponder schemas), actor_rw
# ABOUTME: (actor schema RW + read-only on the published indexed views). Runs once at initdb.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE watcher_rw LOGIN PASSWORD '${WATCHER_DB_PASSWORD}';
  CREATE ROLE actor_rw   LOGIN PASSWORD '${ACTOR_DB_PASSWORD}';

  -- Both roles need db-level CREATE (their migration tools issue CREATE SCHEMA IF NOT
  -- EXISTS at boot); schema ownership still isolates them from each other (§5, S4).
  GRANT CREATE, CONNECT ON DATABASE ${POSTGRES_DB} TO watcher_rw;
  GRANT CREATE, CONNECT ON DATABASE ${POSTGRES_DB} TO actor_rw;

  -- Watcher-owned schemas: deployment schema + published views schema (§5).
  CREATE SCHEMA watcher AUTHORIZATION watcher_rw;
  CREATE SCHEMA indexed AUTHORIZATION watcher_rw;

  -- Actor-owned schema; the watcher gets no grant on it (§5, §7.4).
  CREATE SCHEMA actor AUTHORIZATION actor_rw;

  -- Actor reads the published views (and only reads): USAGE + SELECT incl. future objects.
  GRANT USAGE ON SCHEMA indexed TO actor_rw;
  ALTER DEFAULT PRIVILEGES FOR ROLE watcher_rw IN SCHEMA indexed
    GRANT SELECT ON TABLES TO actor_rw;
EOSQL
