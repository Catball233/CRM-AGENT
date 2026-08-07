import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

type SqliteBootstrap = {
  openDatabase(path: string): DatabaseSync;
  migrateDatabase(database: DatabaseSync, migrations: string): void;
};

/** Opens the local MVP database and applies only the existing numbered migrations. */
export async function openApiDatabase(): Promise<DatabaseSync> {
  const root = process.cwd();
  const runtimeUrl = pathToFileURL(resolve(root, "database/scripts/sqlite.mjs")).href;
  const runtime = await import(runtimeUrl) as unknown as SqliteBootstrap;
  const configured = process.env.DATABASE_URL ?? "file:./data/local.sqlite";
  const databasePath = configured === ":memory:"
    ? configured
    : configured.startsWith("file:")
      ? resolve(root, configured.slice(5))
      : resolve(root, configured);
  const database = runtime.openDatabase(databasePath);
  runtime.migrateDatabase(database, resolve(root, "database/migrations"));
  return database;
}
