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
  verifyBusinessInvariants,
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
        count: 2,
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
      expect(verifyBusinessInvariants(database)).toEqual({
        businessInvariants: "ok",
        quoteTotalViolations: 0,
      });
    } finally {
      database.close();
    }
  });

  it("requires UUID identifiers and ISO 8601 timestamps with an explicit offset", () => {
    const database = openDatabase(join(temporaryDirectory(), "formats.sqlite"));
    try {
      migrateDatabase(database, migrationDirectory);

      const insertConversation = database.prepare(`
        INSERT INTO conversations (
          conversation_id, stage, status, created_at, updated_at
        ) VALUES (?, 'DISCOVERY', 'ACTIVE', ?, ?)
      `);

      expect(() =>
        insertConversation.run(
          "not-a-uuid-but-padded-to-36-characters",
          "2026-08-05T09:00:00Z",
          "2026-08-05T09:00:00Z",
        ),
      ).toThrow();
      expect(() =>
        insertConversation.run(
          "20000000-0000-9000-c000-000000000001",
          "2026-08-05T09:00:00Z",
          "2026-08-05T09:00:00Z",
        ),
      ).toThrow();
      expect(() =>
        insertConversation.run(
          "20000000-0000-4000-8000-000000000001",
          "2026-08-05T09:00:00",
          "2026-08-05T09:00:00",
        ),
      ).toThrow();

      expect(
        insertConversation.run(
          "20000000-0000-4000-8000-000000000002",
          "2026-08-05T17:00:00+08:00",
          "2026-08-05T17:00:01+08:00",
        ).changes,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("enforces UUID and ISO timestamp formats on retry attempts at the database boundary", () => {
    const database = openDatabase(join(temporaryDirectory(), "retry-formats.sqlite"));
    try {
      migrateDatabase(database, migrationDirectory);
      database.prepare(`INSERT INTO conversations (
        conversation_id, stage, status, created_at, updated_at
      ) VALUES (?, 'DISCOVERY', 'ACTIVE', ?, ?)`).run(
        "20000000-0000-4000-8000-000000000020",
        "2026-08-05T09:00:00Z",
        "2026-08-05T09:00:00Z",
      );
      database.prepare(`INSERT INTO turns (
        turn_id, conversation_id, client_message_id, status, started_at
      ) VALUES (?, ?, ?, 'PROCESSING', ?)`).run(
        "20000000-0000-4000-8000-000000000021",
        "20000000-0000-4000-8000-000000000020",
        "20000000-0000-4000-8000-000000000022",
        "2026-08-05T09:00:00Z",
      );
      const insertAttempt = database.prepare(`INSERT INTO turn_retry_attempts (
        turn_id, conversation_id, retry_request_id, attempt_number, status, started_at, finished_at
      ) VALUES (?, ?, ?, 2, ?, ?, ?)`);
      const prefix = [
        "20000000-0000-4000-8000-000000000021",
        "20000000-0000-4000-8000-000000000020",
      ] as const;

      expect(() => insertAttempt.run(
        ...prefix,
        "not-a-uuid",
        "PROCESSING",
        "2026-08-05T09:01:00Z",
        null,
      )).toThrow();
      expect(() => insertAttempt.run(
        ...prefix,
        "20000000-0000-4000-8000-000000000023",
        "PROCESSING",
        "2026-08-05T09:01:00",
        null,
      )).toThrow();
      expect(() => insertAttempt.run(
        ...prefix,
        "20000000-0000-4000-8000-000000000024",
        "FAILED",
        "2026-08-05T09:01:00Z",
        "not-an-iso-time",
      )).toThrow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM turn_retry_attempts").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("prevents turns, parent quotes, and evidence from crossing conversation boundaries", () => {
    const database = openDatabase(join(temporaryDirectory(), "conversation-boundaries.sqlite"));
    try {
      migrateDatabase(database, migrationDirectory);
      seedDatabase(database, seedDirectory);

      database
        .prepare(`
          INSERT INTO conversations (
            conversation_id, stage, status, created_at, updated_at
          ) VALUES (?, 'QUOTING', 'ACTIVE', ?, ?)
        `)
        .run(
          "20000000-0000-4000-8000-000000000010",
          "2026-08-05T09:00:00Z",
          "2026-08-05T09:00:01Z",
        );
      database
        .prepare(`
          INSERT INTO turns (
            turn_id, conversation_id, client_message_id, status, outcome, started_at, completed_at
          ) VALUES (?, ?, ?, 'COMPLETED', 'quote', ?, ?)
        `)
        .run(
          "20000000-0000-4000-8000-000000000011",
          "20000000-0000-4000-8000-000000000010",
          "20000000-0000-4000-8000-000000000012",
          "2026-08-05T09:00:00Z",
          "2026-08-05T09:00:01Z",
        );

      expect(() =>
        database
          .prepare(`
            INSERT INTO messages (
              message_id, conversation_id, turn_id, role, content, sequence, created_at
            ) VALUES (?, ?, ?, 'user', 'cross-conversation message', 1, ?)
          `)
          .run(
            "20000000-0000-4000-8000-000000000013",
            "20000000-0000-4000-8000-000000000010",
            "10000000-0000-4000-8000-000000000002",
            "2026-08-05T09:00:01Z",
          ),
      ).toThrow();

      expect(() =>
        database
          .prepare(`
            INSERT INTO knowledge_evidence (
              evidence_id, conversation_id, turn_id, knowledge_base_id, document_id,
              document_version, chunk_id, title, excerpt, score, created_at
            ) VALUES (?, ?, ?, 'kb-test', 'doc-test', '1.0.0', 'chunk-test',
              'test evidence', 'cross-conversation evidence', 0.9, ?)
          `)
          .run(
            "20000000-0000-4000-8000-000000000014",
            "20000000-0000-4000-8000-000000000010",
            "10000000-0000-4000-8000-000000000002",
            "2026-08-05T09:00:01Z",
          ),
      ).toThrow();

      const insertQuote = database.prepare(`
        INSERT INTO quote_versions (
          quote_id, conversation_id, turn_id, quote_version, parent_quote_id,
          parameters_json, estimated_total_fen, disclaimer, created_at
        ) VALUES (?, ?, ?, 1, ?, '{}', 0, 'fictional test quote', ?)
      `);
      expect(() =>
        insertQuote.run(
          "20000000-0000-4000-8000-000000000015",
          "20000000-0000-4000-8000-000000000010",
          "10000000-0000-4000-8000-000000000002",
          null,
          "2026-08-05T09:00:01Z",
        ),
      ).toThrow();
      expect(() =>
        insertQuote.run(
          "20000000-0000-4000-8000-000000000016",
          "20000000-0000-4000-8000-000000000010",
          "20000000-0000-4000-8000-000000000011",
          "10000000-0000-4000-8000-000000000009",
          "2026-08-05T09:00:01Z",
        ),
      ).toThrow();

      database
        .prepare(`
          INSERT INTO knowledge_evidence (
            evidence_id, conversation_id, turn_id, knowledge_base_id, document_id,
            document_version, chunk_id, title, excerpt, score, created_at
          ) VALUES (?, ?, ?, 'kb-test', 'doc-test', '1.0.0', 'chunk-test',
            'test evidence', 'same-conversation evidence', 0.9, ?)
        `)
        .run(
          "20000000-0000-4000-8000-000000000017",
          "20000000-0000-4000-8000-000000000010",
          "20000000-0000-4000-8000-000000000011",
          "2026-08-05T09:00:01Z",
        );
      expect(() =>
        database
          .prepare(`
            INSERT INTO quote_knowledge_evidence (quote_id, evidence_id, conversation_id)
            VALUES (?, ?, ?)
          `)
          .run(
            "10000000-0000-4000-8000-000000000009",
            "20000000-0000-4000-8000-000000000017",
            "10000000-0000-4000-8000-000000000001",
          ),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("checks quote totals as a business invariant independently of SQLite integrity", () => {
    const database = openDatabase(join(temporaryDirectory(), "business-invariants.sqlite"));
    try {
      migrateDatabase(database, migrationDirectory);
      seedDatabase(database, seedDirectory);

      expect(verifyDatabase(database)).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 });
      database.prepare("UPDATE quote_versions SET estimated_total_fen = 800001").run();
      expect(verifyDatabase(database)).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 });
      expect(() => verifyBusinessInvariants(database)).toThrow(/Quote total does not match item total/);
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
