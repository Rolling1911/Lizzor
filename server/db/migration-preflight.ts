import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const legacyDuplicatePrefixes: Record<string, readonly string[]> = {
  "0011": ["0011_payment_recovery", "0011_payment_recovery_jobs"],
  "0012": ["0012_fulfillment_operations", "0012_payment_recovery_leases"],
  "0013": ["0013_fulfillment_integrity", "0013_payment_recovery_review"],
};

/**
 * Prevents new ambiguous migration prefixes while preserving the historical
 * duplicate prefixes already recorded in deployed Drizzle journals. This runs
 * before migration execution, so no migration is attempted after a failed
 * preflight; the migrator itself records applied work transactionally.
 */
export async function checkMigrationPreflight(migrationsFolder = join(process.cwd(), "drizzle")): Promise<void> {
  const files = (await readdir(migrationsFolder))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();
  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const prefix = file.match(/^(\d+)_/)?.[1];
    if (!prefix) continue;
    const tags = byPrefix.get(prefix) ?? [];
    tags.push(file.replace(/\.sql$/, ""));
    byPrefix.set(prefix, tags);
  }
  for (const [prefix, tags] of byPrefix) {
    if (tags.length < 2) continue;
    const permitted = legacyDuplicatePrefixes[prefix];
    if (!permitted || tags.length !== permitted.length || tags.some((tag) => !permitted.includes(tag))) {
      throw new Error(`Migration preflight failed: duplicate migration prefix ${prefix} (${tags.join(", ")}). Add a new, unique migration number; do not rename applied migrations.`);
    }
  }

  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries?: Array<{ tag?: string; idx?: number }> };
  const entries = journal.entries ?? [];
  for (let position = 0; position < entries.length; position += 1) {
    const index = entries[position]?.idx;
    if (!Number.isInteger(index) || index !== position) {
      throw new Error(`Migration preflight failed: journal index at position ${position} must be the unique contiguous value ${position}; found ${String(index)}.`);
    }
  }
  const tags = entries.map((entry) => entry.tag).filter((tag): tag is string => Boolean(tag));
  if (new Set(tags).size !== tags.length) throw new Error("Migration preflight failed: duplicate migration tags in the Drizzle journal.");
  const filesByTag = new Set(files.map((file) => file.replace(/\.sql$/, "")));
  const missing = tags.filter((tag) => !filesByTag.has(tag));
  if (missing.length) throw new Error(`Migration preflight failed: journal entries are missing SQL files (${missing.join(", ")}). Applied migrations must not be rewritten or removed.`);
  const unjournaled = files.filter((file) => !new Set(tags).has(file.replace(/\.sql$/, "")));
  if (unjournaled.length) throw new Error(`Migration preflight failed: SQL files are absent from the Drizzle journal (${unjournaled.join(", ")}). Generate/add the journal entry before deployment.`);
}

if (process.argv[1]?.endsWith("migration-preflight.ts") || process.argv[1]?.endsWith("migration-preflight.js")) {
  checkMigrationPreflight().then(
    () => console.info("Migration preflight passed."),
    (error: unknown) => { console.error(error instanceof Error ? error.message : "Migration preflight failed."); process.exitCode = 1; },
  );
}