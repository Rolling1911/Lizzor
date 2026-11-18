import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export type LizzorDatabase = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let database: LizzorDatabase | undefined;
// Keep this stable across deployments. PostgreSQL advisory locks are scoped to
// one checked-out connection and automatically release if that process dies.
const BACKGROUND_WORKER_LOCK_KEY = 6_493_271_501n;

function requireDatabaseUrl(): string {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  return env.DATABASE_URL;
}

export function getDatabasePool(): Pool {
  pool ??= new Pool({
    connectionString: requireDatabaseUrl(),
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return pool;
}

export function getDatabase(): LizzorDatabase {
  database ??= drizzle(getDatabasePool(), { schema });
  return database;
}

export async function withBackgroundWorkerLock<T>(work: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
  const client = await getDatabasePool().connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [BACKGROUND_WORKER_LOCK_KEY.toString()]);
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await work() };
  } finally {
    if (acquired) await client.query("SELECT pg_advisory_unlock($1::bigint)", [BACKGROUND_WORKER_LOCK_KEY.toString()]);
    client.release();
  }
}

export async function checkDatabaseConnection(): Promise<boolean> {
  if (!env.DATABASE_URL) {
    return false;
  }

  try {
    await getDatabasePool().query("select 1");
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = undefined;
  database = undefined;
}