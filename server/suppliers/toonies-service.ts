import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { assertMerchandisePriceFloor } from "../pricing/floor.js";
import { getPaymentProvider } from "../payments/provider.js";
import { TooniesClient, TooniesError } from "./toonies.js";
import { getFxStatus } from "../fx/service.js";
import { getCurrentFxSnapshot, FxUnavailableError, type FxSnapshot } from "../fx/service.js";
import { normalizeCnyToEur } from "../fx/provider.js";
import { storeCatalogMediaBuffer, isAcceptedMediaPayload, getAcceptedMediaType, mediaStorage } from "../catalog/storage.js";
import { getEuropeanCountry } from "../../shared/europeanCountries.js";
import { logger } from "../lib/logger.js";
import { getSupplierShippingProvider } from "../shipping/supplier-provider.js";
import { acquireFinancialOperation, markFinancialOperationTransmitting, transitionFinancialOperation, pauseAfterFinancialOperationReservation } from "../financial/operation-reservation.js";

const SUPPLIER_SLUG = "toonies";
const MAX_PAYLOAD_BYTES = 100_000;
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;
const MEDIA_WORKFLOW = "toonies-controlled-import";
const allowedImage = /^https?:\/\/[^\s]+$/i;
const APPROVED_TOONIES_IMAGE_HOST = "cbu01.alicdn.com";
const APPROVED_TOONIES_IMAGE_SUFFIX = ".alicdn.com";

let client: TooniesClient | undefined;
export function getTooniesClient(): TooniesClient {
  return client ??= new TooniesClient();
}
export function setTooniesClient(next: TooniesClient | undefined): void {
  client = next;
}

function boundedPayload(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    const bytes = Buffer.from(serialized, "utf8");
    if (bytes.byteLength <= MAX_PAYLOAD_BYTES) return value;
    return {
      truncated: true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      preview: bytes.subarray(0, MAX_PAYLOAD_BYTES - 160).toString("utf8"),
    };
  } catch {
    return { truncated: true };
  }
}

function images(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string" && value.length <= 2048 && allowedImage.test(value)).slice(0, 20);
}

function mediaCandidates(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string" && value.length <= 2048).slice(0, 20);
}

export function parseTooniesMoq(value: unknown): { value: number; raw: unknown } {
  const raw = value === undefined ? null : value;
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const parsed = /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647
    ? { value: parsed, raw }
    : { value: 1, raw };
}

export function deriveTooniesDisplayWeight(weights: Array<number | string | null | undefined>): number | null {
  const valid = weights
    .map((weight) => typeof weight === "string" ? Number(weight) : weight)
    .filter((weight): weight is number => typeof weight === "number" && Number.isFinite(weight) && weight > 0)
    .sort((left, right) => left - right);
  return valid[0] ?? null;
}

function parseTooniesWeight(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

type DownloadedImage = { bytes: Buffer; contentType: string; sha256: string };

function isPrivateOrLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "local" || normalized.endsWith(".local")) return true;
  const version = isIP(normalized);
  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    const [first, second] = octets;
    return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || first >= 224;
  }
  if (version === 6) {
    if (normalized === "::" || normalized === "::1" || /^(fc|fd|fe[89ab]|ff)/i.test(normalized)) return true;
    if (normalized.startsWith("::ffff:")) return isPrivateOrLocalHost(normalized.slice("::ffff:".length));
  }
  return false;
}

