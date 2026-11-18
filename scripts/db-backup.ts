import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { runPg, withPgService } from "./db-tooling.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(process.cwd(), "backups", "database"));
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);
if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error("BACKUP_RETENTION_DAYS must be an integer from 1 to 3650.");

await mkdir(backupDir, { recursive: true, mode: 0o700 });
const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
const finalPath = path.join(backupDir, `lizzor-${timestamp}.dump`);
const temporaryPath = `${finalPath}.partial`;
try {
  await withPgService(databaseUrl, (environment) => runPg("pg_dump", [
    "--dbname=service=lizzor_operator",
    "--format=custom",
    "--compress=9",
    "--no-owner",
    "--no-privileges",
    `--file=${temporaryPath}`,
  ], environment));
  const details = await stat(temporaryPath);
  if (!details.isFile() || details.size < 1024) throw new Error("The backup artifact is unexpectedly small.");
  await rename(temporaryPath, finalPath);
} catch (error) {
  await unlink(temporaryPath).catch(() => undefined);
  throw error;
}

const cutoff = Date.now() - retentionDays * 86_400_000;
for (const entry of await readdir(backupDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/^lizzor-\d{4}-\d{2}-\d{2}T\d+Z\.dump$/.test(entry.name)) continue;
  const candidate = path.join(backupDir, entry.name);
  if ((await stat(candidate)).mtimeMs < cutoff) await unlink(candidate);
}
console.log(`Database backup completed: ${path.relative(process.cwd(), finalPath)} (${retentionDays}-day retention).`);