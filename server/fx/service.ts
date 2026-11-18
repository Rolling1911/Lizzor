import { env } from "../config/env.js";
import { getDatabasePool } from "../db/client.js";
import { FxProviderError, assertValidFxObservation, type FxObservation, type FxProvider } from "./provider.js";
import { EcbFxProvider } from "./ecb.js";

type Queryable = { query: <T = any>(text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }> };
type FxClock = () => Date;

const DEFAULT_PROVIDER = new EcbFxProvider({
  timeoutMs: env.FX_HTTP_TIMEOUT_MS,
  maxRetries: env.FX_HTTP_MAX_RETRIES,
});
let provider: FxProvider = DEFAULT_PROVIDER;
let clock: FxClock = () => new Date();

export type FxSnapshot = {
  id: string;
  provider: string;
  source: string;
  series: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  observedAt: Date;
  fetchedAt: Date;
  expiresAt: Date;
  fetchCacheExpiresAt: Date;
  fresh: boolean;
};

export class FxUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FxUnavailableError";
    this.code = code;
  }
}

export function setFxProvider(next: FxProvider | undefined): void {
  provider = next ?? DEFAULT_PROVIDER;
}

export function setFxClock(next: FxClock | undefined): void {
  clock = next ?? (() => new Date());
}

export function fxFreshness(now: Date, expiresAt: Date): "fresh" | "stale" {
  return expiresAt.getTime() > now.getTime() ? "fresh" : "stale";
}

function rowSnapshot(row: any, now: Date): FxSnapshot {
  const expiresAt = new Date(row.expiresAt);
  return {
    id: row.id,
    provider: row.provider,
    source: row.source,
    series: row.series,
    baseCurrency: row.baseCurrency,
    quoteCurrency: row.quoteCurrency,
    rate: String(row.rate),
    observedAt: new Date(row.observedAt),
    fetchedAt: new Date(row.fetchedAt),
    expiresAt,
    fetchCacheExpiresAt: new Date(row.fetchCacheExpiresAt),
    fresh: fxFreshness(now, expiresAt) === "fresh",
  };
}

function canonicalDecimal(value: unknown): string {
  const normalized = String(value).replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return normalized || "0";
}

async function lookupCache(db: Queryable, now: Date, requireFetchFresh: boolean): Promise<FxSnapshot | null> {
  const result = await db.query(
    `SELECT id,provider,source,series,base_currency AS "baseCurrency",quote_currency AS "quoteCurrency",
            rate,observed_at AS "observedAt",fetched_at AS "fetchedAt",expires_at AS "expiresAt",
            fetch_cache_expires_at AS "fetchCacheExpiresAt"
       FROM fx_rate_snapshots
      WHERE provider=$1 AND series=$2 AND base_currency='EUR' AND quote_currency='CNY'
        AND expires_at > $3
        AND ($4=false OR fetch_cache_expires_at > $3)
      ORDER BY observed_at DESC, fetched_at DESC
      LIMIT 1`,
    [provider.name, provider.series, now, requireFetchFresh],
  );
  return result.rows[0] ? rowSnapshot(result.rows[0], now) : null;
}

/**
 * Resolves one current, validated observation. A transaction-scoped advisory
 * lock deduplicates refreshes across workers; the cache is rechecked after
 * acquiring the lock. No stale snapshot is ever returned.
 */
