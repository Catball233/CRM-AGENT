import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeRebuildPath,
  migrateDatabase,
  openDatabase,
  rebuildDatabase,
  seedDatabase,
  verifyDatabase,
} from "../../database/scripts/sqlite.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const migrationDirectory = resolve(projectRoot, "database/migrations");
const seedDirectory = resolve(projectRoot, "database/seed");
const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "crm-agent-sqlite-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite schema, migrations, and seed", () => {
  it("builds an empty database and applies migrations idempotently", () => {
    const databasePath = join(temporaryDirectory(), "empty.sqlite");
    const database = openDatabase(databasePath);
    try {
      migrateDatabase(database, migrationDirectory);
      migrateDatabase(database, migrationDirectory);

      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: 1,
      });
      expect(verifyDatabase(database)).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 });
    } finally {
      database.close();
    }
  });

  it("loads fictional seed data idempotently and keeps quote totals traceable", () => {
    const database = openDatabase(join(temporaryDirectory(), "seed.sqlite"));
    try {
      migrateDatabase(database, migrationDirectory);
      seedDatabase(database, seedDirectory);
      seedDatabase(database, seedDirectory);

      expect(database.prepare("SELECT COUNT(*) AS count FROM seed_history").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT estimated_total_fen FROM quote_versions").get()).toEqual({
        estimated_total_fen: 800000,
      });
      expect(
        database
          .prepare("SELECT SUM(amount_fen) AS item_total_fen FROM quote_items")
          .get(),
      ).toEqual({ item_total_fen: 800000 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM quote_knowledge_evidence").get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("enforces foreign keys, non-negative money, idempotency, and one active rule", () => {
    const database = openDatabase(join(temporaryDirectory(), "constraints.sqlite"));
    try {
      migrateDatabase(database, migrationDirectory);
      seedDatabase(database, seedDirectory);

      expect(() =>
        database
          .prepare(
            "INSERT INTO messages (message_id, conversation_id, turn_id, role, content, sequence, created_at) VALUES (?, ?, ?, 'user', 'x', 1, ?)",
          )
          .run(
            "20000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000002",
            "20000000-0000-4000-8000-000000000003",
            "2026-08-05T09:00:00Z",
          ),
      ).toThrow();

      expect(() =>
        database
          .prepare("UPDATE quote_versions SET estimated_total_fen = -1")
          .run(),
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO turns (turn_id, conversation_id, client_message_id, status, outcome, started_at, completed_at) VALUES (?, ?, ?, 'COMPLETED', 'answer', ?, ?)",
          )
          .run(
            "20000000-0000-4000-8000-000000000004",
            "10000000-0000-4000-8000-000000000001",
            "10000000-0000-4000-8000-000000000003",
            "2026-08-05T09:00:00Z",
            "2026-08-05T09:00:01Z",
          ),
      ).toThrow();

      expect(() =>
        database
          .prepare(
            `INSERT INTO rule_versions (
              rule_version_id, rule_id, version, status, city, calculation_type,
              unit_price_fen, effective_from, source_document, source_version,
              fixture_owner, fixture_reviewer, created_at
            ) VALUES (?, 'FIXTURE-DESIGN-AREA-001', 2, 'active', '示例市',
              'AREA_MULTIPLY', 11000, ?, 'fixture://duplicate', 'fixture-2.0.0',
              'role-c-fixture', 'role-a-fixture', ?)`
          )
          .run(
            "20000000-0000-4000-8000-000000000005",
            "2026-08-06T00:00:00Z",
            "2026-08-05T09:00:00Z",
          ),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("rejects edits to an already applied migration", () => {
    const directory = temporaryDirectory();
    const copiedMigrations = join(directory, "migrations");
    const databasePath = join(directory, "checksum.sqlite");
    const migrationPath = join(copiedMigrations, "0001_initial_schema.sql");
    const sourceMigration = join(migrationDirectory, "0001_initial_schema.sql");
    mkdirSync(copiedMigrations);
    copyFileSync(sourceMigration, migrationPath);

    const database = openDatabase(databasePath);
    try {
      migrateDatabase(database, copiedMigrations);
      writeFileSync(migrationPath, `${readFileSync(migrationPath, "utf8")}\n-- modified\n`);
      expect(() => migrateDatabase(database, copiedMigrations)).toThrow(/was modified/);
    } finally {
      database.close();
    }
  });

  it("rolls back all statements when a migration fails", () => {
    const directory = temporaryDirectory();
    const failedMigrations = join(directory, "migrations");
    mkdirSync(failedMigrations);
    writeFileSync(
      join(failedMigrations, "0001_broken.sql"),
      "CREATE TABLE should_rollback (id INTEGER PRIMARY KEY) STRICT;\nTHIS IS NOT SQL;\n",
    );

    const database = openDatabase(join(directory, "rollback.sqlite"));
    try {
      expect(() => migrateDatabase(database, failedMigrations)).toThrow();
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'")
          .get(),
      ).toBeUndefined();
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("rebuilds only databases in approved local directories", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "rebuilt.sqlite");

    expect(rebuildDatabase(databasePath, projectRoot, migrationDirectory, seedDirectory)).toMatchObject({
      integrity: "ok",
    });
    expect(() => assertSafeRebuildPath(resolve(projectRoot, "unsafe.sqlite"), projectRoot)).toThrow(
      /Refusing to rebuild/,
    );
  });
});
