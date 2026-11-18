import { Client } from "@replit/object-storage";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const sourceRoot = path.resolve(process.cwd(), "uploads", "catalog");
const objectPrefix = "catalog-media/";
const client = new Client();

function fail(operation: string, error: { message: string; statusCode?: number }): never {
  throw new Error(`App Storage ${operation} failed${error.statusCode ? ` (${error.statusCode})` : ""}: ${error.message}`);
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function referencedFilenames(): Promise<Set<string>> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to verify media references.");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await pool.query<{ url: string }>(
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
    return new Set(result.rows.map((row) => path.basename(row.url)));
  } finally {
    await pool.end();
  }
}

async function verifyObject(filename: string, expected: Buffer): Promise<void> {
  const downloaded = await client.downloadAsBytes(`${objectPrefix}${filename}`);
  if (!downloaded.ok) fail(`verification download for ${filename}`, downloaded.error);
  if (digest(downloaded.value[0]) !== digest(expected)) {
    throw new Error(`App Storage object ${filename} does not match the source file; migration stopped without overwriting it.`);
  }
}

async function main() {
  const probe = await client.list({ prefix: objectPrefix, maxResults: 1 });
  if (!probe.ok) fail("connection", probe.error);

  const entries = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[A-Za-z0-9._-]+$/.test(entry.name));
  const sources = new Map<string, Buffer>();
  for (const entry of entries) sources.set(entry.name, await readFile(path.join(sourceRoot, entry.name)));
  const referenced = await referencedFilenames();
  const missingSources = [...referenced].filter((filename) => !sources.has(filename));
  if (missingSources.length) {
    throw new Error(`Migration source is missing referenced media: ${missingSources.join(", ")}.`);
  }

  let uploaded = 0;
  let verified = 0;

  for (const [filename, bytes] of sources) {
    const object = `${objectPrefix}${filename}`;
    const exists = await client.exists(object);
    if (!exists.ok) fail(`existence check for ${filename}`, exists.error);
    if (exists.value) {
      await verifyObject(filename, bytes);
      verified++;
      continue;
    }
    const upload = await client.uploadFromBytes(object, bytes, { compress: false });
    if (!upload.ok) fail(`upload for ${filename}`, upload.error);
    await verifyObject(filename, bytes);
    uploaded++;
  }

  console.info(`Catalog media migration complete: ${uploaded} uploaded, ${verified} existing objects checksum-verified, ${referenced.size} database references covered.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Catalog media migration failed.");
  process.exitCode = 1;
});