export async function getCurrentFxSnapshot(options: { db?: Queryable; forceRefresh?: boolean; now?: Date } = {}): Promise<FxSnapshot> {
  let now = options.now ?? clock();
  const db = options.db ?? getDatabasePool();
  if (!options.forceRefresh) {
    const cached = await lookupCache(db, now, true);
    if (cached) return cached;
  }
  const poolLike = db as Queryable & { connect?: () => Promise<any> };
  if (!poolLike.connect) throw new FxUnavailableError("FX_CACHE_UNAVAILABLE", "FX cache requires a database connection.");
  const client = await poolLike.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fx:${provider.name}:${provider.series}`]);
    if (!options.forceRefresh) {
      const cached = await lookupCache(client, now, true);
      if (cached) { await client.query("COMMIT"); return cached; }
    }
    let observation: FxObservation;
    try {
      observation = await provider.fetchObservation();
      if (observation.provider !== provider.name || observation.series !== provider.series) {
        throw new FxProviderError("FX_PROVIDER_MISMATCH", "The FX provider returned unexpected series metadata.");
      }
      // A real network fetch completes after the cache lookup clock was
      // captured. Validate against a post-fetch clock so fetchedAt is not
      // incorrectly rejected as a few milliseconds "in the future".
      if (!options.now) now = clock();
      assertValidFxObservation(observation, now, Number(env.FX_OBSERVATION_MAX_AGE_HOURS) * 60 * 60 * 1000);
    } catch (error) {
      if (!options.forceRefresh) {
        const stillCurrent = await lookupCache(client, now, false);
        if (stillCurrent) {
          await client.query("COMMIT");
          return stillCurrent;
        }
      }
      await client.query("ROLLBACK");
      if (error instanceof FxProviderError) throw new FxUnavailableError(error.code, error.message);
      throw new FxUnavailableError("FX_RATE_UNAVAILABLE", "The FX provider is unavailable.");
    }
    const maxAgeHours = Number(env.FX_OBSERVATION_MAX_AGE_HOURS);
    const expiresAt = new Date(observation.observedAt.getTime() + maxAgeHours * 60 * 60 * 1000);
    const fetchCacheExpiresAt = new Date(observation.fetchedAt.getTime() + Number(env.FX_CACHE_TTL_HOURS) * 60 * 60 * 1000);
    const inserted = await client.query(
      `INSERT INTO fx_rate_snapshots(provider,source,series,base_currency,quote_currency,rate,observed_at,fetched_at,expires_at,fetch_cache_expires_at,max_age_hours,response_hash,raw_metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(provider,series,observed_at,fetched_at) DO NOTHING
       RETURNING id,provider,source,series,base_currency AS "baseCurrency",quote_currency AS "quoteCurrency",rate,
         observed_at AS "observedAt",fetched_at AS "fetchedAt",expires_at AS "expiresAt",fetch_cache_expires_at AS "fetchCacheExpiresAt"`,
      [observation.provider, observation.source, observation.series, observation.baseCurrency, observation.quoteCurrency, observation.rate, observation.observedAt, observation.fetchedAt, expiresAt, fetchCacheExpiresAt, maxAgeHours, observation.responseHash ?? null, observation.rawMetadata ?? null],
    );
    const stored = inserted.rows[0] ?? (await client.query(
      `SELECT id,provider,source,series,base_currency AS "baseCurrency",quote_currency AS "quoteCurrency",rate,
              observed_at AS "observedAt",fetched_at AS "fetchedAt",expires_at AS "expiresAt",
              fetch_cache_expires_at AS "fetchCacheExpiresAt"
         FROM fx_rate_snapshots
        WHERE provider=$1 AND series=$2 AND observed_at=$3 AND fetched_at=$4`,
      [observation.provider, observation.series, observation.observedAt, observation.fetchedAt],
    )).rows[0];
    if (!stored || canonicalDecimal(stored.rate) !== canonicalDecimal(observation.rate)) {
      throw new FxUnavailableError("FX_SNAPSHOT_CONFLICT", "The FX observation conflicts with an existing immutable snapshot.");
    }
    await client.query("COMMIT");
    return rowSnapshot(stored, now);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction already closed */ }
    if (error instanceof FxUnavailableError) throw error;
    throw new FxUnavailableError("FX_CACHE_WRITE_FAILED", "The FX snapshot could not be persisted.");
  } finally {
    client.release();
  }
}

export async function getFxStatus(db: Queryable = getDatabasePool()) {
  const now = clock();
  const result = await db.query(
    `SELECT provider,source,series,base_currency AS "baseCurrency",quote_currency AS "quoteCurrency",
            rate,observed_at AS "observedAt",fetched_at AS "fetchedAt",expires_at AS "expiresAt",
            fetch_cache_expires_at AS "fetchCacheExpiresAt"
       FROM fx_rate_snapshots WHERE provider=$1 AND series=$2
      ORDER BY fetched_at DESC LIMIT 1`,
    [provider.name, provider.series],
  );
  const row = result.rows[0];
  if (!row) return { provider: provider.name, source: provider.source, series: provider.series, baseCurrency: "EUR", quoteCurrency: "CNY", rate: null, observedAt: null, fetchedAt: null, expiresAt: null, fresh: false, stale: true, error: null };
  const snapshot = rowSnapshot({ ...row, id: "status" }, now);
  return { provider: snapshot.provider, source: snapshot.source, series: snapshot.series, baseCurrency: snapshot.baseCurrency, quoteCurrency: snapshot.quoteCurrency, rate: snapshot.rate, observedAt: snapshot.observedAt, fetchedAt: snapshot.fetchedAt, expiresAt: snapshot.expiresAt, fresh: snapshot.fresh, stale: !snapshot.fresh, error: null };
}

export async function refreshFxRate(): Promise<FxSnapshot> {
  return getCurrentFxSnapshot({ forceRefresh: true });
}