function validateTooniesImageUrl(sourceUrl: string): URL {
  if (typeof sourceUrl !== "string" || sourceUrl.length > 2048 || /[^\x20-\x7e]/.test(sourceUrl)) throw new Error("invalid_source_url");
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("invalid_source_url");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) throw new Error("invalid_source_url");
  // URL normalizes an explicit default port away, so inspect the authority too.
  const authority = sourceUrl.slice(sourceUrl.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes(":")) throw new Error("invalid_source_url");
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isPrivateOrLocalHost(hostname) ||
      (hostname !== APPROVED_TOONIES_IMAGE_HOST && !hostname.endsWith(APPROVED_TOONIES_IMAGE_SUFFIX))) {
    throw new Error("unapproved_source_host");
  }
  return parsed;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function downloadTooniesImage(sourceUrl: string): Promise<DownloadedImage> {
  let currentUrl = validateTooniesImageUrl(sourceUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    let response: Response;
    for (let redirectCount = 0; ; redirectCount += 1) {
      response = await fetch(currentUrl, { redirect: "manual", signal: controller.signal });
      if (!isRedirectStatus(response.status)) break;
      if (redirectCount >= MAX_IMAGE_REDIRECTS) throw new Error("too_many_redirects");
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect_missing_location");
      let redirectedUrl: URL;
      try {
        redirectedUrl = new URL(location, currentUrl);
      } catch {
        throw new Error("invalid_redirect_location");
      }
      currentUrl = validateTooniesImageUrl(redirectedUrl.toString());
    }
    if (!response.ok) throw new Error(`http_status_${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (getAcceptedMediaType(contentType) !== "image") throw new Error("unsupported_content_type");
    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) throw new Error("image_too_large");
    if (!response.body) throw new Error("empty_response_body");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > MAX_REMOTE_IMAGE_BYTES) throw new Error("image_too_large");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const file = { buffer: bytes, mimetype: contentType } as any;
    if (!isAcceptedMediaPayload(file)) throw new Error("invalid_image_signature");
    return { bytes, contentType, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("download_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type RehostingTarget = {
  sourceUrl: string;
  catalogueVariantId: string | null;
  variantId: string | null;
  altText: string;
};

async function recordMediaAttempt(
  db: QueryClient,
  target: RehostingTarget,
  context: { supplierId: string; catalogueItemId: string; productId: string },
  result: { status: "stored" | "rejected"; reason?: string; managedUrl?: string; contentType?: string; sha256?: string },
): Promise<void> {
  const conflictTarget = target.catalogueVariantId
    ? "(supplier_id,catalogue_variant_id,source_url) WHERE catalogue_variant_id IS NOT NULL"
    : "(supplier_id,catalogue_item_id,source_url) WHERE catalogue_variant_id IS NULL";
  await db.query(
    `INSERT INTO supplier_media_rehosting
       (supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id,source_url,status,failure_reason,managed_url,content_type,source_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT ${conflictTarget} DO UPDATE SET status=EXCLUDED.status,failure_reason=EXCLUDED.failure_reason,
       managed_url=COALESCE(EXCLUDED.managed_url,supplier_media_rehosting.managed_url),
       content_type=EXCLUDED.content_type,source_sha256=EXCLUDED.source_sha256,updated_at=now()`,
    [context.supplierId, context.catalogueItemId, target.catalogueVariantId, context.productId, target.variantId, target.sourceUrl, result.status, result.reason ?? null, result.managedUrl ?? null, result.contentType ?? null, result.sha256 ?? null],
  );
}

export async function normalizeTooniesPrimaryMedia(productId: string): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM products WHERE id=$1 FOR UPDATE", [productId]);
    const images = (await client.query<{
      id: string;
      isPrimary: boolean;
      sourceWorkflow: string | null;
    }>(
      `SELECT id,is_primary AS "isPrimary",source_workflow AS "sourceWorkflow"
         FROM product_media
        WHERE product_id=$1 AND variant_id IS NULL AND type='image'
        ORDER BY sort_order,created_at,id
        FOR UPDATE`,
      [productId],
    )).rows;
    if (!images.length) {
      await client.query("COMMIT");
      return;
    }
    const primaries = images.filter((image) => image.isPrimary);
    const intentionalAdminPrimary = primaries.filter((image) => image.sourceWorkflow !== MEDIA_WORKFLOW);
    const selected = intentionalAdminPrimary.length === 1
        ? intentionalAdminPrimary[0]!
        : images.find((image) => image.sourceWorkflow === MEDIA_WORKFLOW) ?? images[0]!;
    await client.query(
      "UPDATE product_media SET is_primary=false WHERE product_id=$1 AND variant_id IS NULL AND type='image' AND is_primary=true",
      [productId],
    );
    await client.query("UPDATE product_media SET is_primary=true WHERE id=$1", [selected.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rehostTooniesMedia(catalogueItemId: string, productId: string): Promise<void> {
  const pool = getDatabasePool();
  const context = (await pool.query<any>(
    `SELECT i.supplier_id AS "supplierId",i.id AS "catalogueItemId",i.image_urls AS "imageUrls",i.raw_payload AS "rawPayload",
            i.title,v.id AS "catalogueVariantId",v.image_url AS "imageUrl",v.raw_payload AS "variantRawPayload",
            r.variant_id AS "variantId",r.product_id AS "productId",v.title AS "variantTitle"
       FROM supplier_catalogue_items i
       LEFT JOIN supplier_catalogue_variants v ON v.catalogue_item_id=i.id
       LEFT JOIN supplier_import_records r ON r.catalogue_variant_id=v.id
      WHERE i.id=$1 AND i.id IN (SELECT catalogue_item_id FROM supplier_import_records WHERE product_id=$2)`,
    [catalogueItemId, productId],
  )).rows;
  const first = context[0];
  if (!first) return;
  const targets: RehostingTarget[] = [];
  const rawProductImages = first.rawPayload?.images ?? (first.rawPayload?.image ? [first.rawPayload.image] : first.imageUrls);
  const productUrls = mediaCandidates(rawProductImages);
  for (const sourceUrl of productUrls) targets.push({ sourceUrl, catalogueVariantId: null, variantId: null, altText: first.title });
  const variants = new Map<string, any>();
  for (const row of context) {
    if (!row.catalogueVariantId || !row.variantId || variants.has(row.catalogueVariantId)) continue;
    variants.set(row.catalogueVariantId, row);
  }
  for (const row of variants.values()) {
    const rawVariantImage = row.variantRawPayload?.image ?? row.imageUrl;
    const sourceUrl = typeof rawVariantImage === "string" && rawVariantImage.length <= 2048 ? rawVariantImage : null;
    if (sourceUrl) targets.push({ sourceUrl, catalogueVariantId: row.catalogueVariantId, variantId: row.variantId, altText: row.variantTitle ?? first.title });
  }
  const uniqueTargets = [...new Map(targets.map((target) => [`${target.catalogueVariantId ?? "product"}:${target.sourceUrl}`, target])).values()];
  const queryClient: QueryClient = { query: (...args: any[]) => (pool.query as any)(...args) };
  for (const target of uniqueTargets) {
    const existing = (await pool.query<{ url: string; sourceSha256: string | null }>(
      `SELECT url,source_sha256 AS "sourceSha256" FROM product_media
        WHERE product_id=$1 AND variant_id IS NOT DISTINCT FROM $2
          AND source_workflow=$3 AND source_url=$4 LIMIT 1`,
      [productId, target.variantId, MEDIA_WORKFLOW, target.sourceUrl],
    )).rows[0];
    if (existing && await mediaStorage.exists(existing.url)) {
      await pool.query(
        `UPDATE product_media SET sort_order=$1,alt_text=$2
          WHERE product_id=$3 AND variant_id IS NOT DISTINCT FROM $4 AND source_workflow=$5 AND source_url=$6`,
        [targets.indexOf(target), target.altText, productId, target.variantId, MEDIA_WORKFLOW, target.sourceUrl],
      );
      await recordMediaAttempt(queryClient, target, first, { status: "stored", managedUrl: existing.url, sha256: existing.sourceSha256 ?? undefined });
      continue;
    }
    try {
      const downloaded = await downloadTooniesImage(target.sourceUrl);
      const stored = await storeCatalogMediaBuffer(downloaded.bytes, downloaded.contentType);
      const insert = await pool.query(
        `INSERT INTO product_media
           (product_id,variant_id,type,url,alt_text,is_primary,sort_order,source_url,source_sha256,source_workflow,source_supplier_id,source_catalogue_item_id,source_catalogue_variant_id)
         VALUES ($1,$2,'image',$3,$4,false,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING RETURNING id`,
        [productId, target.variantId, stored.url, target.altText, targets.indexOf(target), target.sourceUrl, downloaded.sha256, MEDIA_WORKFLOW, first.supplierId, first.catalogueItemId, target.catalogueVariantId],
      );
      if (!insert.rowCount) {
        const winner = (await pool.query<{ url: string }>(
          `SELECT url FROM product_media WHERE product_id=$1 AND variant_id IS NOT DISTINCT FROM $2 AND source_workflow=$3 AND source_url=$4 LIMIT 1`,
          [productId, target.variantId, MEDIA_WORKFLOW, target.sourceUrl],
        )).rows[0];
        if (existing) {
          await pool.query(
            `UPDATE product_media SET url=$1,source_sha256=$2,alt_text=$3 WHERE product_id=$4
              AND variant_id IS NOT DISTINCT FROM $5 AND source_workflow=$6 AND source_url=$7`,
            [stored.url, downloaded.sha256, target.altText, productId, target.variantId, MEDIA_WORKFLOW, target.sourceUrl],
          );
          if (existing.url !== stored.url) await mediaStorage.remove(existing.url);
          await recordMediaAttempt(queryClient, target, first, { status: "stored", managedUrl: stored.url, contentType: downloaded.contentType, sha256: downloaded.sha256 });
        } else {
          await mediaStorage.remove(stored.url);
          await recordMediaAttempt(queryClient, target, first, { status: "stored", managedUrl: winner?.url, contentType: downloaded.contentType, sha256: downloaded.sha256 });
        }
      } else {
        await recordMediaAttempt(queryClient, target, first, { status: "stored", managedUrl: stored.url, contentType: downloaded.contentType, sha256: downloaded.sha256 });
      }
    } catch (error) {
      await recordMediaAttempt(queryClient, target, first, { status: "rejected", reason: error instanceof Error ? error.message.slice(0, 120) : "download_failed" });
    }
  }
  await normalizeTooniesPrimaryMedia(productId);
}

async function tooniesWarehouseId(db: any): Promise<string> {
  const existing = (await db.query("SELECT id FROM warehouses WHERE code='TOONIES' FOR UPDATE")).rows[0] as { id: string } | undefined;
  if (existing) return existing.id;
  return (await db.query("INSERT INTO warehouses(name,code,country_code,active) VALUES('Toonies Supplier','TOONIES','CN',true) RETURNING id")).rows[0].id as string;
}

async function boundedConcurrent<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await operation(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * pg clients reject overlapping queries. Keep transaction callers safe even
 * when a future ingestion step fans out work internally: each query is queued
 * on the checked-out client while retaining the same transaction connection.
 */
type QueryClient = {
  query: <T = any>(...args: any[]) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

type StructuredSupplierOption = { attribute: string; value: string };

function structuredSupplierOptions(value: unknown): StructuredSupplierOption[] {
  if (!Array.isArray(value)) return [];
  const options: StructuredSupplierOption[] = [];
  const attributes = new Set<string>();
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const attribute = String(row.name_trans ?? row.name ?? "").trim().slice(0, 100);
    const optionValue = String(row.value_trans ?? row.value ?? "").trim().slice(0, 150);
    const key = attribute.toLocaleLowerCase();
    if (!attribute || !optionValue || attributes.has(key)) continue;
    attributes.add(key);
    options.push({ attribute, value: optionValue });
  }
  return options;
}

function attributeSlug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

async function applyStructuredSupplierOptions(
  db: QueryClient,
  productVariantId: string,
  rawAttributes: unknown,
  preserveExisting: boolean,
): Promise<StructuredSupplierOption[]> {
  const options = structuredSupplierOptions(rawAttributes);
  if (!options.length) return [];
  // Relationships are authoritative supplier data, while the variant title is
  // merchant presentation.  The old preserveExisting short-circuit meant a
  // partially imported variant could never be repaired: one surviving
  // relationship caused all missing relationships to be skipped.  Reconcile
  // each authoritative attribute independently instead.  Keep unrelated
  // relationships intact (they may be merchant-owned), but replace an
  // existing relationship for an attribute supplied by this catalogue record.
  for (const option of options) {
    const attribute = await db.query<{ id: string }>(
      `INSERT INTO product_attributes(name,slug) VALUES($1,$2)
       ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name,updated_at=now() RETURNING id`,
      [option.attribute, attributeSlug(option.attribute)],
    );
    const value = await db.query<{ id: string }>(
      `INSERT INTO attribute_values(attribute_id,value) VALUES($1,$2)
       ON CONFLICT(attribute_id,value) DO UPDATE SET value=EXCLUDED.value,updated_at=now() RETURNING id`,
      [attribute.rows[0]!.id, option.value],
    );
    await db.query(
      "DELETE FROM variant_attribute_values WHERE variant_id=$1 AND attribute_id=$2",
      [productVariantId, attribute.rows[0]!.id],
    );
    await db.query(
      `INSERT INTO variant_attribute_values(variant_id,attribute_id,attribute_value_id)
       VALUES($1,$2,$3)
       ON CONFLICT(variant_id,attribute_id) DO UPDATE SET attribute_value_id=EXCLUDED.attribute_value_id`,
      [productVariantId, attribute.rows[0]!.id, value.rows[0]!.id],
    );
  }
  return options;
}

type StructuredOptionLinkSummary = {
  variantId: string;
  catalogueVariantId: string;
  localSku: string;
  supplierSku: string;
  options: StructuredSupplierOption[];
};

export type LinkedCatalogueStructuredOptionReconciliation = {
  catalogueItemId: string;
  productId: string;
  before: StructuredOptionLinkSummary[];
  after: StructuredOptionLinkSummary[];
  result: {
    variantsReconciled: number;
    relationshipsBefore: number;
    relationshipsAfter: number;
    relationshipsCreated: number;
    relationshipsReplaced: number;
    relationshipsUnchanged: number;
  };
};

async function reconcileStructuredSupplierOptionsNarrow(
  db: QueryClient,
  productVariantId: string,
  rawAttributes: unknown,
): Promise<{ created: number; replaced: number; unchanged: number }> {
  const options = structuredSupplierOptions(rawAttributes);
  if (!options.length) throw new AppError(409, "SUPPLIER_VARIANT_OPTIONS_MISSING", "A linked supplier variant has no structured options to reconcile.");
  let created = 0;
  let replaced = 0;
  let unchanged = 0;
  for (const option of options) {
    const slug = attributeSlug(option.attribute);
    await db.query(
      "INSERT INTO product_attributes(name,slug) VALUES($1,$2) ON CONFLICT(slug) DO NOTHING",
      [option.attribute, slug],
    );
    const attribute = (await db.query<{ id: string }>(
      "SELECT id FROM product_attributes WHERE slug=$1 FOR SHARE",
      [slug],
    )).rows[0]!;
    await db.query(
      "INSERT INTO attribute_values(attribute_id,value) VALUES($1,$2) ON CONFLICT(attribute_id,value) DO NOTHING",
      [attribute.id, option.value],
    );
    const value = (await db.query<{ id: string }>(
      "SELECT id FROM attribute_values WHERE attribute_id=$1 AND value=$2 FOR SHARE",
      [attribute.id, option.value],
    )).rows[0]!;
    const current = (await db.query<{ attributeValueId: string }>(
      "SELECT attribute_value_id AS \"attributeValueId\" FROM variant_attribute_values WHERE variant_id=$1 AND attribute_id=$2 FOR UPDATE",
      [productVariantId, attribute.id],
    )).rows[0];
    if (!current) {
      await db.query(
        "INSERT INTO variant_attribute_values(variant_id,attribute_id,attribute_value_id) VALUES($1,$2,$3)",
        [productVariantId, attribute.id, value.id],
      );
      created += 1;
    } else if (current.attributeValueId !== value.id) {
      await db.query(
        "UPDATE variant_attribute_values SET attribute_value_id=$1 WHERE variant_id=$2 AND attribute_id=$3",
        [value.id, productVariantId, attribute.id],
      );
      replaced += 1;
    } else {
      unchanged += 1;
    }
  }
  return { created, replaced, unchanged };
}

async function linkedStructuredOptionSummary(
  db: QueryClient,
  supplier: string,
  catalogueItemId: string,
  productId: string,
): Promise<StructuredOptionLinkSummary[]> {
  const variants = (await db.query<{
    variantId: string;
    catalogueVariantId: string;
    localSku: string;
    supplierSku: string;
  }>(
    `SELECT l.variant_id AS "variantId",l.catalogue_variant_id AS "catalogueVariantId",
            pv.sku AS "localSku",scv.sku_code AS "supplierSku"
       FROM supplier_product_links l
       JOIN product_variants pv ON pv.id=l.variant_id AND pv.product_id=l.product_id
       JOIN supplier_catalogue_variants scv
         ON scv.id=l.catalogue_variant_id
        AND scv.supplier_id=l.supplier_id
        AND scv.catalogue_item_id=l.catalogue_item_id
      WHERE l.supplier_id=$1 AND l.catalogue_item_id=$2 AND l.product_id=$3
        AND l.variant_id IS NOT NULL AND l.catalogue_variant_id IS NOT NULL
      ORDER BY scv.sku_code,l.variant_id`,
    [supplier, catalogueItemId, productId],
  )).rows;
  const result: StructuredOptionLinkSummary[] = [];
  for (const variant of variants) {
    const options = (await db.query<StructuredSupplierOption>(
      `SELECT pa.name AS attribute,av.value
         FROM variant_attribute_values vav
         JOIN product_attributes pa ON pa.id=vav.attribute_id
         JOIN attribute_values av ON av.id=vav.attribute_value_id
        WHERE vav.variant_id=$1
        ORDER BY pa.slug,av.value`,
      [variant.variantId],
    )).rows;
    result.push({ ...variant, options });
  }
  return result;
}

export async function reconcileLinkedCatalogueStructuredOptions(input: {
  catalogueItemId: string;
  productId: string;
  actorAdminId: string;
}): Promise<LinkedCatalogueStructuredOptionReconciliation> {
  const db = await getDatabasePool().connect();
  try {
    await db.query("BEGIN");
    const toonies = (await db.query<{ id: string }>(
      "SELECT id FROM suppliers WHERE slug=$1 FOR SHARE",
      [SUPPLIER_SLUG],
    )).rows[0];
    if (!toonies) throw new AppError(404, "TOONIES_SUPPLIER_NOT_FOUND", "The Toonies supplier was not found.");
    const catalogue = (await db.query<{ id: string }>(
      "SELECT id FROM supplier_catalogue_items WHERE id=$1 AND supplier_id=$2 FOR UPDATE",
      [input.catalogueItemId, toonies.id],
    )).rows[0];
    if (!catalogue) throw new AppError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "The Toonies catalogue item was not found.");
    const product = (await db.query<{ id: string }>(
      `SELECT p.id
         FROM products p
        WHERE p.id=$1
          AND EXISTS (
            SELECT 1 FROM supplier_product_links l
             WHERE l.supplier_id=$2 AND l.catalogue_item_id=$3 AND l.product_id=p.id
          )
        FOR UPDATE`,
      [input.productId, toonies.id, input.catalogueItemId],
    )).rows[0];
    if (!product) throw new AppError(404, "SUPPLIER_PRODUCT_LINK_NOT_FOUND", "The product is not linked to this Toonies catalogue item.");
    await db.query(
      `SELECT l.id
         FROM supplier_product_links l
        WHERE l.supplier_id=$1 AND l.catalogue_item_id=$2 AND l.product_id=$3
        ORDER BY l.id FOR UPDATE`,
      [toonies.id, input.catalogueItemId, input.productId],
    );
    const parentLinks = (await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM supplier_product_links
        WHERE supplier_id=$1 AND catalogue_item_id=$2 AND product_id=$3
          AND variant_id IS NULL AND catalogue_variant_id IS NULL`,
      [toonies.id, input.catalogueItemId, input.productId],
    )).rows[0]!.count;
    if (parentLinks !== 1) throw new AppError(409, "SUPPLIER_PARENT_LINK_INVALID", "The product does not have exactly one canonical Toonies catalogue link.");
    const rawVariantLinkCount = (await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM supplier_product_links
        WHERE supplier_id=$1 AND catalogue_item_id=$2 AND product_id=$3
          AND (variant_id IS NOT NULL OR catalogue_variant_id IS NOT NULL)`,
      [toonies.id, input.catalogueItemId, input.productId],
    )).rows[0]!.count;
    const linkedVariants = (await db.query<{
      variantId: string;
      localSku: string;
      supplierSku: string;
      attributes: unknown;
    }>(
      `SELECT l.variant_id AS "variantId",pv.sku AS "localSku",scv.sku_code AS "supplierSku",scv.attributes
         FROM supplier_product_links l
         JOIN product_variants pv ON pv.id=l.variant_id AND pv.product_id=l.product_id
         JOIN supplier_catalogue_variants scv
           ON scv.id=l.catalogue_variant_id
          AND scv.supplier_id=l.supplier_id
          AND scv.catalogue_item_id=l.catalogue_item_id
        WHERE l.supplier_id=$1 AND l.catalogue_item_id=$2 AND l.product_id=$3
          AND l.variant_id IS NOT NULL AND l.catalogue_variant_id IS NOT NULL
        ORDER BY l.variant_id
        FOR UPDATE OF l,scv`,
      [toonies.id, input.catalogueItemId, input.productId],
    )).rows;
    if (!linkedVariants.length) throw new AppError(409, "SUPPLIER_VARIANT_LINKS_MISSING", "The linked product has no supplier-linked variants to reconcile.");
    if (linkedVariants.length !== rawVariantLinkCount) throw new AppError(409, "SUPPLIER_VARIANT_LINK_INVALID", "A Toonies variant link is incomplete or points outside the linked product.");
    for (const variant of linkedVariants) {
      if (variant.localSku !== `TOONIES-${variant.supplierSku}`.slice(0, 100)) {
        throw new AppError(409, "SUPPLIER_VARIANT_IDENTITY_MISMATCH", "A linked product variant does not match its authoritative Toonies SKU.");
      }
    }
    await db.query(
      "SELECT id FROM product_variants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [linkedVariants.map((variant) => variant.variantId)],
    );
    const before = await linkedStructuredOptionSummary(db, toonies.id, input.catalogueItemId, input.productId);
    let relationshipsCreated = 0;
    let relationshipsReplaced = 0;
    let relationshipsUnchanged = 0;
    for (const variant of linkedVariants) {
      const outcome = await reconcileStructuredSupplierOptionsNarrow(db, variant.variantId, variant.attributes);
      relationshipsCreated += outcome.created;
      relationshipsReplaced += outcome.replaced;
      relationshipsUnchanged += outcome.unchanged;
    }
    const after = await linkedStructuredOptionSummary(db, toonies.id, input.catalogueItemId, input.productId);
    const relationshipsBefore = before.reduce((total, variant) => total + variant.options.length, 0);
    const relationshipsAfter = after.reduce((total, variant) => total + variant.options.length, 0);
    const result = {
      variantsReconciled: linkedVariants.length,
      relationshipsBefore,
      relationshipsAfter,
      relationshipsCreated,
      relationshipsReplaced,
      relationshipsUnchanged,
    };
    await db.query(
      `INSERT INTO audit_logs(actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json)
       VALUES($1,'supplier.catalogue_structured_options.reconciled','supplier_catalogue_item',$2,$3,$4)`,
      [
        input.actorAdminId,
        input.catalogueItemId,
        JSON.stringify({ productId: input.productId, catalogueItemId: input.catalogueItemId, variants: before }),
        JSON.stringify({ productId: input.productId, catalogueItemId: input.catalogueItemId, variants: after, result }),
      ],
    );
    await db.query("COMMIT");
    return { catalogueItemId: input.catalogueItemId, productId: input.productId, before, after, result };
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    db.release();
  }
}

function serializedClient(client: any): QueryClient {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    query(...args: any[]) {
      const operation = tail.then(() => client.query(...args));
      tail = operation.catch(() => undefined);
      return operation;
    },
  };
}

async function supplierId(clientDb = getDatabasePool()): Promise<string> {
  const result = await clientDb.query<{ id: string }>("SELECT id FROM suppliers WHERE slug=$1 AND active=true", [SUPPLIER_SLUG]);
  if (!result.rows[0]) throw new AppError(503, "SUPPLIER_UNAVAILABLE", "The Toonies supplier integration is not configured.");
  return result.rows[0].id;
}

function supplierError(error: unknown): never {
  if (error instanceof TooniesError) {
    if (error.approvalPending) throw new AppError(503, "APPROVAL_PENDING", "Toonies API access is pending approval.");
    if (error.code === 42901) {
      throw new AppError(503, "TOONIES_RATE_LIMITED", "Toonies temporarily limited catalogue detail requests. Wait one minute, then resume this filtered synchronization.");
    }
    throw new AppError(error.retryable ? 503 : 502, `TOONIES_${error.code}`, error.message);
  }
  throw error;
}

async function withSupplierSyncLease<T>(supplier: string, operation: () => Promise<T>): Promise<T> {
  const leaseClient = await getDatabasePool().connect();
  let acquired = false;
  try {
    const lease = await leaseClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('toonies:sync-supplier'),hashtext($1)) AS acquired",
      [supplier],
    );
    acquired = lease.rows[0]?.acquired === true;
    if (!acquired) {
      throw new AppError(409, "TOONIES_SYNC_ALREADY_RUNNING", "A Toonies catalogue synchronization is already in progress.");
    }
    return await operation();
  } finally {
    if (acquired) {
      await leaseClient.query(
        "SELECT pg_advisory_unlock(hashtext('toonies:sync-supplier'),hashtext($1))",
        [supplier],
      ).catch(() => undefined);
    }
    leaseClient.release();
  }
}

const TOONIES_DETAIL_GATE_INTERVAL_MS = 1_250;
const TOONIES_DETAIL_RATE_LIMIT_COOLDOWN_MS = 60_000;

async function distributedTooniesDetailWithClient(
  productCode: string,
  provider: Pick<TooniesClient, "detail">,
  timing: { intervalMs: number; cooldownMs: number },
): Promise<unknown> {
  const gateClient = await getDatabasePool().connect();
  let acquired = false;
  let releaseDelayMs = timing.intervalMs;
  try {
    await gateClient.query("SELECT pg_advisory_lock(hashtext('toonies:product-detail-rate'))");
    acquired = true;
    return await provider.detail({ product_code: productCode });
  } catch (error) {
    if (error instanceof TooniesError && error.code === 42901) {
      releaseDelayMs = timing.cooldownMs;
    }
    throw error;
  } finally {
    if (acquired) {
      await new Promise((resolve) => setTimeout(resolve, releaseDelayMs));
      await gateClient.query("SELECT pg_advisory_unlock(hashtext('toonies:product-detail-rate'))").catch(() => undefined);
    }
    gateClient.release();
  }
}

async function distributedTooniesDetail(productCode: string): Promise<unknown> {
  return distributedTooniesDetailWithClient(productCode, getTooniesClient(), {
    intervalMs: TOONIES_DETAIL_GATE_INTERVAL_MS,
    cooldownMs: TOONIES_DETAIL_RATE_LIMIT_COOLDOWN_MS,
  });
}

/** Transactional integration-test seam for proving cross-client DB gate behavior. */
export async function testDistributedTooniesDetailGate(
  productCode: string,
  provider: Pick<TooniesClient, "detail">,
  timing: { intervalMs: number; cooldownMs: number },
): Promise<unknown> {
  if (process.env.NODE_ENV !== "test") throw new Error("Distributed Toonies detail gate test seam is test-only.");
  return distributedTooniesDetailWithClient(productCode, provider, timing);
}
async function finalizeTooniesSearchRun(runId: string, error: unknown, stage: string): Promise<void> {
  const errorCode = error instanceof TooniesError && error.code === 42901
    ? "TOONIES_RATE_LIMITED"
    : error instanceof AppError ? error.code : "SYNC_FAILED";
  const message = errorCode === "TOONIES_RATE_LIMITED"
    ? "Toonies rate limited authoritative product detail retrieval."
    : "Filtered catalogue synchronization failed before completion.";
  logger.error("Toonies filtered synchronization processing failed", { runId, stage, errorCode });
  await getDatabasePool().query(
    `UPDATE supplier_fx_normalization_runs
        SET status='failed',error_code=$1,error_message=$2,
            completed_at=COALESCE(completed_at,now()),updated_at=now()
      WHERE supplier_sync_run_id=$3 AND status='running'`,
    [errorCode, message, runId],
  ).catch(() => undefined);
  await getDatabasePool().query(
    `UPDATE supplier_sync_runs
        SET status='failed',error_count=error_count+1,error_code=$1,error_message=$2,
            completed_at=COALESCE(completed_at,now()),updated_at=now()
      WHERE id=$3 AND status IN ('running','partial')`,
    [errorCode, message, runId],
  ).catch(() => undefined);
}

export async function tooniesOverview() {
  const id = await supplierId();
  const [catalogue, runs, mappings, fx] = await Promise.all([
    getDatabasePool().query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE state='Synced')::int AS synced, count(*) FILTER (WHERE state='Needs review')::int AS needs_review, count(*) FILTER (WHERE state='Out of stock')::int AS out_of_stock FROM supplier_catalogue_items WHERE supplier_id=$1`, [id]),
    getDatabasePool().query(`SELECT id, operation, status, keyword, category_id AS "categoryId", page_size AS "pageSize", next_page AS "nextPage", next_cursor AS "nextCursor", page_count AS "pageCount", item_count AS "itemCount", processed_count AS "processedCount", expected_count AS "expectedCount", expected_pages AS "expectedPages", provider_end_authoritative AS "providerEndAuthoritative", error_count AS "errorCount", error_code AS "errorCode", error_message AS "errorMessage", started_at AS "startedAt", completed_at AS "completedAt" FROM supplier_sync_runs WHERE supplier_id=$1 ORDER BY started_at DESC LIMIT 20`, [id]),
    getDatabasePool().query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='mapped')::int AS mapped, count(*) FILTER (WHERE status='needs_review')::int AS needs_review FROM supplier_category_mappings WHERE supplier_id=$1`, [id]),
    getFxStatus(),
  ]);
  return { supplier: { id, slug: SUPPLIER_SLUG, access: getTooniesClient().approvalPending ? "approval_pending" : "configured" }, fx, catalogue: catalogue.rows[0], mappings: mappings.rows[0], syncRuns: runs.rows };
}

export async function listTooniesCategoryMappings(input: { page?: number; pageSize?: number; search?: string; status?: "mapped" | "unmapped" | "ignored" | "needs_review" } = {}) {
  const supplier = await supplierId();
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(input.pageSize ?? 20)));
  const values: unknown[] = [supplier];
  const clauses = ["m.supplier_id=$1"];
  if (input.search?.trim()) {
    values.push(`%${input.search.trim()}%`);
    clauses.push(`(m.external_category_id ILIKE $${values.length} OR m.external_category_name ILIKE $${values.length} OR m.external_category_path ILIKE $${values.length})`);
  }
  if (input.status) {
    values.push(input.status);
    clauses.push(`m.status=$${values.length}::supplier_mapping_status`);
  }
  const where = clauses.join(" AND ");
  const [count, mappings] = await Promise.all([
    getDatabasePool().query<{ count: number }>(`SELECT count(*)::int AS count FROM supplier_category_mappings m WHERE ${where}`, values),
    getDatabasePool().query(`
      SELECT m.id,m.external_category_id AS "externalCategoryId",
             CASE WHEN btrim(m.external_category_name)=btrim(m.external_category_id) THEN NULL ELSE NULLIF(btrim(m.external_category_name),'') END AS "externalCategoryName",
             m.external_category_path AS "externalCategoryPath",
             m.status,m.publication_enabled AS "publicationEnabled",m.compliance_excluded AS "complianceExcluded",
             m.root_category_id AS "rootCategoryId",root.name AS "rootCategoryName",
             m.child_category_id AS "childCategoryId",child.name AS "childCategoryName",
             m.metadata,m.updated_at AS "updatedAt"
        FROM supplier_category_mappings m
        LEFT JOIN categories root ON root.id=m.root_category_id
        LEFT JOIN categories child ON child.id=m.child_category_id
       WHERE ${where}
       ORDER BY m.external_category_id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    ),
  ]);
  const externalCategoryIds = mappings.rows.map((row: any) => row.externalCategoryId);
  const samples = externalCategoryIds.length ? await getDatabasePool().query(`
    SELECT ranked.id,ranked.external_category_id AS "externalCategoryId",ranked.title,
           ranked.external_product_id AS "productCode",ranked.image_urls->>0 AS "thumbnailUrl"
      FROM (
        SELECT i.*,row_number() OVER (
          PARTITION BY i.external_category_id ORDER BY i.updated_at DESC,i.id
        ) AS sample_rank
          FROM supplier_catalogue_items i
         WHERE i.supplier_id=$1 AND i.external_category_id=ANY($2::varchar[])
      ) ranked
     WHERE ranked.sample_rank<=5
     ORDER BY ranked.external_category_id,ranked.sample_rank`, [supplier, externalCategoryIds]) : { rows: [] };
  const samplesByCategory = new Map<string, any[]>();
  for (const sample of samples.rows as any[]) {
    const grouped = samplesByCategory.get(sample.externalCategoryId) ?? [];
    grouped.push(sample);
    samplesByCategory.set(sample.externalCategoryId, grouped);
  }
  const total = Number(count.rows[0]?.count ?? 0);
  return {
    items: mappings.rows.map((row: any) => ({ ...row, sampleProducts: samplesByCategory.get(row.externalCategoryId) ?? [] })),
    meta: { page, pageSize, total, hasNext: page * pageSize < total },
  };
}

export async function listTooniesSyncRuns() {
  const supplier = await supplierId();
  return (await getDatabasePool().query(`SELECT id,operation,status,keyword,category_id AS "categoryId",page_size AS "pageSize",next_page AS "nextPage",next_cursor AS "nextCursor",page_count AS "pageCount",item_count AS "itemCount",processed_count AS "processedCount",expected_count AS "expectedCount",expected_pages AS "expectedPages",provider_end_authoritative AS "providerEndAuthoritative",error_count AS "errorCount",error_code AS "errorCode",error_message AS "errorMessage",started_at AS "startedAt",completed_at AS "completedAt" FROM supplier_sync_runs WHERE supplier_id=$1 ORDER BY started_at DESC LIMIT 100`, [supplier])).rows;
}

