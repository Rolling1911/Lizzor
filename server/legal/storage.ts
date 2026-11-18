import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Client } from "@replit/object-storage";
import { env } from "../config/env.js";

const LEGAL_PDF_PREFIX = "legal-documents/";
const LEGAL_PDF_ROOT = path.resolve(process.cwd(), "uploads", "legal-documents");
const legalPdfKeyPattern = /^legal-documents\/[0-9a-f-]{36}\.pdf$/;

type StoredLegalPdf = { storageKey: string };

interface LegalPdfStorage {
  store(bytes: Buffer): Promise<StoredLegalPdf>;
  load(storageKey: string): Promise<Buffer | null>;
  remove(storageKey: string): Promise<void>;
}

function assertStorageKey(storageKey: string): string {
  if (!legalPdfKeyPattern.test(storageKey)) throw new Error("Invalid legal PDF storage key.");
  return storageKey;
}

function localPath(storageKey: string): string {
  return path.join(LEGAL_PDF_ROOT, path.basename(assertStorageKey(storageKey)));
}

const filesystemStorage: LegalPdfStorage = {
  async store(bytes) {
    await mkdir(LEGAL_PDF_ROOT, { recursive: true });
    const storageKey = `${LEGAL_PDF_PREFIX}${randomUUID()}.pdf`;
    await writeFile(localPath(storageKey), bytes, { flag: "wx" });
    return { storageKey };
  },
  async load(storageKey) {
    try {
      return await readFile(localPath(storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async remove(storageKey) {
    try {
      await unlink(localPath(storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  },
};

let appStorageClient: Client | undefined;
const getAppStorageClient = () => appStorageClient ??= new Client();
const storageFailure = (operation: string, error: { message: string; statusCode?: number }) =>
  new Error(`App Storage legal PDF ${operation} failed${error.statusCode ? ` (${error.statusCode})` : ""}: ${error.message}`);

const appStorage: LegalPdfStorage = {
  async store(bytes) {
    const storageKey = `${LEGAL_PDF_PREFIX}${randomUUID()}.pdf`;
    const result = await getAppStorageClient().uploadFromBytes(storageKey, bytes, { compress: false });
    if (!result.ok) throw storageFailure("upload", result.error);
    return { storageKey };
  },
  async load(storageKey) {
    const result = await getAppStorageClient().downloadAsBytes(assertStorageKey(storageKey));
    if (!result.ok) {
      if (result.error.statusCode === 404) return null;
      throw storageFailure("download", result.error);
    }
    return result.value[0];
  },
  async remove(storageKey) {
    const result = await getAppStorageClient().delete(assertStorageKey(storageKey), { ignoreNotFound: true });
    if (!result.ok) throw storageFailure("delete", result.error);
  },
};

export const legalPdfStorage = env.NODE_ENV === "production" ? appStorage : filesystemStorage;
export const isManagedLegalPdfKey = (storageKey: string): boolean => legalPdfKeyPattern.test(storageKey);
export const legalPdfStorageReady = async (): Promise<boolean> => {
  if (env.NODE_ENV === "production") {
    const result = await getAppStorageClient().list({ prefix: LEGAL_PDF_PREFIX, maxResults: 1 });
    return result.ok;
  }
  await mkdir(LEGAL_PDF_ROOT, { recursive: true });
  await access(LEGAL_PDF_ROOT, constants.R_OK | constants.W_OK);
  return true;
};