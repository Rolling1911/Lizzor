import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Client } from "@replit/object-storage";
import type { Express } from "express";
import { env } from "../config/env.js";

export const CATALOG_MEDIA_ROOT = path.resolve(env.CATALOG_MEDIA_DIR || path.join(process.cwd(), "uploads", "catalog"));
export const CATALOG_MEDIA_URL_PREFIX = "/catalog-media/";
const APP_STORAGE_PREFIX = "catalog-media/";
export type MediaStorageReadiness = "configured" | "development_only" | "not_configured" | "unavailable";

export interface MediaStorage {
  readonly root: string;
  store(file: Express.Multer.File): Promise<{ url: string; type: "image" | "video" }>;
  load(url: string): Promise<Buffer | null>;
  exists(url: string): Promise<boolean>;
  remove(url: string): Promise<void>;
  listManagedUrls(): Promise<string[]>;
  readiness(): Promise<MediaStorageReadiness>;
}

const acceptedTypes = new Map([
  ["image/jpeg", { type: "image" as const, extension: "jpg" }],
  ["image/png", { type: "image" as const, extension: "png" }],
  ["image/webp", { type: "image" as const, extension: "webp" }],
  ["image/gif", { type: "image" as const, extension: "gif" }],
  ["video/mp4", { type: "video" as const, extension: "mp4" }],
  ["video/webm", { type: "video" as const, extension: "webm" }],
  ["video/quicktime", { type: "video" as const, extension: "mov" }],
]);

export const catalogUploadLimits = {
  fileSize: 25 * 1024 * 1024,
  files: 1,
};

export function catalogMediaMiddleware(app: Express): void {
  app.get(`${CATALOG_MEDIA_URL_PREFIX}:filename`, async (request, response, next) => {
    const filename = request.params.filename;
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      response.status(404).end();
      return;
    }
    const url = `${CATALOG_MEDIA_URL_PREFIX}${filename}`;
    try {
      let bytes: Buffer | null = null;
      let storageError: unknown;
      try {
        bytes = await mediaStorage.load(url);
      } catch (error) {
        storageError = error;
      }
      // Existing checked-in media remains readable during the App Storage
      // migration, but production writes never fall back to deployment disk.
      if (!bytes && mediaStorage !== filesystemStorage) bytes = await filesystemStorage.load(url);
      if (!bytes) {
        if (storageError) throw storageError;
        response.status(404).end();
        return;
      }
      response.setHeader("Cache-Control", "public, max-age=86400");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.type(mediaContentType(filename)).send(bytes);
    } catch (error) {
      next(error);
    }
  });
}

export function getAcceptedMediaType(mimetype: string): "image" | "video" | undefined {
  return acceptedTypes.get(mimetype)?.type;
}

export function isManagedMediaUrl(url: string): boolean {
  return /^\/catalog-media\/[A-Za-z0-9._-]+$/.test(url);
}

function mediaFilename(url: string): string | null {
  return isManagedMediaUrl(url) ? url.slice(CATALOG_MEDIA_URL_PREFIX.length) : null;
}

function mediaContentType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