export async function listTooniesCatalogue(input: {
  page?: number;
  pageSize?: number;
  state?: string;
  search?: string;
  mapping?: "all" | "mapped" | "unmapped";
  categoryId?: string;
} = {}) {
  const id = await supplierId();
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 25)));
  const values: unknown[] = [id];
  const clauses = ["i.supplier_id=$1"];
  if (input.state) { values.push(input.state); clauses.push(`i.state=$${values.length}::supplier_sync_state`); }
  if (input.search?.trim()) { values.push(`%${input.search.trim()}%`); clauses.push(`(i.title ILIKE $${values.length} OR i.external_product_id ILIKE $${values.length})`); }
  if (input.mapping === "mapped") clauses.push(`m.status='mapped' AND m.root_category_id IS NOT NULL`);
  if (input.mapping === "unmapped") clauses.push(`(m.id IS NULL OR m.status<>'mapped' OR m.root_category_id IS NULL)`);
  if (input.categoryId) {
    values.push(input.categoryId);
    clauses.push(`COALESCE(m.child_category_id,m.root_category_id)=$${values.length}::uuid`);
  }
  const joins = `
    LEFT JOIN supplier_category_mappings m
      ON m.supplier_id=i.supplier_id AND m.external_category_id=i.external_category_id
    LEFT JOIN categories root ON root.id=m.root_category_id
    LEFT JOIN categories child ON child.id=m.child_category_id`;
  const where = clauses.join(" AND ");
  const [count, mappedCategories] = await Promise.all([
    getDatabasePool().query(`SELECT count(*)::int AS count FROM supplier_catalogue_items i ${joins} WHERE ${where}`, values),
    getDatabasePool().query(`
      SELECT DISTINCT COALESCE(child.id,root.id) AS id,
             CASE WHEN child.id IS NULL THEN root.name ELSE root.name || ' / ' || child.name END AS label
        FROM supplier_category_mappings m
        JOIN categories root ON root.id=m.root_category_id
        LEFT JOIN categories child ON child.id=m.child_category_id
       WHERE m.supplier_id=$1 AND m.status='mapped'
       ORDER BY label`, [id]),
  ]);
  const rowValues = [...values, pageSize, (page - 1) * pageSize];
  const rows = await getDatabasePool().query(`
    SELECT i.id, i.external_product_id AS "externalProductId",
           i.external_category_id AS "externalCategoryId",
           m.status AS "categoryMappingStatus",
           m.root_category_id AS "mappedRootCategoryId",
           m.child_category_id AS "mappedChildCategoryId",
           CASE
             WHEN m.status='mapped' AND root.id IS NOT NULL
             THEN CASE WHEN child.id IS NULL THEN root.name ELSE root.name || ' / ' || child.name END
             ELSE NULL
           END AS "mappedCategoryPath",
           i.title, i.original_amount AS "originalAmount", i.original_currency AS "originalCurrency",
           i.normalized_eur AS "normalizedEur", i.normalized_currency AS "normalizedCurrency",
           i.minimum_order_quantity AS "minimumOrderQuantity", i.supplier_raw_moq AS "supplierRawMoq",
           i.fx_rate_snapshot_id AS "fxRateSnapshotId", i.fx_rate_used AS "fxRateUsed",
           i.fx_source AS "fxSource", i.fx_observed_at AS "fxObservedAt",
           i.fx_fetched_at AS "fxFetchedAt", i.fx_normalization_error AS "fxNormalizationError",
           i.manual_selling_price_eur AS "manualSellingPriceEur", i.state,
           i.needs_review AS "needsReview", i.manual_cost_override_eur AS "manualCostOverrideEur",
           i.last_seen_at AS "lastSeenAt",
           (SELECT count(*) FROM supplier_catalogue_variants v WHERE v.catalogue_item_id=i.id)::int AS "variantCount"
      FROM supplier_catalogue_items i
      ${joins}
     WHERE ${where}
     ORDER BY i.updated_at DESC,i.id
     LIMIT $${rowValues.length - 1} OFFSET $${rowValues.length}`, rowValues);
  const total = Number(count.rows[0]?.count ?? 0);
  return {
    items: rows.rows,
    meta: { page, pageSize, total, hasNext: page * pageSize < total },
    filters: { mappedCategories: mappedCategories.rows },
  };
}

export async function getTooniesCatalogueDetail(id: string) {
  const supplier = await supplierId();
  const item = await getDatabasePool().query(`SELECT id, external_product_id AS "externalProductId", external_category_id AS "externalCategoryId", title, description, image_urls AS "imageUrls", original_amount AS "originalAmount", original_currency AS "originalCurrency", normalized_eur AS "normalizedEur", normalized_currency AS "normalizedCurrency", minimum_order_quantity AS "minimumOrderQuantity", supplier_raw_moq AS "supplierRawMoq", fx_rate_snapshot_id AS "fxRateSnapshotId", fx_rate_used AS "fxRateUsed", fx_source AS "fxSource", fx_observed_at AS "fxObservedAt", fx_fetched_at AS "fxFetchedAt", fx_normalization_error AS "fxNormalizationError", manual_selling_price_eur AS "manualSellingPriceEur", state, needs_review AS "needsReview", manual_cost_override_eur AS "manualCostOverrideEur", last_seen_at AS "lastSeenAt" FROM supplier_catalogue_items WHERE id=$1 AND supplier_id=$2`, [id, supplier]);
  if (!item.rows[0]) throw new AppError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "The supplier catalogue item was not found.");
  const variants = await getDatabasePool().query(`SELECT id, external_variant_id AS "externalVariantId", sku_code AS "skuCode", title, attributes, original_amount AS "originalAmount", original_currency AS "originalCurrency", normalized_eur AS "normalizedEur", normalized_currency AS "normalizedCurrency", minimum_order_quantity AS "minimumOrderQuantity", supplier_raw_moq AS "supplierRawMoq", fx_rate_snapshot_id AS "fxRateSnapshotId", fx_rate_used AS "fxRateUsed", fx_source AS "fxSource", fx_observed_at AS "fxObservedAt", fx_fetched_at AS "fxFetchedAt", fx_normalization_error AS "fxNormalizationError", manual_selling_price_eur AS "manualSellingPriceEur", stock, weight_kg AS "weightKg", image_url AS "imageUrl", state, needs_review AS "needsReview", manual_cost_override_eur AS "manualCostOverrideEur" FROM supplier_catalogue_variants WHERE catalogue_item_id=$1 ORDER BY sku_code`, [id]);
  return { ...item.rows[0], variants: variants.rows };
}

export async function setTooniesNormalizedCost(catalogueId: string, normalizedEur: number) {
  void catalogueId;
  void normalizedEur;
  throw new AppError(410, "FX_MANUAL_NORMALIZATION_DISABLED", "Manual normalized costs are disabled. Refresh the authoritative ECB rate or use an explicit cost override.");
}

export async function setTooniesVariantNormalizedCost(variantId: string, normalizedEur: number) {
  void variantId;
  void normalizedEur;
  throw new AppError(410, "FX_MANUAL_NORMALIZATION_DISABLED", "Manual normalized costs are disabled. Refresh the authoritative ECB rate or use an explicit cost override.");
}

export async function setTooniesSellingPrice(catalogueId: string, sellingPriceEur: number | null) {
  const supplier = await supplierId();
  if (sellingPriceEur !== null && (!Number.isFinite(sellingPriceEur) || sellingPriceEur < 0)) throw new AppError(400, "INVALID_SELLING_PRICE", "Selling price must be nonnegative.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM supplier_product_links WHERE catalogue_item_id=$1 AND supplier_id=$2 AND catalogue_variant_id IS NULL ORDER BY id FOR UPDATE", [catalogueId, supplier]);
    await client.query("SELECT p.id FROM products p JOIN supplier_product_links l ON l.product_id=p.id WHERE l.catalogue_item_id=$1 AND l.supplier_id=$2 AND l.catalogue_variant_id IS NULL ORDER BY p.id FOR UPDATE OF p", [catalogueId, supplier]);
    const row = (await client.query("SELECT COALESCE(manual_cost_override_eur,normalized_eur) AS cost FROM supplier_catalogue_items WHERE id=$1 AND supplier_id=$2 FOR UPDATE", [catalogueId, supplier])).rows[0];
    if (!row) throw new AppError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "The supplier catalogue item was not found.");
    if (sellingPriceEur !== null) assertMerchandisePriceFloor({ unitCost: Number(row.cost), merchandiseRevenue: sellingPriceEur, code: "MANUAL_PRICE_BELOW_COST", message: "The manual selling price cannot be below the current merchandise cost." });
    const result = await client.query("UPDATE supplier_catalogue_items SET manual_selling_price_eur=$1,updated_at=now() WHERE id=$2 AND supplier_id=$3 RETURNING id", [sellingPriceEur, catalogueId, supplier]);
    await client.query("UPDATE supplier_product_links SET manual_selling_price_eur=$1,updated_at=now() WHERE catalogue_item_id=$2 AND supplier_id=$3 AND catalogue_variant_id IS NULL", [sellingPriceEur, catalogueId, supplier]);
    if (sellingPriceEur !== null) await client.query("UPDATE products p SET base_price=$1,updated_at=now() FROM supplier_product_links l WHERE l.product_id=p.id AND l.catalogue_item_id=$2 AND l.supplier_id=$3 AND l.catalogue_variant_id IS NULL", [sellingPriceEur, catalogueId, supplier]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function setTooniesVariantSellingPrice(variantId: string, sellingPriceEur: number | null) {
  const supplier = await supplierId();
  if (sellingPriceEur !== null && (!Number.isFinite(sellingPriceEur) || sellingPriceEur < 0)) throw new AppError(400, "INVALID_SELLING_PRICE", "Selling price must be nonnegative.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM supplier_product_links WHERE catalogue_variant_id=$1 AND supplier_id=$2 ORDER BY id FOR UPDATE", [variantId, supplier]);
    await client.query("SELECT p.id FROM products p JOIN supplier_product_links l ON l.product_id=p.id WHERE l.catalogue_variant_id=$1 AND l.supplier_id=$2 ORDER BY p.id FOR UPDATE OF p", [variantId, supplier]);
    await client.query("SELECT pv.id FROM product_variants pv JOIN supplier_product_links l ON l.variant_id=pv.id WHERE l.catalogue_variant_id=$1 AND l.supplier_id=$2 ORDER BY pv.id FOR UPDATE OF pv", [variantId, supplier]);
    const row = (await client.query("SELECT COALESCE(v.manual_cost_override_eur,v.normalized_eur,i.manual_cost_override_eur,i.normalized_eur) AS cost FROM supplier_catalogue_variants v JOIN supplier_catalogue_items i ON i.id=v.catalogue_item_id WHERE v.id=$1 AND v.supplier_id=$2 FOR UPDATE OF i,v", [variantId, supplier])).rows[0];
    if (!row) throw new AppError(404, "SUPPLIER_VARIANT_NOT_FOUND", "The supplier catalogue variant was not found.");
    if (sellingPriceEur !== null) assertMerchandisePriceFloor({ unitCost: Number(row.cost), merchandiseRevenue: sellingPriceEur, code: "MANUAL_PRICE_BELOW_COST", message: "The manual selling price cannot be below the current merchandise cost." });
    const result = await client.query("UPDATE supplier_catalogue_variants SET manual_selling_price_eur=$1,updated_at=now() WHERE id=$2 AND supplier_id=$3 RETURNING id", [sellingPriceEur, variantId, supplier]);
    await client.query("UPDATE supplier_product_links SET manual_selling_price_eur=$1,updated_at=now() WHERE catalogue_variant_id=$2 AND supplier_id=$3", [sellingPriceEur, variantId, supplier]);
    if (sellingPriceEur !== null) await client.query("UPDATE product_variants pv SET base_price=$1,updated_at=now() FROM supplier_product_links l WHERE l.variant_id=pv.id AND l.catalogue_variant_id=$2 AND l.supplier_id=$3", [sellingPriceEur, variantId, supplier]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function categoryFromResponse(data: any): string | null {
  const value = data?.category_id;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 255) : null;
}

type FxContext = { snapshot?: FxSnapshot; errorCode?: string };

export function parseTooniesCnyAmount(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new AppError(502, "TOONIES_UNSAFE_NUMERIC_AMOUNT", "Toonies returned a numeric CNY amount that cannot be represented exactly; a decimal string is required.");
    }
    const rendered = String(value);
    const significantDigits = rendered.replace(".", "").replace(/^0+/, "").length;
    if (rendered.includes("e") || significantDigits > 15) {
      throw new AppError(502, "TOONIES_UNSAFE_NUMERIC_AMOUNT", "Toonies returned a numeric CNY amount that cannot be represented exactly; a decimal string is required.");
    }
  }
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/.test(text)) throw new AppError(502, "TOONIES_INVALID_AMOUNT", "Toonies returned a CNY amount outside the exact supported decimal range.");
  return text;
}

function normalizedEurAmount(amount: string, fxRate: string): string {
  const normalized = normalizeCnyToEur(amount, fxRate);
  const [integer = ""] = normalized.split(".");
  if (integer.length > 10) {
    throw new AppError(502, "FX_NORMALIZED_AMOUNT_OUT_OF_RANGE", "The normalized EUR cost exceeds the supported monetary range.");
  }
  return normalized;
}

function normalizedAmount(amount: string, fx: FxContext): string | null {
  return fx.snapshot ? normalizedEurAmount(amount, fx.snapshot.rate) : null;
}

async function ingestItem(db: any, supplier: string, data: any, runId?: string, fx: FxContext = {}) {
  const external = String(data.product_code ?? "").slice(0, 255);
  if (!external) throw new AppError(502, "TOONIES_INVALID_PRODUCT", "Toonies returned a product without a product code.");
  const amountText = parseTooniesCnyAmount(data.charge ?? data.min_price ?? 0);
  const currency = String(data.currency ?? "CNY").toUpperCase();
  if (currency !== "CNY") throw new AppError(502, "TOONIES_INVALID_CURRENCY", "Toonies catalogue costs must be CNY.");
  const normalized = normalizedAmount(amountText, fx);
  const fxValues = fx.snapshot
    ? [fx.snapshot.id, fx.snapshot.rate, fx.snapshot.source, fx.snapshot.observedAt, fx.snapshot.fetchedAt, null]
    : [null, null, null, null, null, fx.errorCode ?? "FX_RATE_UNAVAILABLE"];
  const category = categoryFromResponse(data);
  const itemMoq = parseTooniesMoq(data.moq ?? data.minimum_order_quantity ?? data.min_order_quantity);
  const reportedSkus = Array.isArray(data.skus) ? data.skus : [];
  const stock = reportedSkus.length ? reportedSkus.reduce((sum: number, sku: any) => sum + (Number.isFinite(sku.stock) ? Math.max(0, Math.trunc(sku.stock)) : 0), 0) : Number.isFinite(data.stock) ? Math.max(0, Math.trunc(data.stock)) : 0;
  const payload = boundedPayload(data);
  const existing = await db.query(`SELECT id, state, raw_payload AS "rawPayload" FROM supplier_catalogue_items WHERE supplier_id=$1 AND external_product_id=$2 FOR UPDATE`, [supplier, external]);
  let id: string;
  if (existing.rows[0]) {
    id = existing.rows[0].id;
    const changed = JSON.stringify(existing.rows[0].rawPayload) !== JSON.stringify(payload);
    const out = data.available === false || stock <= 0;
    const nextState = out ? "Out of stock" : changed ? "Changed" : existing.rows[0].state;
     await db.query(`UPDATE supplier_catalogue_items SET external_category_id=$1,title=$2,description=$3,image_urls=$4,original_amount=$5,original_currency='CNY',normalized_eur=$6,normalized_currency=$7,fx_rate_snapshot_id=$8,fx_rate_used=$9,fx_source=$10,fx_observed_at=$11,fx_fetched_at=$12,fx_normalization_error=$13,stock=$14,minimum_order_quantity=$15,supplier_raw_moq=$16,state=$17,needs_review=true,raw_payload=$18,last_seen_at=now(),updated_at=now() WHERE id=$19`, [category, String(data.title_trans ?? data.title ?? external).slice(0, 500), typeof data.description === "string" ? data.description.slice(0, 20_000) : null, JSON.stringify(images(data.images ?? (data.image ? [data.image] : []))), amountText, normalized, normalized ? "EUR" : null, ...fxValues, stock, itemMoq.value, itemMoq.raw === null ? null : JSON.stringify(itemMoq.raw), fx.snapshot ? nextState : "Needs review", payload, id]);
    if (changed || out) await db.query("INSERT INTO supplier_sync_history(supplier_id,catalogue_item_id,previous_state,next_state,previous_payload,next_payload,change_reason) VALUES($1,$2,$3,$4,$5,$6,$7)", [supplier, id, existing.rows[0].state, nextState, existing.rows[0].rawPayload, payload, out ? "stock" : "supplier_payload"]);
  } else {
     const inserted = await db.query(`INSERT INTO supplier_catalogue_items(supplier_id,external_product_id,external_category_id,title,description,image_urls,original_amount,original_currency,normalized_eur,normalized_currency,fx_rate_snapshot_id,fx_rate_used,fx_source,fx_observed_at,fx_fetched_at,fx_normalization_error,stock,minimum_order_quantity,supplier_raw_moq,state,needs_review,raw_payload,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,'CNY',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true,$20,now()) RETURNING id`, [supplier, external, category, String(data.title_trans ?? data.title ?? external).slice(0, 500), typeof data.description === "string" ? data.description.slice(0, 20_000) : null, JSON.stringify(images(data.images ?? (data.image ? [data.image] : []))), amountText, normalized, normalized ? "EUR" : null, ...fxValues, stock, itemMoq.value, itemMoq.raw === null ? null : JSON.stringify(itemMoq.raw), fx.snapshot ? (stock <= 0 ? "Out of stock" : "Needs review") : "Needs review", payload]);
    id = inserted.rows[0].id;
  }
  if (category !== null) {
    await db.query(`INSERT INTO supplier_category_mappings(supplier_id,external_category_id,external_category_name,status,publication_enabled,compliance_excluded,metadata) VALUES($1,$2,$2,'needs_review',false,true,$3) ON CONFLICT(supplier_id,external_category_id) DO NOTHING`, [supplier, category, JSON.stringify({ source: "toonies_response", authoritative: true })]);
  }
  const skus = reportedSkus;
  const authoritativeVariantIds: string[] = [];
  for (const sku of skus) {
    const skuCode = String(sku.sku_code ?? "").slice(0, 255);
    if (!skuCode) continue;
     const skuAmountText = parseTooniesCnyAmount(sku.charge ?? amountText);
     const skuNormalized = normalizedAmount(skuAmountText, fx);
      const skuRawMoq = sku.moq ?? sku.minimum_order_quantity ?? sku.min_order_quantity;
      const skuMoq = skuRawMoq === undefined ? { value: itemMoq.value, raw: null } : parseTooniesMoq(skuRawMoq);
     const variantRow = await db.query(`INSERT INTO supplier_catalogue_variants(supplier_id,catalogue_item_id,external_variant_id,sku_code,title,attributes,original_amount,original_currency,normalized_eur,normalized_currency,fx_rate_snapshot_id,fx_rate_used,fx_source,fx_observed_at,fx_fetched_at,fx_normalization_error,stock,minimum_order_quantity,supplier_raw_moq,weight_kg,image_url,state,needs_review,raw_payload) VALUES($1,$2,$3,$4,$5,$6,$7,'CNY',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'Needs review',true,$21) ON CONFLICT(catalogue_item_id,external_variant_id) DO UPDATE SET sku_code=EXCLUDED.sku_code,title=EXCLUDED.title,attributes=EXCLUDED.attributes,original_amount=EXCLUDED.original_amount,normalized_eur=EXCLUDED.normalized_eur,normalized_currency=EXCLUDED.normalized_currency,fx_rate_snapshot_id=EXCLUDED.fx_rate_snapshot_id,fx_rate_used=EXCLUDED.fx_rate_used,fx_source=EXCLUDED.fx_source,fx_observed_at=EXCLUDED.fx_observed_at,fx_fetched_at=EXCLUDED.fx_fetched_at,fx_normalization_error=EXCLUDED.fx_normalization_error,stock=EXCLUDED.stock,minimum_order_quantity=EXCLUDED.minimum_order_quantity,supplier_raw_moq=EXCLUDED.supplier_raw_moq,weight_kg=EXCLUDED.weight_kg,image_url=EXCLUDED.image_url,state=CASE WHEN $22::boolean THEN CASE WHEN supplier_catalogue_variants.raw_payload IS DISTINCT FROM EXCLUDED.raw_payload THEN 'Changed'::supplier_sync_state ELSE supplier_catalogue_variants.state END ELSE 'Needs review'::supplier_sync_state END,needs_review=true,raw_payload=EXCLUDED.raw_payload,updated_at=now() RETURNING id`, [supplier, id, skuCode, skuCode, typeof sku.spec_desc === "string" ? sku.spec_desc.slice(0, 500) : null, JSON.stringify(boundedPayload(sku.sku_attr ?? [])), skuAmountText, skuNormalized, skuNormalized ? "EUR" : null, ...fxValues, Number.isFinite(sku.stock) ? Math.max(0, Math.trunc(sku.stock)) : 0, skuMoq.value, skuMoq.raw === null ? null : JSON.stringify(skuMoq.raw), parseTooniesWeight(sku.weight), images([sku.image])[0] ?? null, boundedPayload(sku), Boolean(fx.snapshot)]);
    authoritativeVariantIds.push(variantRow.rows[0].id);
  }
  if (authoritativeVariantIds.length) {
    const omitted = await db.query("UPDATE supplier_catalogue_variants SET stock=0,state='Out of stock',needs_review=true,updated_at=now() WHERE catalogue_item_id=$1 AND NOT (id=ANY($2::uuid[])) RETURNING id", [id, authoritativeVariantIds]);
    for (const variant of omitted.rows) await db.query("INSERT INTO supplier_sync_history(supplier_id,catalogue_item_id,catalogue_variant_id,next_state,change_reason) VALUES($1,$2,$3,'Out of stock','omitted_from_authoritative_detail')", [supplier, id, variant.id]);
  } else {
    const omitted = await db.query("UPDATE supplier_catalogue_variants SET stock=0,state='Out of stock',needs_review=true,updated_at=now() WHERE catalogue_item_id=$1 RETURNING id", [id]);
    for (const variant of omitted.rows) await db.query("INSERT INTO supplier_sync_history(supplier_id,catalogue_item_id,catalogue_variant_id,next_state,change_reason) VALUES($1,$2,$3,'Out of stock','omitted_from_authoritative_detail')", [supplier, id, variant.id]);
  }
  if (runId) await db.query(`UPDATE supplier_sync_runs SET item_count=item_count+1,updated_at=now() WHERE id=$1`, [runId]);
  return id;
}

