import { resolve } from "node:path";
import {
  migrateDatabase,
  openDatabase,
  rebuildDatabase,
  resolveDatabasePath,
  seedDatabase,
  verifyBusinessInvariants,
  verifyDatabase,
} from "./sqlite.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const migrationDirectory = resolve(projectRoot, "database/migrations");
const seedDirectory = resolve(projectRoot, "database/seed");
const [command, databaseArgument] = process.argv.slice(2).filter((argument) => argument !== "--");
const databasePath = resolveDatabasePath(databaseArgument, projectRoot);

if (!command || !["migrate", "seed", "rebuild", "verify"].includes(command)) {
  console.error("Usage: node database/scripts/sqlite-cli.mjs <migrate|seed|rebuild|verify> [database-path]");
  process.exitCode = 1;
} else if (command === "rebuild") {
  const result = rebuildDatabase(databasePath, projectRoot, migrationDirectory, seedDirectory);
  console.log(JSON.stringify({ command, databasePath, ...result }));
} else {
  const database = openDatabase(databasePath);
  try {
    if (command === "migrate") {
      migrateDatabase(database, migrationDirectory);
    } else if (command === "seed") {
      seedDatabase(database, seedDirectory);
    }
    const result = { ...verifyDatabase(database), ...verifyBusinessInvariants(database) };
    console.log(JSON.stringify({ command, databasePath, ...result }));
  } finally {
    database.close();
  }
}
