import type { PoolClient } from "pg";
import { getDatabasePool } from "../db/client.js";
import { isManagedMediaUrl, removeCatalogUpload } from "./storage.js";

export async function enqueueMediaCleanup(client: PoolClient, url: string, reason: string): Promise<void> {
  if (!isManagedMediaUrl(url)) return;
  await client.query(
    `INSERT INTO media_cleanup_jobs (url, reason, status, next_attempt_at, updated_at)
     VALUES ($1, $2, 'pending', now(), now())
     ON CONFLICT (url) DO UPDATE
       SET reason=EXCLUDED.reason, status='pending', next_attempt_at=now(),
           last_error=NULL, updated_at=now()`,
    [url, reason],
  );
}

export async function scheduleMediaCleanup(url: string, reason: string): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await enqueueMediaCleanup(client, url, reason);
  } finally {
    client.release();
  }
}

async function referenced(client: PoolClient, url: string): Promise<boolean> {
  const result = await client.query<{ referenced: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM product_media WHERE url=$1)
          OR EXISTS (SELECT 1 FROM categories WHERE image_url=$1)
          OR EXISTS (SELECT 1 FROM brands WHERE logo_url=$1)
          OR EXISTS (SELECT 1 FROM banners WHERE image_url=$1)
         OR EXISTS (
           SELECT 1 FROM storefront_banners
           WHERE desktop_url=$1 OR mobile_url=$1 OR qr_image_url=$1
              OR published_config_json->>'desktopUrl'=$1
              OR published_config_json->>'mobileUrl'=$1
              OR published_config_json->>'qrImageUrl'=$1
         ) AS referenced`,
    [url],
  );
  return result.rows[0]?.referenced === true;
}

export async function runMediaCleanup(limit = 100): Promise<{ claimed: number; removed: number; retained: number; failed: number }> {
  const pool = getDatabasePool();
  const claimed = await pool.query<{ id: string; url: string; attempts: number }>(
    `WITH candidates AS (
       SELECT id FROM media_cleanup_jobs
       WHERE status IN ('pending','failed') AND next_attempt_at <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE media_cleanup_jobs j SET status='processing', updated_at=now()
     FROM candidates c WHERE j.id=c.id
     RETURNING j.id,j.url,j.attempts`,
    [Math.max(1, Math.min(500, limit))],
  );
  const summary = { claimed: claimed.rowCount ?? 0, removed: 0, retained: 0, failed: 0 };
  for (const job of claimed.rows) {
    const client = await pool.connect();
    try {
      if (await referenced(client, job.url)) {
        await client.query("UPDATE media_cleanup_jobs SET status='completed',last_error=NULL,updated_at=now() WHERE id=$1", [job.id]);
        summary.retained += 1;
        continue;
      }
      await removeCatalogUpload(job.url);
      await client.query("UPDATE media_cleanup_jobs SET status='completed',last_error=NULL,updated_at=now() WHERE id=$1", [job.id]);
      summary.removed += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const reason = error instanceof Error ? error.message.slice(0, 500) : "Media cleanup failed.";
      await client.query(
        `UPDATE media_cleanup_jobs SET status='failed',attempts=$2,last_error=$3,
           next_attempt_at=now() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST($2, 7))::int)),
           updated_at=now() WHERE id=$1`,
        [job.id, attempts, reason],
      );
      summary.failed += 1;
    } finally {
      client.release();
    }
  }
  return summary;
}