import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAdmin, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import {
  bannerDeviceParam,
  bannerSlotParam,
  listPublishedStorefrontBanners,
  listStorefrontBanners,
  publishStorefrontBanner,
  replaceStorefrontBannerAsset,
  updateStorefrontBanner,
} from "../storefront/banners.js";
import { catalogUploadLimits, getAcceptedMediaType, isAcceptedMediaPayload, removeCatalogUpload, storeCatalogUpload } from "../catalog/storage.js";
import { scheduleMediaCleanup } from "../catalog/media-cleanup.js";

const bannerRouter = Router();
const imageExtensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: catalogUploadLimits,
  fileFilter: (_request, file, callback) => {
    const extension = file.originalname.toLowerCase().split(".").pop();
    callback(null, getAcceptedMediaType(file.mimetype) === "image" && extension === imageExtensions[file.mimetype]);
  },
});

export function imageDimensions(file: Express.Multer.File): { width: number; height: number } | null {
  const bytes = file.buffer;
  if (file.mimetype === "image/png" && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (file.mimetype === "image/gif" && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (file.mimetype === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  if (file.mimetype === "image/webp" && bytes.length >= 30) {
    const kind = bytes.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (kind === "VP8 " && bytes.length >= 30) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21);
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >> 14) & 0x3fff) + 1,
      };
    }
  }
  return null;
}

export function validateBannerDimensions(file: Express.Multer.File, device: "desktop" | "mobile", slot?: "homepage_hero" | "homepage_app_banner"): void {
  const dimensions = imageDimensions(file);
  if (!dimensions) throw new AppError(400, "BANNER_DIMENSIONS_UNREADABLE", "The image dimensions could not be verified.");
  const isAppArtwork = slot === "homepage_app_banner";
  const minimum = isAppArtwork ? { width: 1000, height: 250 } : device === "desktop" ? { width: 1000, height: 450 } : { width: 560, height: 680 };
  if (dimensions.width < minimum.width || dimensions.height < minimum.height) {
    throw new AppError(
      400,
      "BANNER_DIMENSIONS_TOO_SMALL",
      `${device === "desktop" ? "Desktop" : "Mobile"} artwork must be at least ${minimum.width} × ${minimum.height} pixels.`,
      { dimensions, minimum },
    );
  }
  const ratio = dimensions.width / dimensions.height;
  if (isAppArtwork && (ratio < 3.2 || ratio > 4.8)) {
    throw new AppError(400, "BANNER_ASPECT_RATIO_INVALID", "App banner artwork must use a full-width landscape aspect ratio between 3.2:1 and 4.8:1.");
  }
  if (!isAppArtwork && device === "desktop" && (ratio < 1.3 || ratio > 3.2)) {
    throw new AppError(400, "BANNER_ASPECT_RATIO_INVALID", "Desktop artwork must use a landscape aspect ratio between 1.3:1 and 3.2:1.");
  }
  if (!isAppArtwork && device === "mobile" && (ratio < 0.55 || ratio > 1.15)) {
    throw new AppError(400, "BANNER_ASPECT_RATIO_INVALID", "Mobile artwork must use a portrait aspect ratio between 0.55:1 and 1.15:1.");
  }
}

function metadataSchema() {
  return z.object({
    altText: z.string().trim().max(500).nullable(),
    enabled: z.boolean(),
    appStatus: z.enum(["coming_soon", "live"]),
    appStoreUrl: z.string().trim().url().max(2048).nullable(),
    googlePlayUrl: z.string().trim().url().max(2048).nullable(),
    qrImageUrl: z.string().trim().url().max(2048).nullable(),
  }).superRefine((value, context) => {
    for (const [key, url] of [["appStoreUrl", value.appStoreUrl], ["googlePlayUrl", value.googlePlayUrl]] as const) {
      if (url && !url.startsWith("https://")) context.addIssue({ code: "custom", path: [key], message: "Store links must use HTTPS." });
    }
    if (value.qrImageUrl && !value.qrImageUrl.startsWith("https://") && !value.qrImageUrl.startsWith("/catalog-media/")) {
      context.addIssue({ code: "custom", path: ["qrImageUrl"], message: "QR artwork must use HTTPS or managed catalog media." });
    }
  });
}

function bodyFromSchema<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError(400, "BANNER_VALIDATION_ERROR", "The banner settings could not be validated.", parsed.error.flatten());
  return parsed.data;
}

bannerRouter.get("/storefront/banners", async (_request, response) => {
  const banners = await listPublishedStorefrontBanners();
  response.json({ data: banners });
});

bannerRouter.get("/admin/storefront/banners", requireAdmin, requirePermission("storefront_banners.view"), async (_request, response) => {
  response.json({ data: await listStorefrontBanners() });
});

bannerRouter.patch("/admin/storefront/banners/:slot", requireCsrf, requireAdmin, requirePermission("storefront_banners.manage"), async (request, response) => {
  const slot = bannerSlotParam(request.params.slot);
  const input = bodyFromSchema(metadataSchema(), request.body);
  const banner = await updateStorefrontBanner(slot, input, request);
  response.json({ data: banner });
});

bannerRouter.post("/admin/storefront/banners/:slot/publish", requireCsrf, requireAdmin, requirePermission("storefront_banners.manage"), async (request, response) => {
  const slot = bannerSlotParam(request.params.slot);
  response.json({ data: await publishStorefrontBanner(slot, request) });
});

bannerRouter.post("/admin/storefront/banners/:slot/assets/:device", requireCsrf, requireAdmin, requirePermission("storefront_banners.manage"), bannerUpload.single("file"), async (request, response) => {
  const slot = bannerSlotParam(request.params.slot);
  const device = bannerDeviceParam(request.params.device);
  const file = request.file;
  if (!file) throw new AppError(400, "BANNER_FILE_REQUIRED", "Choose a desktop or mobile image.");
  if (!isAcceptedMediaPayload(file) || getAcceptedMediaType(file.mimetype) !== "image") {
    throw new AppError(400, "BANNER_CONTENT_INVALID", "The uploaded file content does not match an allowed image format.");
  }
  validateBannerDimensions(file, device, slot);
  const stored = await storeCatalogUpload(file);
  try {
    const result = await replaceStorefrontBannerAsset(slot, device, stored.url, request);
    response.status(201).json({ data: result.banner });
  } catch (error) {
    await removeCatalogUpload(stored.url).catch(async () => scheduleMediaCleanup(stored.url, "banner_upload_rollback"));
    throw error;
  }
});

export { bannerRouter as storefrontRouter };