export function isAcceptedMediaPayload(file: Express.Multer.File): boolean {
  const bytes = file.buffer;
  if (file.mimetype === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimetype === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (file.mimetype === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (file.mimetype === "video/webm") return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (file.mimetype === "video/mp4" || file.mimetype === "video/quicktime") return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
  return false;
}

const filesystemStorage: MediaStorage = {
  root: CATALOG_MEDIA_ROOT,
  async store(file) {
    const metadata = acceptedTypes.get(file.mimetype);
    if (!metadata) throw new Error("Unsupported media type.");
    await mkdir(CATALOG_MEDIA_ROOT, { recursive: true });
    const filename = `${randomUUID()}.${metadata.extension}`;
    const destination = path.join(CATALOG_MEDIA_ROOT, filename);
    await writeFile(destination, file.buffer, { flag: "wx" });
    return { url: `${CATALOG_MEDIA_URL_PREFIX}${filename}`, type: metadata.type };
  },
  async load(url) {
    const filename = mediaFilename(url);
    if (!filename) return null;
    try {
      return await readFile(path.join(CATALOG_MEDIA_ROOT, filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async exists(url) {
    const filename = mediaFilename(url);
    if (!filename) return false;
    try {
      await access(path.join(CATALOG_MEDIA_ROOT, filename), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  async remove(url) {
    if (!isManagedMediaUrl(url)) return;
    const filename = path.basename(url.slice(CATALOG_MEDIA_URL_PREFIX.length));
    try {
      await unlink(path.join(CATALOG_MEDIA_ROOT, filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  },
  async listManagedUrls() {
    try {
      return (await readdir(CATALOG_MEDIA_ROOT, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => `${CATALOG_MEDIA_URL_PREFIX}${entry.name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  async readiness() {
    if (env.NODE_ENV === "production" && !env.CATALOG_MEDIA_DIR) return "not_configured";
    try {
      await mkdir(CATALOG_MEDIA_ROOT, { recursive: true });
      await access(CATALOG_MEDIA_ROOT, constants.R_OK | constants.W_OK);
      return env.NODE_ENV === "production" ? "configured" : env.CATALOG_MEDIA_DIR ? "configured" : "development_only";
    } catch {
      return "unavailable";
    }
  },
};

let appStorageClient: Client | undefined;
const getAppStorageClient = () => appStorageClient ??= new Client();
const objectName = (url: string) => {
  const filename = mediaFilename(url);
  if (!filename) throw new Error("Invalid managed media URL.");
  return `${APP_STORAGE_PREFIX}${filename}`;
};
const requestFailure = (operation: string, error: { message: string; statusCode?: number }) =>
  new Error(`App Storage ${operation} failed${error.statusCode ? ` (${error.statusCode})` : ""}: ${error.message}`);

const appStorage: MediaStorage = {
  root: "app-storage://default/catalog-media",
  async store(file) {
    const metadata = acceptedTypes.get(file.mimetype);
    if (!metadata) throw new Error("Unsupported media type.");
    const filename = `${randomUUID()}.${metadata.extension}`;
    const result = await getAppStorageClient().uploadFromBytes(`${APP_STORAGE_PREFIX}${filename}`, file.buffer, { compress: false });
    if (!result.ok) throw requestFailure("upload", result.error);
    return { url: `${CATALOG_MEDIA_URL_PREFIX}${filename}`, type: metadata.type };
  },
  async load(url) {
    const result = await getAppStorageClient().downloadAsBytes(objectName(url));
    if (!result.ok) {
      if (result.error.statusCode === 404) return null;
      throw requestFailure("download", result.error);
    }
    return result.value[0];
  },
  async exists(url) {
    const result = await getAppStorageClient().exists(objectName(url));
    if (!result.ok) throw requestFailure("existence check", result.error);
    return result.value;
  },
  async remove(url) {
    if (!isManagedMediaUrl(url)) return;
    const result = await getAppStorageClient().delete(objectName(url), { ignoreNotFound: true });
    if (!result.ok) throw requestFailure("delete", result.error);
  },
  async listManagedUrls() {
    const result = await getAppStorageClient().list({ prefix: APP_STORAGE_PREFIX });
    if (!result.ok) throw requestFailure("list", result.error);
    return result.value
      .map((entry) => entry.name.slice(APP_STORAGE_PREFIX.length))
      .filter((filename) => /^[A-Za-z0-9._-]+$/.test(filename))
      .map((filename) => `${CATALOG_MEDIA_URL_PREFIX}${filename}`);
  },
  async readiness() {
    try {
      const result = await getAppStorageClient().list({ prefix: APP_STORAGE_PREFIX, maxResults: 1 });
      return result.ok ? "configured" : result.error.statusCode === 404 ? "not_configured" : "unavailable";
    } catch {
      return "not_configured";
    }
  },
};

export const mediaStorage = env.NODE_ENV === "production" ? appStorage : filesystemStorage;
export const storeCatalogUpload = (file: Express.Multer.File) => mediaStorage.store(file);
export const removeCatalogUpload = (url: string) => mediaStorage.remove(url);
export const getMediaStorageReadiness = () => mediaStorage.readiness();

/** Store a validated image downloaded by a controlled catalogue workflow.
 * Keeping this boundary here ensures supplier imports use the same durable
 * App Storage path as ordinary catalogue uploads in production. */
export async function storeCatalogMediaBuffer(buffer: Buffer, mimetype: string): Promise<{ url: string; type: "image" }> {
  if (buffer.byteLength > catalogUploadLimits.fileSize) throw new Error("Catalog media exceeds the configured size limit.");
  const file = { buffer, mimetype } as Express.Multer.File;
  if (getAcceptedMediaType(mimetype) !== "image" || !isAcceptedMediaPayload(file)) {
    throw new Error("Catalog media has an unsupported image type or signature.");
  }
  const stored = await mediaStorage.store(file);
  return { url: stored.url, type: "image" };
}