import type { PoolClient } from "pg";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import type { Request } from "express";
import { enqueueMediaCleanup } from "../catalog/media-cleanup.js";

export const BANNER_SLOTS = ["homepage_hero", "homepage_app_banner"] as const;
export type BannerSlot = typeof BANNER_SLOTS[number];
export type BannerDevice = "desktop" | "mobile";
export type AppStatus = "coming_soon" | "live";

export interface StorefrontBanner {
  id: string;
  slot: BannerSlot;
  desktopUrl: string | null;
  mobileUrl: string | null;
  altText: string | null;
  enabled: boolean;
  appStatus: AppStatus;
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
  qrImageUrl: string | null;
  publishedAt: string | null;
  publishedByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

type BannerRow = {
  id: string;
  slot: string;
  desktopUrl: string | null;
  mobileUrl: string | null;
  altText: string | null;
  enabled: boolean;
  appStatus: string;
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
  qrImageUrl: string | null;
  publishedConfig?: Partial<StorefrontBanner> | null;
  publishedAt: string | null;
  publishedByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

const selectColumns = `
  id, slot, desktop_url AS "desktopUrl", mobile_url AS "mobileUrl",
  alt_text AS "altText", enabled, app_status AS "appStatus",
  app_store_url AS "appStoreUrl", google_play_url AS "googlePlayUrl",
  qr_image_url AS "qrImageUrl", published_config_json AS "publishedConfig",
  published_at::text AS "publishedAt",
  published_by_user_id AS "publishedByUserId",
  updated_by_user_id AS "updatedByUserId",
  created_at::text AS "createdAt", updated_at::text AS "updatedAt"
`;

export function isBannerSlot(value: string): value is BannerSlot {
  return (BANNER_SLOTS as readonly string[]).includes(value);
}

export function isBannerDevice(value: string): value is BannerDevice {
  return value === "desktop" || value === "mobile";
}

export function bannerSlotParam(value: string | string[] | undefined): BannerSlot {
  if (typeof value !== "string" || !isBannerSlot(value)) {
    throw new AppError(400, "INVALID_BANNER_SLOT", "Choose a supported storefront banner slot.");
  }
  return value;
}

export function bannerDeviceParam(value: string | string[] | undefined): BannerDevice {
  if (typeof value !== "string" || !isBannerDevice(value)) {
    throw new AppError(400, "INVALID_BANNER_DEVICE", "Choose desktop or mobile artwork.");
  }
  return value;
}

function toBanner(row: BannerRow): StorefrontBanner {
  if (!isBannerSlot(row.slot) || (row.appStatus !== "coming_soon" && row.appStatus !== "live")) {
    throw new Error("The database contains an invalid storefront banner.");
  }
  return {
    id: row.id,
    slot: row.slot,
    desktopUrl: row.desktopUrl,
    mobileUrl: row.mobileUrl,
    altText: row.altText,
    enabled: row.enabled,
    appStatus: row.appStatus,
    appStoreUrl: row.appStoreUrl,
    googlePlayUrl: row.googlePlayUrl,
    qrImageUrl: row.qrImageUrl,
    publishedAt: row.publishedAt,
    publishedByUserId: row.publishedByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listStorefrontBanners(): Promise<StorefrontBanner[]> {
  const result = await getDatabasePool().query<BannerRow>(
    `SELECT ${selectColumns} FROM storefront_banners
     WHERE slot IN ('homepage_hero', 'homepage_app_banner')
     ORDER BY CASE slot WHEN 'homepage_hero' THEN 1 ELSE 2 END`,
  );
  return result.rows.map(toBanner);
}

export async function listPublishedStorefrontBanners(): Promise<StorefrontBanner[]> {
  const result = await getDatabasePool().query<BannerRow>(
    `SELECT ${selectColumns} FROM storefront_banners
     WHERE published_at IS NOT NULL AND published_config_json IS NOT NULL
       AND slot IN ('homepage_hero', 'homepage_app_banner')
     ORDER BY CASE slot WHEN 'homepage_hero' THEN 1 ELSE 2 END`,
  );
  return result.rows.flatMap((row) => {
    const current = toBanner(row);
    const snapshot = row.publishedConfig ?? {};
    const banner: StorefrontBanner = { ...current, ...snapshot, id: current.id, slot: current.slot, publishedAt: current.publishedAt };
    if (!banner.enabled) return [];
    return banner.slot === "homepage_app_banner" && banner.appStatus !== "live"
      ? { ...banner, appStoreUrl: null, googlePlayUrl: null, qrImageUrl: null }
      : banner;
  });
}

function auditValues(banner: StorefrontBanner): Record<string, unknown> {
  return {
    slot: banner.slot,
    desktopUrl: banner.desktopUrl,
    mobileUrl: banner.mobileUrl,
    altText: banner.altText,
    enabled: banner.enabled,
    appStatus: banner.appStatus,
    appStoreUrl: banner.appStoreUrl,
    googlePlayUrl: banner.googlePlayUrl,
    qrImageUrl: banner.qrImageUrl,
    publishedAt: banner.publishedAt,
  };
}

async function insertAudit(
  client: PoolClient,
  request: Request,
  action: string,
  banner: StorefrontBanner,
  oldValues: Record<string, unknown>,
  newValues: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
      (actor_user_id, action, entity_type, entity_id, old_values_json, new_values_json, ip_address, user_agent)
     VALUES ($1, $2, 'storefront_banner', $3, $4::jsonb, $5::jsonb, $6, $7)`,
    [
      request.auth?.userId ?? null,
      action,
      banner.id,
      JSON.stringify(oldValues),
      JSON.stringify(newValues),
      request.ip ?? null,
      request.get("user-agent") ?? null,
    ],
  );
}

async function readBannerForUpdate(client: PoolClient, slot: BannerSlot): Promise<StorefrontBanner> {
  const result = await client.query<BannerRow>(`SELECT ${selectColumns} FROM storefront_banners WHERE slot = $1 FOR UPDATE`, [slot]);
  const row = result.rows[0];
  if (!row) throw new AppError(404, "BANNER_NOT_FOUND", "The storefront banner could not be found.");
  return toBanner(row);
}

export interface BannerMetadataInput {
  altText: string | null;
  enabled: boolean;
  appStatus: AppStatus;
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
  qrImageUrl: string | null;
}

export async function updateStorefrontBanner(
  slot: BannerSlot,
  input: BannerMetadataInput,
  request: Request,
): Promise<StorefrontBanner> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const current = await readBannerForUpdate(client, slot);
    const result = await client.query<BannerRow>(
      `UPDATE storefront_banners
          SET alt_text = $2, enabled = $3, app_status = $4,
              app_store_url = $5, google_play_url = $6, qr_image_url = $7,
              updated_by_user_id = $8, updated_at = now()
        WHERE slot = $1
        RETURNING ${selectColumns}`,
      [slot, input.altText, input.enabled, input.appStatus, input.appStoreUrl, input.googlePlayUrl, input.qrImageUrl, request.auth?.userId ?? null],
    );
    const updated = result.rows[0];
    if (!updated) throw new AppError(404, "BANNER_NOT_FOUND", "The storefront banner could not be found.");
    const banner = toBanner(updated);
    await insertAudit(client, request, "storefront_banner.updated", banner, auditValues(current), auditValues(banner));
    await client.query("COMMIT");
    return banner;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function publishStorefrontBanner(slot: BannerSlot, request: Request): Promise<StorefrontBanner> {
  const client = await getDatabasePool().connect();
  let previouslyPublishedUrls: string[] = [];
  try {
    await client.query("BEGIN");
    const current = await readBannerForUpdate(client, slot);
    const previousSnapshot = await client.query<{ publishedConfig: Partial<StorefrontBanner> | null }>(
      `SELECT published_config_json AS "publishedConfig" FROM storefront_banners WHERE slot = $1`,
      [slot],
    );
    previouslyPublishedUrls = [
      previousSnapshot.rows[0]?.publishedConfig?.desktopUrl,
      previousSnapshot.rows[0]?.publishedConfig?.mobileUrl,
    ].filter((url): url is string => Boolean(url));
    if (slot === "homepage_app_banner" && current.appStatus === "live" && (!current.appStoreUrl || !current.googlePlayUrl || !current.qrImageUrl)) {
      throw new AppError(400, "APP_LAUNCH_DESTINATIONS_REQUIRED", "Publishing the live app banner requires App Store, Google Play, and QR destinations.");
    }
    const result = await client.query<BannerRow>(
      `UPDATE storefront_banners
          SET published_at = now(), published_by_user_id = $2, updated_at = now(), updated_by_user_id = $2,
              published_config_json = jsonb_build_object(
                'desktopUrl', desktop_url, 'mobileUrl', mobile_url, 'altText', alt_text,
                'enabled', enabled, 'appStatus', app_status, 'appStoreUrl', app_store_url,
                'googlePlayUrl', google_play_url, 'qrImageUrl', qr_image_url
              )
        WHERE slot = $1
        RETURNING ${selectColumns}`,
      [slot, request.auth?.userId ?? null],
    );
    const updated = result.rows[0];
    if (!updated) throw new AppError(404, "BANNER_NOT_FOUND", "The storefront banner could not be found.");
    const banner = toBanner(updated);
    await insertAudit(client, request, "storefront_banner.published", banner, auditValues(current), auditValues(banner));
    for (const url of [...new Set(previouslyPublishedUrls)]) {
      await enqueueMediaCleanup(client, url, "banner_snapshot_replaced");
    }
    await client.query("COMMIT");
    return banner;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceStorefrontBannerAsset(
  slot: BannerSlot,
  device: BannerDevice,
  url: string,
  request: Request,
): Promise<{ banner: StorefrontBanner; previousUrl: string | null }> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const current = await readBannerForUpdate(client, slot);
    const column = device === "desktop" ? "desktop_url" : "mobile_url";
    const result = await client.query<BannerRow>(
      `UPDATE storefront_banners
          SET ${column} = $2, updated_by_user_id = $3, updated_at = now()
        WHERE slot = $1
        RETURNING ${selectColumns}`,
      [slot, url, request.auth?.userId ?? null],
    );
    const updated = result.rows[0];
    if (!updated) throw new AppError(404, "BANNER_NOT_FOUND", "The storefront banner could not be found.");
    const banner = toBanner(updated);
    await insertAudit(
      client,
      request,
      `storefront_banner.${device}_asset_replaced`,
      banner,
      auditValues(current),
      auditValues(banner),
    );
    const previousUrl = device === "desktop" ? current.desktopUrl : current.mobileUrl;
    if (previousUrl && previousUrl !== url) await enqueueMediaCleanup(client, previousUrl, "banner_asset_replaced");
    await client.query("COMMIT");
    return { banner, previousUrl };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function isStorefrontAssetReferenced(url: string): Promise<boolean> {
  const result = await getDatabasePool().query<{ referenced: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM storefront_banners
       WHERE desktop_url = $1 OR mobile_url = $1 OR qr_image_url = $1
          OR published_config_json->>'desktopUrl' = $1
          OR published_config_json->>'mobileUrl' = $1
          OR published_config_json->>'qrImageUrl' = $1
     ) AS referenced`,
    [url],
  );
  return result.rows[0]?.referenced ?? false;
}