async function beginFxNormalizationRun(supplier: string, syncRunId: string | null): Promise<string | null> {
  const result = await getDatabasePool().query<{ id: string }>(
    "INSERT INTO supplier_fx_normalization_runs(supplier_id,supplier_sync_run_id,status) VALUES($1,$2,'running') RETURNING id",
    [supplier, syncRunId],
  );
  return result.rows[0]?.id ?? null;
}

async function resolveRunFx(supplier: string, syncRunId: string | null, normalizationRunId: string | null): Promise<FxContext> {
  try {
    const snapshot = await getCurrentFxSnapshot();
    if (syncRunId) await getDatabasePool().query("UPDATE supplier_sync_runs SET fx_rate_snapshot_id=$1,updated_at=now() WHERE id=$2", [snapshot.id, syncRunId]);
    if (normalizationRunId) await getDatabasePool().query("UPDATE supplier_fx_normalization_runs SET fx_rate_snapshot_id=$1,updated_at=now() WHERE id=$2", [snapshot.id, normalizationRunId]);
    return { snapshot };
  } catch (error) {
    const errorCode = error instanceof FxUnavailableError ? error.code : "FX_RATE_UNAVAILABLE";
    return { errorCode };
  }
}

async function finishFxNormalizationRun(id: string | null, fx: FxContext, itemCount: number, variantCount: number): Promise<void> {
  if (!id) return;
  await getDatabasePool().query(
    "UPDATE supplier_fx_normalization_runs SET status=$1,item_count=$2,variant_count=$3,error_code=$4,error_message=$5,completed_at=now(),updated_at=now() WHERE id=$6",
    [fx.snapshot ? "completed" : "failed", itemCount, variantCount, fx.errorCode ?? null, fx.snapshot ? null : "A fresh ECB CNY/EUR observation was not available; EUR normalization was not applied.", id],
  );
}

const TOONIES_SYNC_PAGE_BATCH = 5;

type TooniesSyncRun = {
  id: string;
  supplierId: string;
  status: string;
  keyword: string | null;
  categoryId: string | null;
  pageSize: number;
  nextPage: number;
  nextCursor: string | null;
  pageCount: number;
  itemCount: number;
  processedCount: number;
  expectedCount: number | null;
  expectedPages: number | null;
  providerEndAuthoritative: boolean;
  normalizationRunId: string | null;
};

async function getTooniesSyncRun(runId: string): Promise<TooniesSyncRun> {
  const result = await getDatabasePool().query<TooniesSyncRun>(
    `SELECT r.id,r.supplier_id AS "supplierId",r.status,r.keyword,r.category_id AS "categoryId",
            r.page_size AS "pageSize",r.next_page AS "nextPage",r.next_cursor AS "nextCursor",
            r.page_count AS "pageCount",r.item_count AS "itemCount",
            r.processed_count AS "processedCount",r.expected_count AS "expectedCount",
             r.expected_pages AS "expectedPages",r.provider_end_authoritative AS "providerEndAuthoritative",
            n.id AS "normalizationRunId"
       FROM supplier_sync_runs r
       LEFT JOIN supplier_fx_normalization_runs n ON n.supplier_sync_run_id=r.id
      WHERE r.id=$1 AND r.operation='catalogue'`,
    [runId],
  );
  const run = result.rows[0];
  if (!run) throw new AppError(404, "SUPPLIER_SYNC_RUN_NOT_FOUND", "The Toonies synchronization run was not found.");
  return run;
}

function authoritativeSearchEnd(data: any, page: number, pageSize: number, itemCount: number): {
  expectedCount: number | null;
  expectedPages: number | null;
  nextCursor: string | null;
  ended: boolean;
} {
  const rawPages = data?.total_page ?? data?.totalPage;
  const rawTotal = data?.total;
  const reportedPages = Number(rawPages);
  const reportedTotal = Number(rawTotal);
  const hasTotalPages = rawPages !== null && rawPages !== undefined && rawPages !== "" && Number.isInteger(reportedPages) && reportedPages >= 0;
  const hasTotal = rawTotal !== null && rawTotal !== undefined && rawTotal !== "" && Number.isInteger(reportedTotal) && reportedTotal >= 0;
  const expectedPages = hasTotalPages
    ? Math.max(1, reportedPages)
    : hasTotal ? Math.max(1, Math.ceil(reportedTotal / pageSize)) : null;
  const nextCursorValue = data?.next_cursor ?? data?.nextCursor ?? data?.cursor;
  const nextCursor = typeof nextCursorValue === "string" && nextCursorValue.trim() ? nextCursorValue.slice(0, 512) : null;
  const explicitEnd = data?.has_next === false || data?.hasNext === false || data?.is_last === true || data?.isLast === true;
  const ended = explicitEnd
    || (expectedPages !== null && page >= expectedPages && !nextCursor)
    || (expectedPages === null && !nextCursor && itemCount < pageSize);
  return {
    expectedCount: hasTotal ? reportedTotal : null,
    expectedPages,
    nextCursor,
    ended,
  };
}

async function processTooniesSearchRun(runId: string, maxPages = TOONIES_SYNC_PAGE_BATCH): Promise<Record<string, unknown>> {
  const leaseClient = await getDatabasePool().connect();
  let leaseHeld = false;
  try {
    const lease = await leaseClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('toonies:sync-run'),hashtext($1)) AS acquired",
      [runId],
    );
    leaseHeld = lease.rows[0]?.acquired === true;
    if (!leaseHeld) {
      throw new AppError(409, "SUPPLIER_SYNC_ALREADY_RUNNING", "This synchronization run is already being processed.");
    }
    let normalizationRunId: string | null = null;
    let stage = "run_setup";
    try {
    const run = await getTooniesSyncRun(runId);
  if (run.status === "completed") return run as unknown as Record<string, unknown>;
  await getDatabasePool().query(
    "UPDATE supplier_sync_runs SET status='running',error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
    [runId],
  );
  const supplier = run.supplierId;
  normalizationRunId = run.normalizationRunId ?? await beginFxNormalizationRun(supplier, runId);
  stage = "fx_resolution";
  let fx = await resolveRunFx(supplier, runId, normalizationRunId);
  let current = run;
  let pagesProcessed = 0;
  logger.info("Toonies filtered synchronization processing started", { runId, supplierId: supplier });
    while (pagesProcessed < Math.max(1, Math.min(TOONIES_SYNC_PAGE_BATCH, Math.floor(maxPages)))) {
      const page = current.nextPage;
      stage = "provider_search";
      const data: any = await getTooniesClient().search({
        keyword: current.keyword ?? "",
        page,
        page_size: current.pageSize,
        ...(current.categoryId ? { category_id: current.categoryId } : {}),
        ...(current.nextCursor ? { cursor: current.nextCursor } : {}),
      });
      if (!data || typeof data !== "object" || !Array.isArray(data.items)) {
        throw new AppError(502, "TOONIES_INVALID_SEARCH_RESPONSE", "Toonies returned an invalid paginated search response.");
      }
      const items: any[] = data.items;
      const end = authoritativeSearchEnd(data, page, current.pageSize, items.length);
      // Search rows are discovery metadata only. Detail is authoritative for
      // specs/SKUs and is fetched through the adapter's rate-limited client.
      stage = "provider_detail";
      const detailedItems: any[] = await boundedConcurrent(items, 4, async (item) => {
        const code = String(item.product_code ?? "");
        if (!code) throw new AppError(502, "TOONIES_INVALID_SEARCH_ROW", "Toonies returned a search row without a product code.");
        return distributedTooniesDetail(code);
      });
      const rawDb = await getDatabasePool().connect();
      const db = serializedClient(rawDb);
      try {
        stage = "catalogue_persistence";
        await db.query("BEGIN");
        if (fx.snapshot) {
          const currentFx = await db.query("SELECT id FROM fx_rate_snapshots WHERE id=$1 AND expires_at>now() FOR SHARE", [fx.snapshot.id]);
          if (!currentFx.rows[0]) fx = { errorCode: "FX_RATE_STALE" };
        }
        for (const item of detailedItems) await ingestItem(db, supplier, item, runId, fx);
        const nextPage = page + 1;
        const nextStatus = end.ended ? "completed" : "partial";
        const expectedCount = end.expectedCount ?? current.expectedCount;
        const expectedPages = end.expectedPages ?? current.expectedPages;
        await db.query(
          `UPDATE supplier_sync_runs
              SET status=$2::supplier_sync_run_status,page_count=page_count+1,processed_count=processed_count+$3,
                  expected_count=COALESCE($4,expected_count),expected_pages=COALESCE($5,expected_pages),
                  next_page=$6,next_cursor=$7,provider_end_authoritative=$8,
                  completed_at=CASE WHEN $2::text='completed' THEN now() ELSE NULL END,
                  updated_at=now()
            WHERE id=$1`,
          [runId, nextStatus, items.length, expectedCount, expectedPages, nextPage, end.nextCursor, end.ended],
        );
        await db.query("COMMIT");
        current = {
          ...current,
          status: nextStatus,
          pageCount: current.pageCount + 1,
          processedCount: current.processedCount + items.length,
          expectedCount,
          expectedPages,
          nextPage,
          nextCursor: end.nextCursor,
        };
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        rawDb.release();
      }
      for (const item of detailedItems) {
        const productCode = String(item.product_code ?? "");
        if (productCode) {
          const row = await getDatabasePool().query<{ id: string }>("SELECT id FROM supplier_catalogue_items WHERE supplier_id=$1 AND external_product_id=$2", [supplier, productCode]);
          if (row.rows[0]) await reconcileLinkedCatalogueItem(row.rows[0].id);
        }
      }
      pagesProcessed += 1;
      if (end.ended) {
        stage = "fx_finalization";
        await finishFxNormalizationRun(normalizationRunId, fx, current.processedCount, detailedItems.reduce((count, item: any) => count + (Array.isArray(item?.skus) ? item.skus.length : 0), 0));
        break;
      }
    }
    logger.info("Toonies filtered synchronization processing completed", { runId, supplierId: supplier, pagesProcessed, status: current.status });
    return await getTooniesSyncRun(runId) as unknown as Record<string, unknown>;
  } catch (error) {
    await finalizeTooniesSearchRun(runId, error, stage);
    return supplierError(error);
  }
  } finally {
    if (leaseHeld) {
      await leaseClient.query(
        "SELECT pg_advisory_unlock(hashtext('toonies:sync-run'),hashtext($1))",
        [runId],
      ).catch(() => undefined);
    }
    leaseClient.release();
  }
}

export async function syncTooniesSearch(input: { keyword: string; pageSize?: number; categoryId?: string }) {
  if (typeof input.keyword !== "string" || input.keyword.trim().length < 1 || input.keyword.length > 100) throw new AppError(400, "VALIDATION_ERROR", "A bounded keyword is required for catalogue synchronization.");
  if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 20)) throw new AppError(400, "VALIDATION_ERROR", "Page size must be between 1 and 20.");
  const supplier = await supplierId();
  return withSupplierSyncLease(supplier, async () => {
    const pageSize = Math.min(20, Math.max(1, Math.floor(input.pageSize ?? 20)));
    const run = await getDatabasePool().query(
      `INSERT INTO supplier_sync_runs(supplier_id,operation,keyword,category_id,page_size,next_page,status)
       VALUES($1,'catalogue',$2,$3,$4,1,'running') RETURNING id`,
      [supplier, input.keyword.trim(), input.categoryId ?? null, pageSize],
    );
    const runId = run.rows[0].id;
    try {
      return await processTooniesSearchRun(runId);
    } catch (error) {
      await finalizeTooniesSearchRun(runId, error, "post_insert_lifecycle");
      throw error;
    }
  });
}

/** Resume a failed or partial run without changing its immutable query. */
export async function resumeTooniesSync(runId: string, input?: { keyword?: string; pageSize?: number; categoryId?: string }) {
  const run = await getTooniesSyncRun(runId);
  if (input && (
    (input.keyword !== undefined && input.keyword.trim() !== run.keyword)
    || (input.categoryId !== undefined && (input.categoryId || null) !== run.categoryId)
    || (input.pageSize !== undefined && input.pageSize !== run.pageSize)
  )) {
    throw new AppError(409, "SUPPLIER_SYNC_PARAMETERS_IMMUTABLE", "Synchronization query parameters cannot be changed when resuming a run.");
  }
  if (!["partial", "failed", "running"].includes(run.status)) {
    throw new AppError(409, "SUPPLIER_SYNC_NOT_RESUMABLE", "Only partial, failed, or interrupted synchronization runs can be resumed.");
  }
  return withSupplierSyncLease(run.supplierId, () => processTooniesSearchRun(runId));
}

export async function syncTooniesDetail(productCode: string) {
  if (typeof productCode !== "string" || productCode.length < 1 || productCode.length > 64) throw new AppError(400, "VALIDATION_ERROR", "A bounded product code is required.");
  const supplier = await supplierId();
  const run = await getDatabasePool().query(`INSERT INTO supplier_sync_runs(supplier_id,operation) VALUES($1,'catalogue_detail') RETURNING id`, [supplier]);
  const runId = run.rows[0].id as string;
  const normalizationRunId = await beginFxNormalizationRun(supplier, runId);
  try {
    let fx = await resolveRunFx(supplier, runId, normalizationRunId);
    const data = await distributedTooniesDetail(productCode);
    const rawDb = await getDatabasePool().connect();
    const db = serializedClient(rawDb);
     try { await db.query("BEGIN"); if (fx.snapshot) { const currentFx = await db.query("SELECT id FROM fx_rate_snapshots WHERE id=$1 AND expires_at>now() FOR SHARE", [fx.snapshot.id]); if (!currentFx.rows[0]) fx = { errorCode: "FX_RATE_STALE" }; } const id = await ingestItem(db, supplier, data, runId, fx); await db.query("UPDATE supplier_sync_runs SET status='completed',item_count=1,completed_at=now(),updated_at=now() WHERE id=$1", [runId]); await db.query("COMMIT"); await finishFxNormalizationRun(normalizationRunId, fx, 1, Array.isArray((data as any)?.skus) ? (data as any).skus.length : 0); await reconcileLinkedCatalogueItem(id); return getTooniesCatalogueDetail(id); }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { rawDb.release(); }
   } catch (error) { await getDatabasePool().query("UPDATE supplier_sync_runs SET status='failed',error_count=1,error_message=$1,completed_at=now(),updated_at=now() WHERE id=$2", [error instanceof Error ? error.message.slice(0, 1000) : "Detail sync failed", runId]); await getDatabasePool().query("UPDATE supplier_fx_normalization_runs SET status='failed',error_code='SYNC_FAILED',error_message=$1,completed_at=now(),updated_at=now() WHERE id=$2", [error instanceof Error ? error.message.slice(0, 1000) : "Detail sync failed", normalizationRunId]); supplierError(error); }
}

/**
 * Applies a supplier cost/stock change to linked draft products while
 * retaining manual overrides. A large increase is deliberately held for
 * review instead of silently changing a sell price.
 */
