// ABOUTME: Runs actor-schema migrations via node-pg-migrate (implementer decision §17.1.2,
// ABOUTME: recorded in README). Migrations live in actor/migrations/ as ordered .sql files.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export async function migrate(databaseUrl: string, dir: string = DEFAULT_DIR): Promise<void> {
  await runner({
    databaseUrl,
    dir,
    direction: "up",
    migrationsTable: "schema_migrations",
    migrationsSchema: "actor",
    createMigrationsSchema: true,
    log: () => {},
  });
}
