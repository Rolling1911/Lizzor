import { access } from "node:fs/promises";
import path from "node:path";
import { databaseIdentity, runPg, withPgService } from "./db-tooling.js";
import { verifyRecoveryConsistency } from "./recovery-consistency.js";

const backupPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
const sourceUrl = process.env.DATABASE_URL;
const restoreUrl = process.env.RESTORE_REHEARSAL_DATABASE_URL;
if (!backupPath) throw new Error("Pass the backup artifact path as the first argument.");
await access(backupPath);
if (!restoreUrl) throw new Error("RESTORE_REHEARSAL_DATABASE_URL is required.");
if (process.env.ALLOW_ISOLATED_RESTORE !== "1") throw new Error("Set ALLOW_ISOLATED_RESTORE=1 to confirm the isolated target may be replaced.");
if (sourceUrl && databaseIdentity(sourceUrl) === databaseIdentity(restoreUrl)) {
  throw new Error("Restore rehearsal refused: the target resolves to the application database.");
}

await withPgService(restoreUrl, (environment) => runPg("pg_restore", [
  "--dbname=service=lizzor_operator",
  "--clean",
  "--if-exists",
  "--no-owner",
  "--no-privileges",
  "--exit-on-error",
  backupPath,
], environment));
const result = await verifyRecoveryConsistency(restoreUrl);
if (result.missingFiles.length || result.failedCleanupJobs) {
  throw new Error(`Restore completed but consistency verification failed (${result.missingFiles.length} missing media files, ${result.failedCleanupJobs} failed cleanup jobs).`);
}
console.log(`Isolated restore rehearsal passed (${result.managedReferences} managed media references; ${result.orphanFiles.length} unreferenced files reported).`);