export async function reconcileLinkedCatalogueItem(catalogueItemId: string) {
  const rawDb = await getDatabasePool().connect();
  const db = rawDb;
  let warehouseId: string;
  try {
    await db.query("BEGIN");
  const supplier = await supplierId(db as any);
  let links = (await db.query<any>(`SELECT l.product_id AS "productId",l.variant_id AS "variantId",l.catalogue_variant_id AS "catalogueVariantId",l.manual_selling_price_eur AS "linkManualSellingPriceEur",
    s.active AS "supplierActive",s.publication_enabled AS "supplierPublicationEnabled",s.compliance_excluded AS "supplierComplianceExcluded",
    m.status AS "mappingStatus",m.publication_enabled AS "mappingPublicationEnabled",m.compliance_excluded AS "mappingComplianceExcluded",
    m.root_category_id AS "rootCategoryId",root.active AS "rootActive",root.parent_id AS "rootParentId",
    m.child_category_id AS "childCategoryId",child.active AS "childActive",child.parent_id AS "childParentId",
    i.needs_review AS "itemNeedsReview",i.state AS "itemState",i.stock AS "itemStock",i.minimum_order_quantity AS "itemMoq",
    i.original_amount AS "itemOriginalAmount",i.original_currency AS "itemCurrency",i.normalized_eur AS "itemNormalizedEur",i.fx_rate_snapshot_id AS "itemFxSnapshotId",
    i.manual_cost_override_eur AS "itemManualCostOverrideEur",i.manual_selling_price_eur AS "itemManualSellingPriceEur",
    pv.cost_price AS "variantCost",pv.base_price AS "variantPrice",pv.weight AS "productVariantWeight",pv.active AS "productVariantActive",
    pv.title AS "productVariantTitle",
    p.cost_price AS "productCost",p.base_price AS "productPrice",p.weight AS "productWeight",p.display_weight_kg AS "productDisplayWeight",
    p.status AS "productStatus",p.published_at AS "productPublishedAt",v.original_amount AS "originalAmountCny",v.needs_review AS "variantNeedsReview",
    v.normalized_eur AS "normalizedEur",v.fx_rate_snapshot_id AS "fxRateSnapshotId",v.manual_cost_override_eur AS "manualCostOverrideEur",
    v.attributes AS "variantAttributes",v.title AS "supplierVariantTitle",v.sku_code AS "supplierSkuCode",
    v.manual_selling_price_eur AS "manualSellingPriceEur",v.minimum_order_quantity AS "variantMoq",v.weight_kg AS "variantWeightKg",v.original_currency AS "variantCurrency",v.stock,v.state,
    (itemFx.expires_at>now()) AS "itemFxFresh",(variantFx.expires_at>now()) AS "variantFxFresh",
    itemFx.rate AS "itemFxRate",variantFx.rate AS "variantFxRate",
    COALESCE(variantFx.rate,itemFx.rate) AS "fxRateUsed",COALESCE(variantFx.source,itemFx.source) AS "fxSource",
    COALESCE(variantFx.observed_at,itemFx.observed_at) AS "fxObservedAt",COALESCE(variantFx.fetched_at,itemFx.fetched_at) AS "fxFetchedAt",
    (SELECT h.next_cost_cny FROM supplier_cost_price_history h WHERE h.catalogue_item_id=i.id AND h.catalogue_variant_id IS NOT DISTINCT FROM v.id ORDER BY h.created_at DESC LIMIT 1) AS "previousCostCny"
    FROM supplier_product_links l JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies'
    JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id LEFT JOIN products p ON p.id=l.product_id
    LEFT JOIN product_variants pv ON pv.id=l.variant_id LEFT JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id
    LEFT JOIN supplier_category_mappings m ON m.supplier_id=i.supplier_id AND m.external_category_id=i.external_category_id
    LEFT JOIN categories root ON root.id=m.root_category_id LEFT JOIN categories child ON child.id=m.child_category_id
    LEFT JOIN fx_rate_snapshots itemFx ON itemFx.id=i.fx_rate_snapshot_id
    LEFT JOIN fx_rate_snapshots variantFx ON variantFx.id=v.fx_rate_snapshot_id
   WHERE l.supplier_id=$1 AND l.catalogue_item_id=$2`, [supplier, catalogueItemId])).rows;
  await db.query("SELECT id FROM supplier_product_links WHERE supplier_id=$1 AND catalogue_item_id=$2 ORDER BY id FOR UPDATE", [supplier, catalogueItemId]);
  await db.query("SELECT id FROM products WHERE id IN (SELECT product_id FROM supplier_product_links WHERE supplier_id=$1 AND catalogue_item_id=$2 AND product_id IS NOT NULL) ORDER BY id FOR UPDATE", [supplier, catalogueItemId]);
  await db.query("SELECT id FROM suppliers WHERE id=$1 FOR UPDATE", [supplier]);
  await db.query("SELECT id FROM supplier_category_mappings WHERE supplier_id=$1 AND external_category_id=(SELECT external_category_id FROM supplier_catalogue_items WHERE id=$2) ORDER BY id FOR UPDATE", [supplier, catalogueItemId]);
  await db.query(`SELECT id FROM categories WHERE id IN (
    SELECT root_category_id FROM supplier_category_mappings WHERE supplier_id=$1 AND external_category_id=(SELECT external_category_id FROM supplier_catalogue_items WHERE id=$2)
    UNION
    SELECT child_category_id FROM supplier_category_mappings WHERE supplier_id=$1 AND external_category_id=(SELECT external_category_id FROM supplier_catalogue_items WHERE id=$2)
  ) ORDER BY id FOR UPDATE`, [supplier, catalogueItemId]);
  await db.query("SELECT id FROM supplier_catalogue_items WHERE id=$1 FOR UPDATE", [catalogueItemId]);
  await db.query("SELECT id FROM supplier_catalogue_variants WHERE supplier_id=$1 AND catalogue_item_id=$2 ORDER BY id FOR UPDATE", [supplier, catalogueItemId]);
  await db.query(`SELECT id FROM fx_rate_snapshots WHERE id IN (
    SELECT fx_rate_snapshot_id FROM supplier_catalogue_items WHERE id=$1
    UNION
    SELECT fx_rate_snapshot_id FROM supplier_catalogue_variants WHERE catalogue_item_id=$1
  ) ORDER BY id FOR UPDATE`, [catalogueItemId]);
  await db.query("SELECT id FROM product_variants WHERE id IN (SELECT variant_id FROM supplier_product_links WHERE supplier_id=$1 AND catalogue_item_id=$2 AND variant_id IS NOT NULL) ORDER BY id FOR UPDATE", [supplier, catalogueItemId]);
  links = (await db.query<any>(`SELECT l.product_id AS "productId",l.variant_id AS "variantId",l.catalogue_variant_id AS "catalogueVariantId",l.manual_selling_price_eur AS "linkManualSellingPriceEur",
    s.active AS "supplierActive",s.publication_enabled AS "supplierPublicationEnabled",s.compliance_excluded AS "supplierComplianceExcluded",
    m.status AS "mappingStatus",m.publication_enabled AS "mappingPublicationEnabled",m.compliance_excluded AS "mappingComplianceExcluded",
    m.root_category_id AS "rootCategoryId",root.active AS "rootActive",root.parent_id AS "rootParentId",
    m.child_category_id AS "childCategoryId",child.active AS "childActive",child.parent_id AS "childParentId",
    i.needs_review AS "itemNeedsReview",i.state AS "itemState",i.stock AS "itemStock",i.minimum_order_quantity AS "itemMoq",
    i.original_amount AS "itemOriginalAmount",i.original_currency AS "itemCurrency",i.normalized_eur AS "itemNormalizedEur",i.fx_rate_snapshot_id AS "itemFxSnapshotId",
    i.manual_cost_override_eur AS "itemManualCostOverrideEur",i.manual_selling_price_eur AS "itemManualSellingPriceEur",
    pv.cost_price AS "variantCost",pv.base_price AS "variantPrice",pv.weight AS "productVariantWeight",pv.active AS "productVariantActive",
    pv.title AS "productVariantTitle",
    p.cost_price AS "productCost",p.base_price AS "productPrice",p.weight AS "productWeight",p.display_weight_kg AS "productDisplayWeight",
    p.status AS "productStatus",p.published_at AS "productPublishedAt",v.original_amount AS "originalAmountCny",v.needs_review AS "variantNeedsReview",
    v.normalized_eur AS "normalizedEur",v.fx_rate_snapshot_id AS "fxRateSnapshotId",v.manual_cost_override_eur AS "manualCostOverrideEur",
    v.attributes AS "variantAttributes",v.title AS "supplierVariantTitle",v.sku_code AS "supplierSkuCode",
    v.manual_selling_price_eur AS "manualSellingPriceEur",v.minimum_order_quantity AS "variantMoq",v.weight_kg AS "variantWeightKg",v.original_currency AS "variantCurrency",v.stock,v.state,
    (itemFx.expires_at>now()) AS "itemFxFresh",(variantFx.expires_at>now()) AS "variantFxFresh",
    itemFx.rate AS "itemFxRate",variantFx.rate AS "variantFxRate",
    COALESCE(variantFx.rate,itemFx.rate) AS "fxRateUsed",COALESCE(variantFx.source,itemFx.source) AS "fxSource",
    COALESCE(variantFx.observed_at,itemFx.observed_at) AS "fxObservedAt",COALESCE(variantFx.fetched_at,itemFx.fetched_at) AS "fxFetchedAt",
    (SELECT h.next_cost_cny FROM supplier_cost_price_history h WHERE h.catalogue_item_id=i.id AND h.catalogue_variant_id IS NOT DISTINCT FROM v.id ORDER BY h.created_at DESC LIMIT 1) AS "previousCostCny"
    FROM supplier_product_links l JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies'
    JOIN supplier_catalogue_items i ON i.id=l.catalogue_item_id LEFT JOIN products p ON p.id=l.product_id
    LEFT JOIN product_variants pv ON pv.id=l.variant_id LEFT JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id
    LEFT JOIN supplier_category_mappings m ON m.supplier_id=i.supplier_id AND m.external_category_id=i.external_category_id
    LEFT JOIN categories root ON root.id=m.root_category_id LEFT JOIN categories child ON child.id=m.child_category_id
    LEFT JOIN fx_rate_snapshots itemFx ON itemFx.id=i.fx_rate_snapshot_id
    LEFT JOIN fx_rate_snapshots variantFx ON variantFx.id=v.fx_rate_snapshot_id
   WHERE l.supplier_id=$1 AND l.catalogue_item_id=$2`, [supplier, catalogueItemId])).rows;
  warehouseId = await tooniesWarehouseId(db);
  const pricingRules = (await db.query<any>("SELECT id,name,rule_type AS \"ruleType\",min_cost_eur AS \"minCostEur\",max_cost_eur AS \"maxCostEur\",value,rounding_mode AS \"roundingMode\",significant_cost_increase_percent AS \"threshold\" FROM supplier_pricing_rules WHERE supplier_id=$1 AND active=true ORDER BY priority,id", [supplier])).rows.map((item: any) => ({ ...item, minCostEur: Number(item.minCostEur), maxCostEur: item.maxCostEur === null ? null : Number(item.maxCostEur), value: Number(item.value), threshold: Number(item.threshold) }));
  let held = false;
  let parentHeld = false;
  let fxBlocked = false;
  const heldScopes = new Map<string, { productId: string; variantId: string | null }>();
  for (const link of links) {
    const automaticCost = link.variantId
      ? link.fxRateSnapshotId && link.variantFxFresh ? link.normalizedEur : null
      : link.itemFxSnapshotId && link.itemFxFresh ? link.itemNormalizedEur : null;
    const cost = link.manualCostOverrideEur ?? automaticCost ?? link.itemManualCostOverrideEur;
    if (cost === null || cost === undefined) fxBlocked = true;
    const previous = link.variantId ? Number(link.variantCost ?? 0) : Number(link.productCost ?? 0);
    const manualOverride = link.linkManualSellingPriceEur !== null && link.linkManualSellingPriceEur !== undefined
      ? { amount: Number(link.linkManualSellingPriceEur), source: "link" as const }
      : link.manualSellingPriceEur !== null && link.manualSellingPriceEur !== undefined
        ? { amount: Number(link.manualSellingPriceEur), source: "variant" as const }
        : link.itemManualSellingPriceEur !== null && link.itemManualSellingPriceEur !== undefined
          ? { amount: Number(link.itemManualSellingPriceEur), source: "item" as const }
          : null;
    // One Admin variant-price operation synchronizes catalogue and link values;
    // link precedence gives that operation one deterministic effective source.
    const manualPrice = manualOverride?.amount ?? null;
    const applicableRule = pricingRules.find((candidate: any) => Number(cost) >= candidate.minCostEur && (candidate.maxCostEur === null || Number(cost) < candidate.maxCostEur));
    const threshold = Number(applicableRule?.threshold ?? 20);
    const linkHeld = cost !== null && cost !== undefined && previous > 0 && Number(cost) > previous * (1 + threshold / 100);
    if (linkHeld) {
      held = true;
      heldScopes.set(`${link.productId}:${link.variantId ?? "parent"}`, { productId: link.productId, variantId: link.variantId ?? null });
      if (!link.variantId) parentHeld = true;
      const previousPrice = link.variantId ? Number(link.variantPrice ?? 0) : Number(link.productPrice ?? 0);
      const formulaPrice = applicableRule ? calculateSupplierPriceFromBands(Number(cost), pricingRules) : null;
      const nextPrice = manualPrice ?? formulaPrice ?? previousPrice;
      const proposalFxId = link.fxRateSnapshotId ?? link.itemFxSnapshotId;
      if (applicableRule && formulaPrice !== null) {
        const existingProposal = (await db.query<any>(`SELECT id,status,proposed_cost_eur AS "proposedCostEur",formula_price_eur AS "formulaPriceEur",
        manual_override_eur AS "manualOverrideEur",manual_override_source AS "manualOverrideSource",proposed_price_eur AS "proposedPriceEur",
        pricing_rule_id AS "pricingRuleId",pricing_rule_type AS "pricingRuleType",pricing_rule_value AS "pricingRuleValue",
        pricing_rounding_mode AS "pricingRoundingMode",pricing_min_cost_eur AS "pricingMinCostEur",pricing_max_cost_eur AS "pricingMaxCostEur",
        threshold_percent AS "thresholdPercent",fx_rate_snapshot_id AS "fxRateSnapshotId"
        FROM supplier_price_change_reviews WHERE catalogue_item_id=$1 AND catalogue_variant_id IS NOT DISTINCT FROM $2
        ORDER BY detected_at DESC,id DESC LIMIT 1 FOR UPDATE`, [catalogueItemId, link.catalogueVariantId])).rows[0];
        const unchangedProposal = existingProposal
        && ["pending", "rejected"].includes(existingProposal.status)
        && Number(existingProposal.proposedCostEur).toFixed(4) === Number(cost).toFixed(4)
        && formulaPrice !== null
        && existingProposal.formulaPriceEur !== null
        && Number(existingProposal.formulaPriceEur).toFixed(4) === formulaPrice.toFixed(4)
        && (manualOverride === null
          ? existingProposal.manualOverrideEur === null && existingProposal.manualOverrideSource === null
          : existingProposal.manualOverrideEur !== null
            && Number(existingProposal.manualOverrideEur).toFixed(4) === manualOverride.amount.toFixed(4)
            && existingProposal.manualOverrideSource === manualOverride.source)
        && Number(existingProposal.proposedPriceEur).toFixed(2) === Number(nextPrice).toFixed(2)
        && existingProposal.pricingRuleId === (applicableRule?.id ?? null)
        && existingProposal.pricingRuleType === (applicableRule?.ruleType ?? null)
        && (applicableRule ? Number(existingProposal.pricingRuleValue).toFixed(4) === Number(applicableRule.value).toFixed(4) : existingProposal.pricingRuleValue === null)
        && existingProposal.pricingRoundingMode === (applicableRule?.roundingMode ?? null)
        && (applicableRule ? Number(existingProposal.pricingMinCostEur).toFixed(4) === Number(applicableRule.minCostEur).toFixed(4) : existingProposal.pricingMinCostEur === null)
        && (applicableRule?.maxCostEur == null ? existingProposal.pricingMaxCostEur === null : Number(existingProposal.pricingMaxCostEur).toFixed(4) === Number(applicableRule.maxCostEur).toFixed(4))
        && Number(existingProposal.thresholdPercent).toFixed(2) === threshold.toFixed(2)
        && existingProposal.fxRateSnapshotId === proposalFxId
        ;
        if (!unchangedProposal) {
          await db.query("UPDATE supplier_price_change_reviews SET status='superseded',resolved_at=now(),updated_at=now(),decision_note='Replaced by a newer authoritative supplier proposal.' WHERE catalogue_item_id=$1 AND catalogue_variant_id IS NOT DISTINCT FROM $2 AND status='pending'", [catalogueItemId, link.catalogueVariantId]);
          const history = await db.query<{ id: string }>("INSERT INTO supplier_cost_price_history(supplier_id,catalogue_item_id,catalogue_variant_id,previous_cost_cny,next_cost_cny,previous_cost_eur,next_cost_eur,previous_price_eur,next_price_eur,fx_rate_snapshot_id,fx_rate_used,fx_source,fx_observed_at,fx_fetched_at,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id", [supplier, catalogueItemId, link.catalogueVariantId, link.previousCostCny ?? null, link.originalAmountCny ?? link.itemOriginalAmount, previous, Number(cost), previousPrice, nextPrice, proposalFxId, link.fxRateUsed, link.fxSource, link.fxObservedAt, link.fxFetchedAt, "significant_increase_review"]);
          await db.query(`INSERT INTO supplier_price_change_reviews(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id,history_id,pricing_rule_id,
          pricing_rule_type,pricing_rule_value,pricing_rounding_mode,pricing_min_cost_eur,pricing_max_cost_eur,
          previous_cost_eur,proposed_cost_eur,previous_price_eur,formula_price_eur,manual_override_eur,manual_override_source,
          proposed_price_eur,increase_percent,threshold_percent,fx_rate_snapshot_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [supplier, catalogueItemId, link.catalogueVariantId, link.productId, link.variantId, history.rows[0]!.id, applicableRule?.id ?? null,
          applicableRule?.ruleType ?? null, applicableRule?.value ?? null, applicableRule?.roundingMode ?? null, applicableRule?.minCostEur ?? null, applicableRule?.maxCostEur ?? null,
          previous, Number(cost), previousPrice, formulaPrice, manualOverride?.amount ?? null, manualOverride?.source ?? null,
          nextPrice, ((Number(cost) - previous) / previous) * 100, threshold, proposalFxId]);
        }
      }
      if (link.variantId) {
        await db.query("UPDATE supplier_catalogue_variants SET state='Needs review',needs_review=true,updated_at=now() WHERE id=$1", [link.catalogueVariantId]);
        await db.query("UPDATE product_variants SET active=false,updated_at=now() WHERE id=$1", [link.variantId]);
        await db.query("UPDATE inventory SET active=false,updated_at=now() WHERE variant_id=$1", [link.variantId]);
      } else {
        await db.query("UPDATE inventory SET active=false,updated_at=now() WHERE product_id=$1 AND variant_id IS NULL", [link.productId]);
      }
    } else if (cost !== null && cost !== undefined) {
      const nextPrice = manualPrice ?? calculateSupplierPriceFromBands(Number(cost), pricingRules);
      const previousPrice = link.variantId ? Number(link.variantPrice ?? 0) : Number(link.productPrice ?? 0);
       if (Number(cost) !== previous || nextPrice !== previousPrice) await db.query("INSERT INTO supplier_cost_price_history(supplier_id,catalogue_item_id,catalogue_variant_id,previous_cost_cny,next_cost_cny,previous_cost_eur,next_cost_eur,previous_price_eur,next_price_eur,fx_rate_snapshot_id,fx_rate_used,fx_source,fx_observed_at,fx_fetched_at,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [supplier, catalogueItemId, link.catalogueVariantId, link.previousCostCny ?? null, link.originalAmountCny ?? link.itemOriginalAmount, previous, Number(cost), previousPrice, nextPrice, link.fxRateSnapshotId ?? link.itemFxSnapshotId, link.fxRateUsed, link.fxSource, link.fxObservedAt, link.fxFetchedAt, "supplier_cost_sync"]);
      if (link.variantId) await db.query(
        `UPDATE product_variants
            SET cost_price=$1,weight=$2,minimum_order_quantity=$3,updated_at=now()
          WHERE id=$4 AND (cost_price IS NULL OR cost_price=$5)`,
        [Number(cost), Number(link.variantWeightKg), Math.max(1, Number(link.variantMoq) || 1), link.variantId, previous],
      );
      if (manualPrice === null) {
        if (link.variantId) await db.query("UPDATE product_variants SET base_price=$1 WHERE id=$2", [nextPrice, link.variantId]);
        else await db.query("UPDATE products SET base_price=$1 WHERE id=$2", [nextPrice, link.productId]);
      }
      if (!link.variantId) await db.query(
        "UPDATE products SET cost_price=$1,minimum_order_quantity=$2,updated_at=now() WHERE id=$3 AND cost_price=$4",
        [Number(cost), Math.max(1, Number(link.itemMoq) || 1), link.productId, previous],
      );
    }
    if (link.variantId) {
      const supplierSku = `TOONIES-${link.supplierSkuCode}`.slice(0, 100);
      await db.query(
        "UPDATE product_variants SET sku=$1,weight=$2,minimum_order_quantity=$3,updated_at=now() WHERE id=$4",
        [supplierSku, Number(link.variantWeightKg), Math.max(1, Number(link.variantMoq) || 1), link.variantId],
      );
      const structuredOptions = await applyStructuredSupplierOptions(db, link.variantId, link.variantAttributes, true);
      if (structuredOptions.length && link.productVariantTitle === link.supplierVariantTitle) {
        await db.query("UPDATE product_variants SET title=$1,updated_at=now() WHERE id=$2", [
          structuredOptions.map((option) => option.value).join(" / "),
          link.variantId,
        ]);
      }
      const stock = Math.max(0, Number(link.stock ?? 0));
      const supplierReady = link.supplierActive === true
        && link.supplierPublicationEnabled === true
        && link.supplierComplianceExcluded === false
        && link.mappingStatus === "mapped"
        && link.mappingPublicationEnabled === true
        && link.mappingComplianceExcluded === false
        && link.rootCategoryId
        && link.rootActive === true
        && link.rootParentId === null
        && (!link.childCategoryId || (link.childActive === true && link.childParentId === link.rootCategoryId))
        && link.itemNeedsReview === false
        && !parentHeld
        && !linkHeld
        && !["Needs review", "Out of stock", "Error", "Supplier unavailable"].includes(link.itemState)
        && Number(link.itemStock) > 0
        && link.itemCurrency === "CNY"
        && Number(link.itemNormalizedEur) > 0
        && link.itemFxFresh === true
        && Number(link.itemFxRate) > 0
        && link.variantNeedsReview === false
        && !["Needs review", "Out of stock", "Error", "Supplier unavailable"].includes(link.state)
        && link.variantCurrency === "CNY"
        && Number(link.normalizedEur) > 0
        && link.variantFxFresh === true
        && Number(link.variantFxRate) > 0
        && Number(link.variantMoq) > 0
        && Number(link.variantWeightKg) > 0
        && Number(link.variantPrice) > 0;
      const sellable = supplierReady && stock > 0 && link.productStatus === "active" && link.productPublishedAt != null;
      await db.query(`INSERT INTO inventory(warehouse_id,variant_id,quantity_on_hand,quantity_reserved,active) VALUES($1,$2,$3,0,$4) ON CONFLICT(warehouse_id,variant_id) DO UPDATE SET quantity_on_hand=GREATEST(EXCLUDED.quantity_on_hand,inventory.quantity_reserved),active=$4,updated_at=now()`, [warehouseId, link.variantId, stock, sellable]);
      await db.query("UPDATE product_variants SET active=$1,updated_at=now() WHERE id=$2", [sellable, link.variantId]);
    } else if (link.productId) {
      await db.query(
        "UPDATE products SET minimum_order_quantity=$1,updated_at=now() WHERE id=$2",
        [Math.max(1, Number(link.itemMoq) || 1), link.productId],
      );
      const stock = Math.max(0, Number(link.itemStock ?? 0));
      const supplierReady = link.supplierActive === true
        && link.supplierPublicationEnabled === true
        && link.supplierComplianceExcluded === false
        && link.mappingStatus === "mapped"
        && link.mappingPublicationEnabled === true
        && link.mappingComplianceExcluded === false
        && link.rootCategoryId
        && link.rootActive === true
        && link.rootParentId === null
        && (!link.childCategoryId || (link.childActive === true && link.childParentId === link.rootCategoryId))
        && link.itemNeedsReview === false
        && !parentHeld
        && !linkHeld
        && !["Needs review", "Out of stock", "Error", "Supplier unavailable"].includes(link.itemState)
        && Number(link.itemMoq) > 0
        && link.itemCurrency === "CNY"
        && Number(link.itemNormalizedEur) > 0
        && link.itemFxFresh === true
        && Number(link.itemFxRate) > 0
        && Number(link.productPrice) > 0
        && (Number(link.productWeight) > 0 || Number(link.productDisplayWeight) > 0);
      const sellable = supplierReady && stock > 0 && link.productStatus === "active" && link.productPublishedAt != null;
      await db.query(`INSERT INTO inventory(warehouse_id,product_id,quantity_on_hand,quantity_reserved,active) VALUES($1,$2,$3,0,$4) ON CONFLICT(warehouse_id,product_id) DO UPDATE SET quantity_on_hand=GREATEST(EXCLUDED.quantity_on_hand,inventory.quantity_reserved),active=$4,updated_at=now()`, [warehouseId, link.productId, stock, sellable]);
      if (stock <= 0) await db.query("UPDATE products SET status='inactive',published_at=NULL,updated_at=now() WHERE id=$1 AND status='active'", [link.productId]);
    }
  }
  await db.query(`UPDATE products p SET status='inactive',published_at=NULL,updated_at=now()
    WHERE p.id IN (SELECT product_id FROM supplier_product_links WHERE supplier_id=$1 AND catalogue_item_id=$2)
      AND p.status='active'
      AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=p.id)
      AND NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=p.id AND pv.active=true)`, [supplier, catalogueItemId]);
  // Product weight is display metadata only. Keep each authoritative SKU
  // weight untouched and derive the deterministic minimum available weight.
  await db.query(
    `UPDATE products p
        SET display_weight_kg = (
          SELECT min(v.weight_kg)
            FROM supplier_product_links l
            JOIN supplier_catalogue_variants v ON v.id=l.catalogue_variant_id
           WHERE l.product_id=p.id AND l.supplier_id=$1 AND l.catalogue_item_id=$2
             AND v.weight_kg > 0
             AND v.weight_kg::text NOT IN ('NaN','Infinity','-Infinity')
        ), updated_at=now()
      WHERE p.id IN (SELECT product_id FROM supplier_product_links WHERE supplier_id=$1 AND catalogue_item_id=$2)`,
    [supplier, catalogueItemId],
  );
   await db.query("UPDATE supplier_catalogue_items SET state=CASE WHEN stock<=0 THEN 'Out of stock'::supplier_sync_state WHEN $1 THEN 'Needs review'::supplier_sync_state ELSE 'Synced'::supplier_sync_state END,needs_review=($1 OR stock<=0),updated_at=now() WHERE id=$2 AND supplier_id=$3", [parentHeld || fxBlocked, catalogueItemId, supplier]);
    await db.query("COMMIT");
    await normalizeTooniesPrimaryMedia(links[0]?.productId).catch((error) => {
      logger.error("Toonies media primary reconciliation failed", { catalogueItemId, error });
      throw error;
    });
   if (heldScopes.size) {
     const paymentMap = new Map<string, any>();
     for (const scope of heldScopes.values()) {
       await db.query(`UPDATE payments p SET status='cancelled',failure_reason='Cancelled because supplier merchandise entered price review before provider creation.',updated_at=now()
         WHERE p.provider_payment_id IS NULL AND p.status IN ('pending','requires_action','processing','authorized')
           AND EXISTS(SELECT 1 FROM order_items oi WHERE oi.order_id=p.order_id AND oi.product_id=$1 AND oi.variant_id IS NOT DISTINCT FROM $2)`,
       [scope.productId, scope.variantId]);
       const rows = (await db.query<any>(`SELECT p.id,p.provider_payment_id AS "providerPaymentId" FROM payments p
         WHERE p.provider_payment_id IS NOT NULL AND p.status IN ('pending','requires_action','processing','authorized')
           AND EXISTS(SELECT 1 FROM order_items oi WHERE oi.order_id=p.order_id AND oi.product_id=$1 AND oi.variant_id IS NOT DISTINCT FROM $2)`,
       [scope.productId, scope.variantId])).rows;
       for (const payment of rows) paymentMap.set(payment.id, payment);
     }
     const provider = getPaymentProvider();
     for (const payment of paymentMap.values()) {
        const reservationDb = await getDatabasePool().connect();
        let reservation: any;
        try {
          await reservationDb.query("BEGIN");
          const locked = (await reservationDb.query(
            `SELECT p.id,p.order_id AS "orderId",p.status,p.provider_payment_id AS "providerPaymentId",o.status AS "orderStatus"
               FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=$1 FOR UPDATE`, [payment.id],
          )).rows[0];
          if (!locked || locked.providerPaymentId !== payment.providerPaymentId
            || !["pending", "requires_action", "processing", "authorized"].includes(locked.status)
            || locked.orderStatus === "cancelled") throw new AppError(409, "HELD_PAYMENT_NOT_CANCELLABLE", "The payment is no longer eligible for supplier price-review cancellation.");
          reservation = await acquireFinancialOperation(reservationDb, {
            orderId: locked.orderId, operationType: "payment_cancellation",
            operationReferenceId: `supplier-price-review:${payment.id}`, leaseSeconds: 300,
          });
          await reservationDb.query("COMMIT");
        } catch (error) {
          await reservationDb.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally { reservationDb.release(); }
        const markDb = await getDatabasePool().connect();
        try {
          await markDb.query("BEGIN");
          const marked = await markFinancialOperationTransmitting(markDb, reservation);
          await markDb.query("COMMIT");
          reservation = { ...reservation, ...marked };
           await pauseAfterFinancialOperationReservation();
        } catch (error) {
          await markDb.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally { markDb.release(); }
        try {
          const outcome = await provider.cancelPayment(payment.providerPaymentId);
          if (outcome.status !== "cancelled") throw new AppError(409, "HELD_PAYMENT_NOT_CANCELLABLE", "An outstanding payment could not be cancelled after the supplier price hold.");
          const done = await getDatabasePool().connect();
          try {
            await done.query("BEGIN");
            await done.query("UPDATE payments SET status='cancelled',failure_reason='Cancelled because supplier merchandise entered price review.',updated_at=now() WHERE id=$1", [payment.id]);
            await transitionFinancialOperation(done, { id: reservation.id, leaseToken: reservation.leaseToken, version: reservation.version, state: "released", recoveryEvidence: { paymentId: payment.id, providerStatus: outcome.status } });
            await done.query("COMMIT");
          } catch (error) { await done.query("ROLLBACK"); throw error; } finally { done.release(); }
        } catch (error) {
          const ambiguous = await getDatabasePool().connect();
          try {
            await ambiguous.query("BEGIN");
            await transitionFinancialOperation(ambiguous, { id: reservation.id, leaseToken: reservation.leaseToken, version: reservation.version, state: "ambiguous", failureMessage: String(error), recoveryEvidence: { paymentId: payment.id, providerCall: "cancel" } });
            await ambiguous.query("COMMIT");
          } catch { await ambiguous.query("ROLLBACK").catch(() => undefined); } finally { ambiguous.release(); }
          throw error;
        }
     }
   }
   return { catalogueItemId, heldForReview: held || fxBlocked, linked: links.length };
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    rawDb.release();
  }
}

export async function importTooniesCatalogue(ids: string[]) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) throw new AppError(400, "VALIDATION_ERROR", "Catalogue identifiers must be UUIDs.");
  const supplier = await supplierId();
  const importKeyword = (await getDatabasePool().query<{ external_product_id: string }>(
    "SELECT external_product_id FROM supplier_catalogue_items WHERE supplier_id=$1 AND id=ANY($2::uuid[]) ORDER BY external_product_id LIMIT 1",
    [supplier, ids],
  )).rows[0]?.external_product_id ?? null;
  const run = await getDatabasePool().query(`INSERT INTO supplier_sync_runs(supplier_id,operation,keyword) VALUES($1,'import',$2) RETURNING id`, [supplier, importKeyword]);
  const runId = run.rows[0].id as string;
  const normalizationRunId = await beginFxNormalizationRun(supplier, runId);
  const rawDb = await getDatabasePool().connect();
  const db = serializedClient(rawDb);
  const imported: string[] = [];
  let fx: FxContext = {};
  try {
    fx = await resolveRunFx(supplier, runId, normalizationRunId);
    if (!fx.snapshot) {
      throw new AppError(409, fx.errorCode === "FX_OBSERVATION_STALE" ? "FX_RATE_STALE" : "FX_RATE_UNAVAILABLE", "A fresh ECB CNY/EUR rate is required before importing catalogue products.");
    }
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('toonies:catalogue-import'))");
    const currentFx = (await db.query("SELECT id FROM fx_rate_snapshots WHERE id=$1 AND expires_at>now() FOR SHARE", [fx.snapshot.id])).rows[0];
    if (!currentFx) throw new AppError(409, "FX_RATE_STALE", "The ECB CNY/EUR rate expired before the import transaction began.");
    for (const catalogueId of [...new Set(ids)]) {
      const row = (await db.query<any>(`SELECT i.id,i.external_product_id AS "externalProductId",i.title,i.description,i.original_amount AS "originalAmount",i.original_currency AS "originalCurrency",i.minimum_order_quantity AS "minimumOrderQuantity",i.manual_cost_override_eur AS "manualCostOverrideEur",i.manual_selling_price_eur AS "manualSellingPriceEur",m.root_category_id AS "rootCategoryId",m.child_category_id AS "childCategoryId" FROM supplier_catalogue_items i LEFT JOIN supplier_category_mappings m ON m.supplier_id=i.supplier_id AND m.external_category_id=i.external_category_id AND m.status='mapped' WHERE i.id=$1 AND i.supplier_id=$2 FOR UPDATE OF i`, [catalogueId, supplier])).rows[0];
      if (!row) throw new AppError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "The supplier catalogue item was not found.");
      const categoryId = row.childCategoryId ?? row.rootCategoryId;
      if (!categoryId) throw new AppError(409, "SUPPLIER_CATEGORY_REVIEW_REQUIRED", "Map the authoritative supplier category before importing.");
      const duplicate = (await db.query(`SELECT product_id AS "productId" FROM supplier_import_records WHERE supplier_id=$1 AND external_product_id=$2 AND external_variant_id IS NULL FOR UPDATE`, [supplier, row.externalProductId])).rows[0];
      if (duplicate?.productId) { imported.push(duplicate.productId); continue; }
      if (row.originalCurrency !== "CNY") throw new AppError(409, "FX_CURRENCY_UNSUPPORTED", "Only authoritative CNY catalogue costs can be imported.");
      const normalized = normalizedEurAmount(String(row.originalAmount), fx.snapshot.rate);
      await db.query("UPDATE supplier_catalogue_items SET normalized_eur=$1,normalized_currency='EUR',fx_rate_snapshot_id=$2,fx_rate_used=$3,fx_source=$4,fx_observed_at=$5,fx_fetched_at=$6,fx_normalization_error=NULL,updated_at=now() WHERE id=$7", [normalized, fx.snapshot.id, fx.snapshot.rate, fx.snapshot.source, fx.snapshot.observedAt, fx.snapshot.fetchedAt, row.id]);
      const parentSku = `TOONIES-${row.externalProductId}`.slice(0, 100);
      const slug = `toonies-${row.externalProductId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 280);
       const variants = (await db.query<any>(`SELECT id,external_variant_id AS "externalVariantId",sku_code AS "skuCode",title,attributes,original_amount AS "originalAmount",original_currency AS "originalCurrency",minimum_order_quantity AS "minimumOrderQuantity",manual_cost_override_eur AS "manualCostOverrideEur",manual_selling_price_eur AS "manualSellingPriceEur",weight_kg AS "weightKg" FROM supplier_catalogue_variants WHERE catalogue_item_id=$1 ORDER BY sku_code,id`, [row.id])).rows;
      const pricingRules = (await db.query<any>("SELECT rule_type AS \"ruleType\",min_cost_eur AS \"minCostEur\",max_cost_eur AS \"maxCostEur\",value,rounding_mode AS \"roundingMode\" FROM supplier_pricing_rules WHERE supplier_id=$1 AND active=true ORDER BY priority,id", [supplier])).rows.map((item: any) => ({ ...item, minCostEur: Number(item.minCostEur), maxCostEur: item.maxCostEur === null ? null : Number(item.maxCostEur), value: Number(item.value) }));
      const automaticPrice = (cost: number) => calculateSupplierPriceFromBands(cost, pricingRules);
      const effectiveNormalized = row.manualCostOverrideEur ?? normalized;
      const productPrice = row.manualSellingPriceEur ?? automaticPrice(Number(effectiveNormalized));
      const collision = (await db.query<{ id: string }>("SELECT id FROM products WHERE parent_sku=$1 OR slug=$2 FOR UPDATE", [parentSku, slug])).rows[0];
      if (collision) throw new AppError(409, "SUPPLIER_PRODUCT_COLLISION", "A product already owns this supplier identifier; resolve the collision before importing.");
       const displayWeight = deriveTooniesDisplayWeight(variants.map((variant: any) => variant.weightKg));
       const product = await db.query<{ id: string }>(`INSERT INTO products(name,slug,parent_sku,category_id,description,status,cost_price,base_price,vat_rate,weight,display_weight_kg,minimum_order_quantity) VALUES($1,$2,$3,$4,$5,'draft',$6,$7,0,0,$8,$9) RETURNING id`, [row.title, slug, parentSku, categoryId, row.description ?? "", Number(effectiveNormalized), productPrice, displayWeight, Math.max(1, Number(row.minimumOrderQuantity) || 1)]);
      const productId = product.rows[0].id;
      await db.query(`INSERT INTO supplier_import_records(supplier_id,catalogue_item_id,external_product_id,product_id,status) VALUES($1,$2,$3,$4,'draft')`, [supplier, row.id, row.externalProductId, productId]);
      for (const variant of variants) {
        if (variant.originalCurrency !== "CNY") throw new AppError(409, "FX_CURRENCY_UNSUPPORTED", "Only authoritative CNY variant costs can be imported.");
        const vAutomaticNormalized = normalizedEurAmount(String(variant.originalAmount), fx.snapshot.rate);
        await db.query("UPDATE supplier_catalogue_variants SET normalized_eur=$1,normalized_currency='EUR',fx_rate_snapshot_id=$2,fx_rate_used=$3,fx_source=$4,fx_observed_at=$5,fx_fetched_at=$6,fx_normalization_error=NULL,updated_at=now() WHERE id=$7", [vAutomaticNormalized, fx.snapshot.id, fx.snapshot.rate, fx.snapshot.source, fx.snapshot.observedAt, fx.snapshot.fetchedAt, variant.id]);
        const vNormalized = variant.manualCostOverrideEur ?? vAutomaticNormalized;
        const variantPrice = variant.manualSellingPriceEur ?? automaticPrice(Number(vNormalized));
        const variantCollision = (await db.query<{ id: string }>("SELECT id FROM product_variants WHERE sku=$1 FOR UPDATE", [`TOONIES-${variant.skuCode}`.slice(0, 100)])).rows[0];
        if (variantCollision) throw new AppError(409, "SUPPLIER_VARIANT_COLLISION", "A variant SKU is already owned by another product.");
         const structuredOptions = structuredSupplierOptions(variant.attributes);
         const variantTitle = structuredOptions.length
           ? structuredOptions.map((option) => option.value).join(" / ")
           : variant.title ?? variant.skuCode;
         const result = await db.query<{ id: string }>(`INSERT INTO product_variants(product_id,sku,title,cost_price,base_price,weight,minimum_order_quantity,active) VALUES($1,$2,$3,$4,$5,$6,$7,false) RETURNING id`, [productId, `TOONIES-${variant.skuCode}`.slice(0, 100), variantTitle, Number(vNormalized), variantPrice, variant.weightKg, Math.max(1, Number(variant.minimumOrderQuantity) || 1)]);
         await applyStructuredSupplierOptions(db, result.rows[0].id, variant.attributes, false);
        await db.query(`INSERT INTO supplier_import_records(supplier_id,catalogue_item_id,catalogue_variant_id,external_product_id,external_variant_id,product_id,variant_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,'draft')`, [supplier, row.id, variant.id, row.externalProductId, variant.externalVariantId, productId, result.rows[0].id]);
        await db.query(`INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id,manual_selling_price_eur) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(catalogue_variant_id) DO UPDATE SET product_id=EXCLUDED.product_id,variant_id=EXCLUDED.variant_id,updated_at=now()`, [supplier, row.id, variant.id, productId, result.rows[0].id, variant.manualSellingPriceEur ?? null]);
         await db.query("INSERT INTO supplier_cost_price_history(supplier_id,catalogue_item_id,catalogue_variant_id,next_cost_cny,next_cost_eur,next_price_eur,fx_rate_snapshot_id,fx_rate_used,fx_source,fx_observed_at,fx_fetched_at,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'import')", [supplier, row.id, variant.id, variant.originalAmount, Number(vNormalized), variantPrice, fx.snapshot.id, fx.snapshot.rate, fx.snapshot.source, fx.snapshot.observedAt, fx.snapshot.fetchedAt]);
      }
      await db.query(`INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,product_id,manual_selling_price_eur) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM supplier_product_links WHERE supplier_id=$1 AND catalogue_item_id=$2 AND product_id=$3 AND variant_id IS NULL)`, [supplier, row.id, productId, row.manualSellingPriceEur ?? null]);
       await db.query("INSERT INTO supplier_cost_price_history(supplier_id,catalogue_item_id,next_cost_cny,next_cost_eur,next_price_eur,fx_rate_snapshot_id,fx_rate_used,fx_source,fx_observed_at,fx_fetched_at,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'import')", [supplier, row.id, row.originalAmount, Number(effectiveNormalized), productPrice, fx.snapshot.id, fx.snapshot.rate, fx.snapshot.source, fx.snapshot.observedAt, fx.snapshot.fetchedAt]);
      imported.push(productId);
    }
     await db.query(`UPDATE supplier_sync_runs SET status='completed',item_count=$2,completed_at=now(),updated_at=now() WHERE id=$1`, [runId, imported.length]);
     await db.query("COMMIT");
     await finishFxNormalizationRun(normalizationRunId, fx, imported.length, imported.length);
    for (const productId of [...new Set(imported)]) {
      const linked = await getDatabasePool().query<{ id: string }>("SELECT catalogue_item_id AS id FROM supplier_import_records WHERE supplier_id=$1 AND product_id=$2 AND external_variant_id IS NULL LIMIT 1", [supplier, productId]);
       if (linked.rows[0]) {
         await rehostTooniesMedia(linked.rows[0].id, productId);
         await reconcileLinkedCatalogueItem(linked.rows[0].id);
       }
    }
    return { imported: [...new Set(imported)], count: imported.length };
  } catch (error) {
    try { await db.query("ROLLBACK"); } catch { /* transaction may not have started */ }
    await getDatabasePool().query("UPDATE supplier_sync_runs SET status='failed',error_count=1,error_message=$1,completed_at=now(),updated_at=now() WHERE id=$2", [error instanceof Error ? error.message.slice(0, 1000) : "Import failed", runId]);
    await getDatabasePool().query("UPDATE supplier_fx_normalization_runs SET status='failed',error_code=$1,error_message=$2,completed_at=now(),updated_at=now() WHERE id=$3", [error instanceof AppError ? error.code : "IMPORT_FAILED", error instanceof Error ? error.message.slice(0, 1000) : "Import failed", normalizationRunId]);
    throw error;
  } finally { rawDb.release(); }
}

function tooniesExpiry(value: unknown, expireIn: unknown): Date | null {
  if (value !== null && value !== undefined && value !== "") {
    const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    const parsed = Number.isFinite(numeric)
      ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
      : new Date(String(value));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const seconds = Number(expireIn);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
}

export async function precheckToonies(input: any) {
  const supplier = await supplierId();
  // Never let a browser/admin payload bypass the MOQ captured from the
  // authoritative supplier catalogue.  A matching SKU overrides its parent
  // catalogue item's MOQ.
  for (const item of input.items ?? []) {
    const row = (await getDatabasePool().query<{ minimumOrderQuantity: number | string }>(
      `SELECT COALESCE(v.minimum_order_quantity, i.minimum_order_quantity) AS "minimumOrderQuantity"
         FROM supplier_catalogue_items i
         LEFT JOIN supplier_catalogue_variants v
           ON v.catalogue_item_id=i.id AND v.sku_code=$3
        WHERE i.supplier_id=$1 AND i.external_product_id=$2`,
      [supplier, item.product_code, item.sku_code],
    )).rows[0];
    if (row) {
      const minimumOrderQuantity = Math.max(1, Number(row.minimumOrderQuantity));
      if (item.num < minimumOrderQuantity) {
        throw new AppError(
          409,
          "MINIMUM_ORDER_QUANTITY_NOT_MET",
          `Quantity must be at least ${minimumOrderQuantity}.`,
          {
            productCode: item.product_code,
            skuCode: item.sku_code,
            quantity: item.num,
            requiredMinimum: minimumOrderQuantity,
            minimumOrderQuantity,
          },
        );
      }
    }
  }
  try {
    const data: any = await getTooniesClient().precheck(input);
    if (!data || typeof data !== "object" || typeof data.task_id !== "string" || typeof data.client_task_no !== "string" || typeof data.status !== "string") throw new AppError(502, "TOONIES_INVALID_PRECHECK_RESPONSE", "Toonies returned an invalid precheck response.");
    const ready = ["ready", "completed", "success"].includes(String(data.status).toLowerCase());
    const expiresAt = ready ? tooniesExpiry(data.date_expire, data.expire_in) : null;
    await getDatabasePool().query(`INSERT INTO supplier_precheck_snapshots(supplier_id,task_id,client_task_no,status,expires_at,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(supplier_id,client_task_no) DO UPDATE SET task_id=EXCLUDED.task_id,status=EXCLUDED.status,expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload,updated_at=now()`, [supplier, data.task_id, data.client_task_no, data.status, expiresAt, boundedPayload(data)]);
    return data;
  } catch (error) { supplierError(error); }
}

export async function taskToonies(taskId: string) {
  const supplier = await supplierId();
  try {
    const snapshot = (await getDatabasePool().query<{ expiresAt: Date | null; status: string }>("SELECT expires_at AS \"expiresAt\",status FROM supplier_precheck_snapshots WHERE supplier_id=$1 AND task_id=$2", [supplier, taskId])).rows[0];
    if (snapshot?.expiresAt && new Date(snapshot.expiresAt).getTime() <= Date.now() && ["ready", "completed", "success"].includes(String(snapshot.status).toLowerCase())) {
      await getDatabasePool().query("UPDATE supplier_precheck_snapshots SET status='expired',updated_at=now() WHERE supplier_id=$1 AND task_id=$2", [supplier, taskId]);
      throw new TooniesError(40041);
    }
    const data: any = await getTooniesClient().task({ task_id: taskId });
    if (!data || typeof data !== "object" || typeof data.status !== "string") throw new AppError(502, "TOONIES_INVALID_TASK_RESPONSE", "Toonies returned an invalid task response.");
    const ready = ["ready", "completed", "success"].includes(String(data.status).toLowerCase());
    const expiresAt = ready ? tooniesExpiry(data.date_expire, data.expire_in) ?? snapshot?.expiresAt ?? null : null;
    await getDatabasePool().query("UPDATE supplier_precheck_snapshots SET status=$1,expires_at=$2,payload=$3,updated_at=now() WHERE supplier_id=$4 AND task_id=$5", [data.status, expiresAt, boundedPayload(data), supplier, taskId]);
    return data;
  } catch (error) { supplierError(error); }
}

export async function listPricingRules() {
  const supplier = await supplierId();
  return (await getDatabasePool().query(`SELECT id,name,rule_type AS "ruleType",min_cost_eur AS "minCostEur",max_cost_eur AS "maxCostEur",value,rounding_mode AS "roundingMode",priority,active,significant_cost_increase_percent AS "significantCostIncreasePercent",created_at AS "createdAt",updated_at AS "updatedAt" FROM supplier_pricing_rules WHERE supplier_id=$1 ORDER BY priority,id`, [supplier])).rows;
}

export async function listPriceChangeReviews() {
  const supplier = await supplierId();
  return (await getDatabasePool().query(`SELECT r.id,r.status,r.catalogue_item_id AS "catalogueItemId",r.catalogue_variant_id AS "catalogueVariantId",
    r.product_id AS "productId",r.variant_id AS "variantId",p.name AS "productName",p.parent_sku AS "productCode",pv.title AS "variantName",pv.sku AS "skuCode",
    r.previous_cost_eur AS "previousCostEur",r.proposed_cost_eur AS "proposedCostEur",r.increase_percent AS "increasePercent",
    r.previous_price_eur AS "previousPriceEur",r.formula_price_eur AS "formulaPriceEur",r.manual_override_eur AS "manualOverrideEur",
    r.manual_override_source AS "manualOverrideSource",r.proposed_price_eur AS "proposedPriceEur",r.threshold_percent AS "thresholdPercent",
    r.reason,r.detected_at AS "detectedAt",r.pricing_min_cost_eur AS "pricingMinCostEur",r.pricing_max_cost_eur AS "pricingMaxCostEur",
    r.pricing_rule_type AS "pricingRuleType",r.pricing_rule_value AS "pricingRuleValue",r.pricing_rounding_mode AS "pricingRoundingMode"
    FROM supplier_price_change_reviews r JOIN products p ON p.id=r.product_id LEFT JOIN product_variants pv ON pv.id=r.variant_id
    WHERE r.supplier_id=$1 AND r.status='pending' ORDER BY r.detected_at,r.id`, [supplier])).rows;
}

export async function decidePriceChangeReview(reviewId: string, decision: "accept" | "reject", actorAdminId: string, note?: string | null) {
  const supplier = await supplierId();
  const client = await getDatabasePool().connect();
  let catalogueItemId = "";
  try {
    await client.query("BEGIN");
    const locked = (await client.query<any>("SELECT status,catalogue_item_id,catalogue_variant_id FROM supplier_price_change_reviews WHERE id=$1 AND supplier_id=$2 FOR UPDATE", [reviewId, supplier])).rows[0];
    if (!locked) throw new AppError(404, "PRICE_CHANGE_REVIEW_NOT_FOUND", "The price-change review was not found.");
    if (decision === "reject" && locked.status === "rejected") {
      await client.query("COMMIT");
      return { id: reviewId, status: "rejected" };
    }
    if (locked.status !== "pending") throw new AppError(409, "PRICE_CHANGE_REVIEW_STALE", "This price-change proposal has already been resolved or replaced.");
    await client.query("SELECT id FROM supplier_catalogue_items WHERE id=$1 FOR UPDATE", [locked.catalogue_item_id]);
    if (locked.catalogue_variant_id) await client.query("SELECT id FROM supplier_catalogue_variants WHERE id=$1 FOR UPDATE", [locked.catalogue_variant_id]);
    await client.query("SELECT id FROM supplier_product_links WHERE catalogue_item_id=$1 AND catalogue_variant_id IS NOT DISTINCT FROM $2 FOR UPDATE", [locked.catalogue_item_id, locked.catalogue_variant_id]);
    const review = (await client.query<any>(`SELECT r.*,i.manual_cost_override_eur AS "itemManualCost",i.normalized_eur AS "itemNormalizedCost",i.fx_rate_snapshot_id AS "itemFxId",
      v.manual_cost_override_eur AS "variantManualCost",v.normalized_eur AS "variantNormalizedCost",v.fx_rate_snapshot_id AS "variantFxId",
      l.manual_selling_price_eur AS "linkManualPrice",i.manual_selling_price_eur AS "itemManualPrice",v.manual_selling_price_eur AS "variantManualPrice"
      FROM supplier_price_change_reviews r JOIN supplier_catalogue_items i ON i.id=r.catalogue_item_id
      LEFT JOIN supplier_catalogue_variants v ON v.id=r.catalogue_variant_id
      JOIN supplier_product_links l ON l.catalogue_item_id=r.catalogue_item_id AND l.catalogue_variant_id IS NOT DISTINCT FROM r.catalogue_variant_id
      WHERE r.id=$1 AND r.supplier_id=$2`, [reviewId, supplier])).rows[0];
    catalogueItemId = review.catalogue_item_id;
    if (decision === "reject") {
      await client.query("UPDATE supplier_price_change_reviews SET status='rejected',resolved_at=now(),resolved_by_admin_id=$1,decision_note=$2,updated_at=now() WHERE id=$3 AND status='pending'", [actorAdminId, note?.trim() || null, reviewId]);
      await client.query("INSERT INTO supplier_cost_price_history(supplier_id,catalogue_item_id,catalogue_variant_id,previous_cost_eur,next_cost_eur,previous_price_eur,next_price_eur,fx_rate_snapshot_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'significant_increase_rejected')", [supplier, catalogueItemId, review.catalogue_variant_id, review.previous_cost_eur, review.proposed_cost_eur, review.previous_price_eur, review.proposed_price_eur, review.fx_rate_snapshot_id]);
      await client.query("INSERT INTO audit_logs(actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES($1,'supplier.price_change.rejected','supplier_price_change_review',$2,$3,$4)", [actorAdminId, reviewId, JSON.stringify({ status: "pending" }), JSON.stringify({ status: "rejected", note: note?.trim() || null })]);
      await client.query("COMMIT");
      return { id: reviewId, status: "rejected" };
    }
    const fxId = review.catalogue_variant_id ? review.variantFxId : review.itemFxId;
    const currentCost = Number(review.catalogue_variant_id ? (review.variantManualCost ?? review.variantNormalizedCost) : (review.itemManualCost ?? review.itemNormalizedCost));
    const freshFx = fxId ? (await client.query("SELECT 1 FROM fx_rate_snapshots WHERE id=$1 AND expires_at>now() AND rate>0 FOR SHARE", [fxId])).rowCount : 0;
    if (!Number.isFinite(currentCost) || currentCost <= 0 || !freshFx) throw new AppError(409, "PRICE_CHANGE_FX_INVALID", "The latest supplier cost does not have fresh valid FX provenance.");
    if (currentCost.toFixed(4) !== Number(review.proposed_cost_eur).toFixed(4)) throw new AppError(409, "PRICE_CHANGE_REVIEW_STALE", "The supplier cost changed after this proposal. Review the newer proposal instead.");
    const rules = (await client.query<any>("SELECT id,name,rule_type AS \"ruleType\",min_cost_eur AS \"minCostEur\",max_cost_eur AS \"maxCostEur\",value,rounding_mode AS \"roundingMode\",significant_cost_increase_percent AS \"threshold\" FROM supplier_pricing_rules WHERE supplier_id=$1 AND active=true ORDER BY priority,id FOR SHARE", [supplier])).rows.map((rule: any) => ({ ...rule, minCostEur: Number(rule.minCostEur), maxCostEur: rule.maxCostEur === null ? null : Number(rule.maxCostEur), value: Number(rule.value), threshold: Number(rule.threshold) }));
    const rule = rules.find((candidate: any) => currentCost >= candidate.minCostEur && (candidate.maxCostEur === null || currentCost < candidate.maxCostEur));
    if (!rule) throw new AppError(409, "PRICE_UNAVAILABLE", "No active pricing band covers the current supplier cost.");
    const manualOverride = review.linkManualPrice !== null && review.linkManualPrice !== undefined
      ? { amount: Number(review.linkManualPrice), source: "link" as const }
      : review.variantManualPrice !== null && review.variantManualPrice !== undefined
        ? { amount: Number(review.variantManualPrice), source: "variant" as const }
        : review.itemManualPrice !== null && review.itemManualPrice !== undefined
          ? { amount: Number(review.itemManualPrice), source: "item" as const }
          : null;
    const manualPrice = manualOverride?.amount ?? null;
    if (manualPrice !== null && manualPrice !== undefined) assertMerchandisePriceFloor({ unitCost: currentCost, merchandiseRevenue: Number(manualPrice), code: "MANUAL_PRICE_BELOW_COST", message: "The existing manual price is below the accepted cost. Correct or remove it before approval." });
    const formulaPrice = calculateSupplierPrice(currentCost, rule);
    const nextPrice = manualPrice ?? formulaPrice;
    const completeSnapshot = review.formula_price_eur !== null
      && review.pricing_rule_type !== null
      && review.pricing_rule_value !== null
      && review.pricing_rounding_mode !== null
      && review.pricing_min_cost_eur !== null
      && ((review.manual_override_eur === null && review.manual_override_source === null)
        || (review.manual_override_eur !== null && review.manual_override_source !== null));
    const policyUnchanged = completeSnapshot
      && rule.id === review.pricing_rule_id
      && rule.ruleType === review.pricing_rule_type
      && Number(rule.value).toFixed(4) === Number(review.pricing_rule_value).toFixed(4)
      && rule.roundingMode === review.pricing_rounding_mode
      && Number(rule.minCostEur).toFixed(4) === Number(review.pricing_min_cost_eur).toFixed(4)
      && (rule.maxCostEur === null ? review.pricing_max_cost_eur === null : Number(rule.maxCostEur).toFixed(4) === Number(review.pricing_max_cost_eur).toFixed(4))
      && Number(review.threshold_percent).toFixed(2) === Number(rule.threshold ?? review.threshold_percent).toFixed(2)
      && formulaPrice.toFixed(4) === Number(review.formula_price_eur).toFixed(4)
      && (manualOverride === null
        ? review.manual_override_eur === null && review.manual_override_source === null
        : Number(review.manual_override_eur).toFixed(4) === manualOverride.amount.toFixed(4) && review.manual_override_source === manualOverride.source)
      && review.fx_rate_snapshot_id === fxId
      && nextPrice.toFixed(2) === Number(review.proposed_price_eur).toFixed(2);
    if (!policyUnchanged) {
      throw new AppError(409, "PRICE_CHANGE_REVIEW_STALE", "Pricing policy changed after this proposal. Synchronize and review the replacement proposal.");
    }
    if (review.variant_id) {
      await client.query("UPDATE product_variants SET cost_price=$1,base_price=$2,active=false,updated_at=now() WHERE id=$3", [currentCost, nextPrice, review.variant_id]);
      await client.query("UPDATE supplier_catalogue_variants SET needs_review=false,state=CASE WHEN stock>0 THEN 'Synced'::supplier_sync_state ELSE 'Out of stock'::supplier_sync_state END,updated_at=now() WHERE id=$1", [review.catalogue_variant_id]);
    } else {
      await client.query("UPDATE products SET cost_price=$1,base_price=$2,updated_at=now() WHERE id=$3", [currentCost, nextPrice, review.product_id]);
      await client.query("UPDATE supplier_catalogue_items SET needs_review=false,state=CASE WHEN stock>0 THEN 'Synced'::supplier_sync_state ELSE 'Out of stock'::supplier_sync_state END,updated_at=now() WHERE id=$1", [catalogueItemId]);
    }
    const resolved = await client.query("UPDATE supplier_price_change_reviews SET status='accepted',resolved_at=now(),resolved_by_admin_id=$1,decision_note=$2,updated_at=now() WHERE id=$3 AND status='pending' RETURNING id", [actorAdminId, note?.trim() || null, reviewId]);
    if (!resolved.rowCount) throw new AppError(409, "PRICE_CHANGE_REVIEW_STALE", "This proposal was resolved concurrently.");
    await client.query("INSERT INTO supplier_cost_price_history(supplier_id,catalogue_item_id,catalogue_variant_id,previous_cost_eur,next_cost_eur,previous_price_eur,next_price_eur,fx_rate_snapshot_id,fx_rate_used,fx_source,fx_observed_at,fx_fetched_at,reason) SELECT $1,$2,$3,$4,$5,$6,$7,f.id,f.rate,f.source,f.observed_at,f.fetched_at,'significant_increase_accepted' FROM fx_rate_snapshots f WHERE f.id=$8", [supplier, catalogueItemId, review.catalogue_variant_id, review.previous_cost_eur, currentCost, review.previous_price_eur, nextPrice, fxId]);
    await client.query("INSERT INTO audit_logs(actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES($1,'supplier.price_change.accepted','supplier_price_change_review',$2,$3,$4)", [actorAdminId, reviewId, JSON.stringify({ cost: Number(review.previous_cost_eur), price: Number(review.previous_price_eur), status: "pending" }), JSON.stringify({ cost: currentCost, price: nextPrice, status: "accepted", pricingRuleId: rule.id })]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await reconcileLinkedCatalogueItem(catalogueItemId);
  return { id: reviewId, status: "accepted" };
}

export async function savePricingRule(input: {
  name: string;
  ruleType: "markup_percent" | "markup_fixed" | "margin_percent";
  minCostEur: number;
  maxCostEur: number | null;
  value: number;
  roundingMode: "none" | "whole" | "99";
  priority: number;
  active: boolean;
  significantCostIncreasePercent: number;
}, id?: string) {
  const supplier = await supplierId();
  if (input.ruleType === "margin_percent" && input.value >= 100) throw new AppError(400, "INVALID_MARGIN", "Margin must be below 100 percent.");
  if (input.maxCostEur !== null && input.maxCostEur <= input.minCostEur) throw new AppError(400, "INVALID_COST_BAND", "Cost band maximum must be greater than its minimum.");
  const overlap = await getDatabasePool().query(`SELECT id FROM supplier_pricing_rules WHERE supplier_id=$1 AND active=true AND id IS DISTINCT FROM $2 AND min_cost_eur < COALESCE($3,1000000000) AND COALESCE(max_cost_eur,1000000000) > $4 LIMIT 1`, [supplier, id ?? null, input.maxCostEur, input.minCostEur]);
  if (overlap.rows[0]) throw new AppError(409, "OVERLAPPING_COST_BAND", "Pricing cost bands cannot overlap.");
  if (id) {
    const result = await getDatabasePool().query(`UPDATE supplier_pricing_rules SET name=$1,rule_type=$2,min_cost_eur=$3,max_cost_eur=$4,value=$5,rounding_mode=$6,priority=$7,active=$8,significant_cost_increase_percent=$9,updated_at=now() WHERE id=$10 AND supplier_id=$11 RETURNING id`, [input.name.trim(), input.ruleType, input.minCostEur, input.maxCostEur, input.value, input.roundingMode, input.priority, input.active, input.significantCostIncreasePercent, id, supplier]);
    if (!result.rowCount) throw new AppError(404, "PRICING_RULE_NOT_FOUND", "Pricing rule not found.");
    return id;
  }
  const result = await getDatabasePool().query<{ id: string }>(`INSERT INTO supplier_pricing_rules(supplier_id,name,rule_type,min_cost_eur,max_cost_eur,value,rounding_mode,priority,active,significant_cost_increase_percent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [supplier, input.name.trim(), input.ruleType, input.minCostEur, input.maxCostEur, input.value, input.roundingMode, input.priority, input.active, input.significantCostIncreasePercent]);
  return result.rows[0].id;
}

export function calculateSupplierPrice(cost: number, rule: { ruleType: "markup_percent" | "markup_fixed" | "margin_percent"; value: number; roundingMode?: "none" | "whole" | "99" }): number {
  if (!Number.isFinite(cost) || cost < 0) throw new AppError(400, "INVALID_COST", "Cost must be nonnegative.");
  if (!Number.isFinite(rule.value) || rule.value < 0) throw new AppError(400, "INVALID_PRICING_VALUE", "Pricing value must be nonnegative.");
  if (rule.ruleType === "margin_percent" && rule.value >= 100) throw new AppError(400, "INVALID_MARGIN", "Margin must be below 100 percent.");
  const fraction = (value: number) => {
    const text = String(value);
    const [whole, decimal = ""] = text.split(".");
    return { numerator: BigInt(`${whole}${decimal}`), denominator: 10n ** BigInt(decimal.length) };
  };
  const c = fraction(cost), v = fraction(rule.value);
  let numerator: bigint;
  let denominator: bigint;
  if (rule.ruleType === "markup_percent") {
    numerator = c.numerator * (100n * v.denominator + v.numerator);
    denominator = c.denominator * 100n * v.denominator;
  } else if (rule.ruleType === "markup_fixed") {
    numerator = c.numerator * v.denominator + v.numerator * c.denominator;
    denominator = c.denominator * v.denominator;
  } else {
    numerator = c.numerator * 100n * v.denominator;
    denominator = c.denominator * (100n * v.denominator - v.numerator);
  }
  let cents: bigint;
  if (rule.roundingMode === "whole") cents = ((numerator + denominator - 1n) / denominator) * 100n;
  else if (rule.roundingMode === "99") {
    const whole = numerator / denominator;
    const candidate = whole * 100n + 99n;
    cents = candidate * denominator >= numerator * 100n ? candidate : candidate + 100n;
  } else {
    const scaled = numerator * 100n;
    cents = scaled / denominator + ((scaled % denominator) * 2n >= denominator ? 1n : 0n);
  }
  const result = Number(cents) / 100;
  assertMerchandisePriceFloor({ unitCost: cost, merchandiseRevenue: result, code: "CALCULATED_PRICE_BELOW_COST", message: "The calculated selling price cannot be below merchandise cost." });
  return result;
}

export function calculateSupplierPriceFromBands(cost: number, rules: Array<{ minCostEur: number; maxCostEur: number | null; ruleType: "markup_percent" | "markup_fixed" | "margin_percent"; value: number; roundingMode?: "none" | "whole" | "99" }>): number {
  const rule = rules.find((candidate) => cost >= candidate.minCostEur && (candidate.maxCostEur === null || cost < candidate.maxCostEur));
  if (!rule) throw new AppError(409, "PRICE_UNAVAILABLE", "No pricing band is configured for this cost.");
  return calculateSupplierPrice(cost, rule);
}

export async function listShippingRules() {
  const supplier = await supplierId();
  return (await getDatabasePool().query(`SELECT id,country_code AS "countryCode",destination_zone_id AS "destinationZoneId",min_weight_kg AS "minWeightKg",max_weight_kg AS "maxWeightKg",amount_eur AS "amountEur",min_delivery_days AS "minDeliveryDays",max_delivery_days AS "maxDeliveryDays",temporary,active,expires_at AS "expiresAt" FROM supplier_shipping_rules WHERE supplier_id=$1 ORDER BY country_code NULLS LAST,destination_zone_id NULLS LAST,min_weight_kg,max_weight_kg NULLS LAST`, [supplier])).rows;
}

export async function listActiveShippingZones() {
  return (await getDatabasePool().query(
    `SELECT z.id,z.name,
            COALESCE(json_agg(json_build_object('countryCode',zc.country_code) ORDER BY zc.country_code)
              FILTER (WHERE zc.country_code IS NOT NULL),'[]'::json) AS countries
       FROM shipping_zones z
       LEFT JOIN shipping_zone_countries zc ON zc.zone_id=z.id
      WHERE z.active=true
      GROUP BY z.id,z.name
      ORDER BY z.name`,
  )).rows;
}

type ShippingRuleRecord = {
  id: string;
  supplierId: string;
  countryCode: string | null;
  destinationZoneId: string | null;
  minWeightKg: number | string;
  maxWeightKg: number | string | null;
  amountEur: number | string;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
  temporary: boolean;
  active: boolean;
  expiresAt: Date | string | null;
};

function shippingRuleValues(input: any) {
  const countryCode = typeof input?.countryCode === "string" ? input.countryCode.trim().toUpperCase() : "";
  const destinationZoneId = typeof input?.destinationZoneId === "string" && input.destinationZoneId.trim() ? input.destinationZoneId.trim() : null;
  const minWeightKg = input?.minWeightKg ?? 0;
  const maxWeightKg = input?.maxWeightKg === undefined ? null : input.maxWeightKg;
  const minDeliveryDays = input?.minDeliveryDays === undefined ? null : input.minDeliveryDays;
  const maxDeliveryDays = input?.maxDeliveryDays === undefined ? null : input.maxDeliveryDays;
  const active = input?.active !== false;
  let expiresAt: Date | null = null;
  if (input?.expiresAt !== undefined && input.expiresAt !== null) {
    expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  }
  if ((countryCode && destinationZoneId) || (!countryCode && !destinationZoneId)) throw new AppError(400, "INVALID_SHIPPING_DESTINATION", "Select exactly one shipping destination: a country or an active zone.");
  if (countryCode && !getEuropeanCountry(countryCode)) throw new AppError(400, "INVALID_COUNTRY_CODE", "Shipping country must be a supported ISO alpha-2 country.");
  if (destinationZoneId && !/^[0-9a-f-]{36}$/i.test(destinationZoneId)) throw new AppError(400, "INVALID_SHIPPING_ZONE", "Shipping zone must be a valid identifier.");
  if (!Number.isFinite(minWeightKg) || minWeightKg < 0 || (maxWeightKg !== null && (!Number.isFinite(maxWeightKg) || maxWeightKg <= minWeightKg))) {
    throw new AppError(400, "INVALID_SHIPPING_WEIGHT_BAND", "Shipping weights must be finite, nonnegative, and have a maximum greater than the minimum.");
  }
  if (!Number.isFinite(input?.amountEur) || input.amountEur < 0) throw new AppError(400, "INVALID_SHIPPING_AMOUNT", "Shipping amount must be a finite nonnegative EUR value.");
  if ((minDeliveryDays !== null && (!Number.isSafeInteger(minDeliveryDays) || minDeliveryDays < 0)) || (maxDeliveryDays !== null && (!Number.isSafeInteger(maxDeliveryDays) || maxDeliveryDays < 0)) || (minDeliveryDays !== null && maxDeliveryDays !== null && maxDeliveryDays < minDeliveryDays)) {
    throw new AppError(400, "INVALID_DELIVERY_DAYS", "Delivery day bounds must be nonnegative integers with the maximum at least the minimum.");
  }
  if (input?.temporary !== true) throw new AppError(400, "SHIPPING_RULE_MUST_BE_TEMPORARY", "Supplier shipping rules must be temporary.");
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new AppError(400, "INVALID_SHIPPING_EXPIRY", "Shipping rule expiry must be a valid date.");
  if (active && expiresAt && expiresAt.getTime() <= Date.now()) throw new AppError(400, "SHIPPING_RULE_ALREADY_EXPIRED", "An active shipping rule must expire in the future.");
  return { countryCode: countryCode || null, destinationZoneId, minWeightKg, maxWeightKg, amountEur: input.amountEur, minDeliveryDays, maxDeliveryDays, temporary: true, active, expiresAt };
}

const shippingRuleSelect = `id,supplier_id AS "supplierId",country_code AS "countryCode",destination_zone_id AS "destinationZoneId",min_weight_kg AS "minWeightKg",max_weight_kg AS "maxWeightKg",amount_eur AS "amountEur",min_delivery_days AS "minDeliveryDays",max_delivery_days AS "maxDeliveryDays",temporary,active,expires_at AS "expiresAt"`;

export async function saveShippingRule(input: any, id?: string, actorAdminId?: string) {
  const supplier = await supplierId();
  const values = shippingRuleValues(input);
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    // Every rule for this supplier shares one lock.  Country/zone membership
    // sets can overlap, so a destination-specific lock is insufficient.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`lizzor:toonies-shipping:${supplier}`]);
    let previous: ShippingRuleRecord | null = null;
    if (id) {
      previous = (await client.query<ShippingRuleRecord>(`SELECT ${shippingRuleSelect} FROM supplier_shipping_rules WHERE id=$1 AND supplier_id=$2 FOR UPDATE`, [id, supplier])).rows[0] ?? null;
      if (!previous) throw new AppError(404, "SHIPPING_RULE_NOT_FOUND", "Shipping rule not found.");
    }
    if (values.destinationZoneId) {
      const zone = (await client.query("SELECT id FROM shipping_zones WHERE id=$1 AND active=true", [values.destinationZoneId])).rows[0];
      if (!zone) throw new AppError(400, "INVALID_SHIPPING_ZONE", "Shipping zone must be active.");
    }
    const overlap = values.active
      ? await client.query(`SELECT r.id
          FROM supplier_shipping_rules r
         WHERE r.supplier_id=$1 AND r.active=true AND r.id IS DISTINCT FROM $2
           AND (r.expires_at IS NULL OR r.expires_at>now())
            AND r.min_weight_kg < COALESCE($5::numeric,1000000000::numeric)
            AND COALESCE(r.max_weight_kg,1000000000::numeric) > $4::numeric
           AND (
             ($3::varchar IS NOT NULL AND (
                r.country_code=$3
                OR (r.destination_zone_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM shipping_zones z
                  JOIN shipping_zone_countries zc ON zc.zone_id=z.id
                   WHERE z.id=r.destination_zone_id AND z.active=true AND zc.country_code=$3
                ))
             ))
             OR ($6::uuid IS NOT NULL AND (
                (r.country_code IS NOT NULL AND EXISTS (
                  SELECT 1 FROM shipping_zone_countries zc
                   WHERE zc.zone_id=$6 AND zc.country_code=r.country_code
                ))
                OR (r.destination_zone_id IS NOT NULL AND EXISTS (
                  SELECT 1
                    FROM shipping_zones existing_zone
                    JOIN shipping_zone_countries candidate ON candidate.zone_id=$6
                    JOIN shipping_zone_countries existing ON existing.country_code=candidate.country_code
                   WHERE existing_zone.id=r.destination_zone_id AND existing_zone.active=true AND existing.zone_id=existing_zone.id
                ))
             ))
           )
         LIMIT 1`, [supplier, id ?? null, values.countryCode, values.minWeightKg, values.maxWeightKg, values.destinationZoneId])
      : { rows: [] };
    if (overlap.rows[0]) throw new AppError(409, "OVERLAPPING_SHIPPING_RULE", "Shipping rules cannot overlap for the same effective destination and weight band.");
    if (id) {
      const result = await client.query(`UPDATE supplier_shipping_rules SET country_code=$2,destination_zone_id=$3,min_weight_kg=$4,max_weight_kg=$5,amount_eur=$6,min_delivery_days=$7,max_delivery_days=$8,temporary=$9,active=$10,expires_at=$11,updated_at=now() WHERE id=$1 AND supplier_id=$12 RETURNING id`, [id, values.countryCode, values.destinationZoneId, values.minWeightKg, values.maxWeightKg, values.amountEur, values.minDeliveryDays, values.maxDeliveryDays, values.temporary, values.active, values.expiresAt, supplier]);
      if (!result.rowCount) throw new AppError(404, "SHIPPING_RULE_NOT_FOUND", "Shipping rule not found.");
    } else {
      const result = await client.query<{ id: string }>(`INSERT INTO supplier_shipping_rules(supplier_id,country_code,destination_zone_id,min_weight_kg,max_weight_kg,amount_eur,min_delivery_days,max_delivery_days,temporary,active,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [supplier, values.countryCode, values.destinationZoneId, values.minWeightKg, values.maxWeightKg, values.amountEur, values.minDeliveryDays, values.maxDeliveryDays, values.temporary, values.active, values.expiresAt]);
      id = result.rows[0].id;
    }
    const current = (await client.query<ShippingRuleRecord>(`SELECT ${shippingRuleSelect} FROM supplier_shipping_rules WHERE id=$1`, [id])).rows[0];
    const action = previous && previous.active && !values.active ? "admin.toonies_shipping_rule_deactivated" : previous ? "admin.toonies_shipping_rule_updated" : "admin.toonies_shipping_rule_created";
    await client.query(`INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,$2,'supplier_shipping_rule',$3,$4,$5)`, [actorAdminId ?? null, action, id, previous ? JSON.stringify(previous) : null, JSON.stringify(current)]);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveTooniesShipping(input: { countryCode: string; weightKg: number }) {
  if (!Number.isFinite(input.weightKg) || input.weightKg < 0) throw new AppError(400, "INVALID_WEIGHT", "Weight must be nonnegative.");
  const supplier = await supplierId();
  return getSupplierShippingProvider("toonies_temporary").quote({
    supplierId: supplier,
    countryCode: input.countryCode,
    weightKg: input.weightKg,
    client: getDatabasePool(),
  });
}
