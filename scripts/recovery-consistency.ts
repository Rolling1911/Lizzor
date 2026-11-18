import { Pool } from "pg";
import { mediaStorage } from "../server/catalog/storage.js";

export async function verifyRecoveryConsistency(connectionString: string): Promise<{ managedReferences: number; missingFiles: string[]; orphanFiles: string[]; failedCleanupJobs: number }> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const requiredTables = ["products", "product_media", "categories", "storefront_banners", "orders", "users", "companies", "notifications", "media_cleanup_jobs"];
    const tableResult = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",
      [requiredTables],
    );
    const present = new Set(tableResult.rows.map((row) => row.table_name));
    const missingTables = requiredTables.filter((name) => !present.has(name));
    if (missingTables.length) throw new Error(`Recovery database is missing required tables: ${missingTables.join(", ")}.`);
    const referenceResult = await pool.query<{ url: string }>(
      `SELECT DISTINCT url FROM (
         SELECT url FROM product_media
         UNION ALL SELECT image_url FROM categories
         UNION ALL SELECT desktop_url FROM storefront_banners
         UNION ALL SELECT mobile_url FROM storefront_banners
         UNION ALL SELECT qr_image_url FROM storefront_banners
         UNION ALL SELECT published_config_json->>'desktopUrl' FROM storefront_banners
         UNION ALL SELECT published_config_json->>'mobileUrl' FROM storefront_banners
         UNION ALL SELECT published_config_json->>'qrImageUrl' FROM storefront_banners
       ) media(url) WHERE url LIKE '/catalog-media/%'`,
    );
    const referenced = new Set(referenceResult.rows.map((row) => row.url));
    const missingFiles: string[] = [];
    for (const url of referenced) {
      if (!(await mediaStorage.load(url))) missingFiles.push(url);
    }
    const stored = new Set(await mediaStorage.listManagedUrls());
    const orphanFiles = [...stored].filter((url) => !referenced.has(url));
    const failedResult = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM media_cleanup_jobs WHERE status='failed'");
    return { managedReferences: referenced.size, missingFiles, orphanFiles, failedCleanupJobs: Number(failedResult.rows[0]?.count ?? 0) };
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("recovery-consistency.ts") || process.argv[1]?.endsWith("recovery-consistency.js")) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const result = await verifyRecoveryConsistency(connectionString);
  console.log(JSON.stringify(result, null, 2));
  if (result.missingFiles.length || result.failedCleanupJobs) process.exitCode = 1;
}