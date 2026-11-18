import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, getDatabase } from "./client.js";
import { checkMigrationPreflight } from "./migration-preflight.js";

export async function runMigrations(): Promise<void> {
  try {
    await checkMigrationPreflight();
    await migrate(getDatabase(), { migrationsFolder: "./drizzle" });
    console.info("Database migrations completed.");
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1]?.endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js")) {
  runMigrations().catch((error: unknown) => {
    console.error("Database migration failed.", error);
    process.exitCode = 1;
  });
}