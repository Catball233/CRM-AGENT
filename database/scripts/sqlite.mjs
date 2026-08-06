import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const VERSIONED_SQL_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

function checksum(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function timestamp() {
  return new Date().toISOString();
}

function listVersionedSql(directory) {
  const files = readdirSync(directory)
    .filter((filename) => VERSIONED_SQL_FILE.test(filename))
    .sort((left, right) => left.localeCompare(right));

  const versions = files.map((filename) => Number(VERSIONED_SQL_FILE.exec(filename)[1]));
  for (const [index, version] of versions.entries()) {
    if (version !== index + 1) {
      throw new Error(`SQL files must use contiguous versions starting at 0001; found ${files[index]}`);
    }
  }
  return files;
}

function inTransaction(database, action) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
}

export function migrateDatabase(database, migrationDirectory) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      filename TEXT NOT NULL UNIQUE,
      checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
      applied_at TEXT NOT NULL CHECK (
        datetime(applied_at) IS NOT NULL
        AND applied_at GLOB '????-??-??T??:??:??*'
        AND (
          substr(applied_at, -1) = 'Z'
          OR (substr(applied_at, -6, 1) IN ('+', '-') AND substr(applied_at, -3, 1) = ':')
        )
      )
    ) STRICT;
  `);

  const findApplied = database.prepare(
    "SELECT filename, checksum_sha256 FROM schema_migrations WHERE version = ?",
  );
  const recordApplied = database.prepare(
    "INSERT INTO schema_migrations (version, filename, checksum_sha256, applied_at) VALUES (?, ?, ?, ?)",
  );

  for (const filename of listVersionedSql(migrationDirectory)) {
    const version = Number(VERSIONED_SQL_FILE.exec(filename)[1]);
    const sql = readFileSync(resolve(migrationDirectory, filename), "utf8");
    const digest = checksum(sql);
    const applied = findApplied.get(version);

    if (applied) {
      if (applied.filename !== filename || applied.checksum_sha256 !== digest) {
        throw new Error(`Applied migration ${String(version).padStart(4, "0")} was modified`);
      }
      continue;
    }

    inTransaction(database, () => {
      database.exec(sql);
      recordApplied.run(version, filename, digest, timestamp());
    });
  }
}

export function seedDatabase(database, seedDirectory) {
  const seedTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seed_history'")
    .get();
  if (!seedTable) {
    throw new Error("Database schema is not migrated; seed_history is missing");
  }

  const findApplied = database.prepare(
    "SELECT filename, checksum_sha256 FROM seed_history WHERE seed_id = ?",
  );
  const recordApplied = database.prepare(
    "INSERT INTO seed_history (seed_id, filename, checksum_sha256, applied_at) VALUES (?, ?, ?, ?)",
  );

  for (const filename of listVersionedSql(seedDirectory)) {
    const seedId = filename.slice(0, 4);
    const sql = readFileSync(resolve(seedDirectory, filename), "utf8");
    const digest = checksum(sql);
    const applied = findApplied.get(seedId);

    if (applied) {
      if (applied.filename !== filename || applied.checksum_sha256 !== digest) {
        throw new Error(`Applied seed ${seedId} was modified`);
      }
      continue;
    }

    inTransaction(database, () => {
      database.exec(sql);
      recordApplied.run(seedId, filename, digest, timestamp());
    });
  }
}

export function verifyDatabase(database) {
  const requiredTables = [
    "schema_migrations",
    "conversations",
    "turns",
    "messages",
    "memory_summaries",
    "customer_facts",
    "knowledge_evidence",
    "rule_versions",
    "quote_versions",
    "quote_items",
    "quote_knowledge_evidence",
    "seed_history",
  ];
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all();
  const tables = new Set(rows.map((row) => row.name));
  const missing = requiredTables.filter((table) => !tables.has(table));
  if (missing.length > 0) {
    throw new Error(`Database is missing required tables: ${missing.join(", ")}`);
  }

  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(`Database has ${foreignKeys.length} foreign-key violation(s)`);
  }

  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
  }

  return { tableCount: tables.size, foreignKeyViolations: 0, integrity: "ok" };
}

export function verifyBusinessInvariants(database) {
  const quoteTotalViolations = database
    .prepare(`
      SELECT
        quote_versions.quote_id,
        quote_versions.estimated_total_fen,
        COALESCE(SUM(quote_items.amount_fen), 0) AS item_total_fen
      FROM quote_versions
      LEFT JOIN quote_items ON quote_items.quote_id = quote_versions.quote_id
      GROUP BY quote_versions.quote_id, quote_versions.estimated_total_fen
      HAVING quote_versions.estimated_total_fen <> COALESCE(SUM(quote_items.amount_fen), 0)
    `)
    .all();

  if (quoteTotalViolations.length > 0) {
    const quoteIds = quoteTotalViolations.map((row) => row.quote_id).join(", ");
    throw new Error(`Quote total does not match item total for: ${quoteIds}`);
  }

  return { quoteTotalViolations: 0, businessInvariants: "ok" };
}

export function resolveDatabasePath(input, projectRoot) {
  const configured = input ?? process.env.DATABASE_URL ?? "file:./data/local.sqlite";
  const withoutScheme = configured.startsWith("file:") ? configured.slice(5) : configured;
  if (!withoutScheme || withoutScheme === ":memory:") {
    return withoutScheme || ":memory:";
  }
  return isAbsolute(withoutScheme) ? resolve(withoutScheme) : resolve(projectRoot, withoutScheme);
}

export function assertSafeRebuildPath(databasePath, projectRoot) {
  const absolutePath = resolve(databasePath);
  const allowedRoots = [resolve(projectRoot, "data"), resolve(tmpdir())];
  const allowed = allowedRoots.some((root) => {
    const pathFromRoot = relative(root, absolutePath);
    return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
  });
  if (!allowed || !/\.(sqlite|sqlite3|db)$/i.test(absolutePath)) {
    throw new Error("Refusing to rebuild a database outside the project data or system temp directory");
  }
  return absolutePath;
}

export function rebuildDatabase(databasePath, projectRoot, migrationDirectory, seedDirectory) {
  const safePath = assertSafeRebuildPath(databasePath, projectRoot);
  for (const sqliteFile of [safePath, `${safePath}-wal`, `${safePath}-shm`]) {
    if (existsSync(sqliteFile)) {
      rmSync(sqliteFile);
    }
  }
  const database = openDatabase(safePath);
  try {
    migrateDatabase(database, migrationDirectory);
    seedDatabase(database, seedDirectory);
    return { ...verifyDatabase(database), ...verifyBusinessInvariants(database) };
  } finally {
    database.close();
  }
}
