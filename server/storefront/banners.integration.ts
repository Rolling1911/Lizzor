import assert from "node:assert/strict";
import type { Request } from "express";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { imageDimensions, validateBannerDimensions } from "../api/storefront.js";
import {
  BANNER_SLOTS,
  listPublishedStorefrontBanners,
  listStorefrontBanners,
  publishStorefrontBanner,
  updateStorefrontBanner,
} from "./banners.js";

const marker = `storefront-banner-test-${Date.now()}`;
const request = {
  auth: undefined,
  ip: "127.0.0.1",
  get: (name: string) => name.toLowerCase() === "user-agent" ? marker : undefined,
} as unknown as Request;

function pngFile(width: number, height: number): Express.Multer.File {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return { buffer, mimetype: "image/png", originalname: "banner.png" } as Express.Multer.File;
}

async function run(): Promise<void> {
  const pool = getDatabasePool();
  const baseline = await pool.query("SELECT * FROM storefront_banners ORDER BY slot");
  try {
    const banners = await listStorefrontBanners();
    assert.deepEqual(banners.map((banner) => banner.slot), [...BANNER_SLOTS]);
    assert.deepEqual(imageDimensions(pngFile(1600, 900)), { width: 1600, height: 900 });
    validateBannerDimensions(pngFile(1600, 900), "desktop");
    validateBannerDimensions(pngFile(800, 1000), "mobile");
    validateBannerDimensions(pngFile(1920, 480), "desktop", "homepage_app_banner");
    validateBannerDimensions(pngFile(1920, 480), "mobile", "homepage_app_banner");
    assert.throws(() => validateBannerDimensions(pngFile(700, 400), "desktop"), /at least 1000/);
    assert.throws(() => validateBannerDimensions(pngFile(1000, 1000), "desktop"), /landscape aspect ratio/);

    await updateStorefrontBanner("homepage_app_banner", {
      altText: "Lizzor app artwork",
      enabled: true,
      appStatus: "coming_soon",
      appStoreUrl: "https://apps.apple.com/example",
      googlePlayUrl: "https://play.google.com/example",
      qrImageUrl: "https://example.test/qr.png",
    }, request);
    await publishStorefrontBanner("homepage_app_banner", request);
    let published = (await listPublishedStorefrontBanners()).find((banner) => banner.slot === "homepage_app_banner");
    assert.equal(published?.appStatus, "coming_soon");
    assert.equal(published?.appStoreUrl, null);
    assert.equal(published?.googlePlayUrl, null);
    assert.equal(published?.qrImageUrl, null);

    await updateStorefrontBanner("homepage_app_banner", {
      altText: "Lizzor app artwork",
      enabled: true,
      appStatus: "live",
      appStoreUrl: "https://apps.apple.com/example",
      googlePlayUrl: "https://play.google.com/example",
      qrImageUrl: "https://example.test/qr.png",
    }, request);
    published = (await listPublishedStorefrontBanners()).find((banner) => banner.slot === "homepage_app_banner");
    assert.equal(published?.appStatus, "coming_soon", "saved drafts must not replace the published snapshot");

    await publishStorefrontBanner("homepage_app_banner", request);
    published = (await listPublishedStorefrontBanners()).find((banner) => banner.slot === "homepage_app_banner");
    assert.equal(published?.appStatus, "live");
    assert.equal(published?.appStoreUrl, "https://apps.apple.com/example");

    await updateStorefrontBanner("homepage_app_banner", {
      altText: "Incomplete launch",
      enabled: true,
      appStatus: "live",
      appStoreUrl: null,
      googlePlayUrl: null,
      qrImageUrl: null,
    }, request);
    await assert.rejects(() => publishStorefrontBanner("homepage_app_banner", request), /requires App Store, Google Play, and QR destinations/);

    await updateStorefrontBanner("homepage_app_banner", {
      altText: "Lizzor app artwork",
      enabled: false,
      appStatus: "live",
      appStoreUrl: "https://apps.apple.com/example",
      googlePlayUrl: "https://play.google.com/example",
      qrImageUrl: "https://example.test/qr.png",
    }, request);
    assert.ok((await listPublishedStorefrontBanners()).some((banner) => banner.slot === "homepage_app_banner"));
    await publishStorefrontBanner("homepage_app_banner", request);
    assert.ok(!(await listPublishedStorefrontBanners()).some((banner) => banner.slot === "homepage_app_banner"));

    const audits = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_logs WHERE user_agent = $1", [marker]);
    assert.ok(Number(audits.rows[0]?.count ?? 0) >= 6);
    console.info("Storefront banner management checks passed.");
  } finally {
    await pool.query("DELETE FROM audit_logs WHERE user_agent = $1", [marker]);
    for (const row of baseline.rows) {
      await pool.query(
        `UPDATE storefront_banners SET
          desktop_url=$2, mobile_url=$3, alt_text=$4, enabled=$5, app_status=$6,
          app_store_url=$7, google_play_url=$8, qr_image_url=$9,
          published_config_json=$10, published_at=$11, published_by_user_id=$12,
          updated_by_user_id=$13, created_at=$14, updated_at=$15
         WHERE id=$1`,
        [
          row.id, row.desktop_url, row.mobile_url, row.alt_text, row.enabled, row.app_status,
          row.app_store_url, row.google_play_url, row.qr_image_url, row.published_config_json,
          row.published_at, row.published_by_user_id, row.updated_by_user_id, row.created_at, row.updated_at,
        ],
      );
    }
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});