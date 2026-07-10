// ABOUTME: pg connection pool factory for the actor's Postgres access (actor schema RW +
// ABOUTME: read-only access to the watcher's published indexed views, spec §5).
import pg from "pg";

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

export type DbPool = pg.Pool;
