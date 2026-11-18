import { createHash } from "node:crypto";
import path from "node:path";
import { Router, type RequestHandler, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { getDatabasePool } from "../db/client.js";
import { requireAdmin, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { legalRequirements } from "../legal/requirements.js";
import { isManagedLegalPdfKey, legalPdfStorage } from "../legal/storage.js";

const block = z.object({ type: z.enum(["heading", "paragraph", "list"]), text: z.string().trim().min(1).max(10000) });
const blocks = z.object({ blocks: z.array(block).max(100) });
const destinations = z.object({
  websiteVisible: z.boolean().default(true),
  appVisible: z.boolean().default(false),
});
const draftSchema = z.object({
  title: z.string().trim().min(2).max(250),
  bodyJson: blocks.default({ blocks: [] }),
  effectiveAt: z.string().datetime().optional(),
  language: z.string().trim().min(2).max(12).default("en"),
  ...destinations.shape,
});
const settingsSchema = z.object({
  effectiveAt: z.string().datetime().nullable(),
  websiteVisible: z.boolean(),
  appVisible: z.boolean(),
});
const profileFields = ["tradingName", "legalEntityName", "legalStructure", "countryOfEstablishment", "primaryOperatingRegion", "merchantSellerType", "registeredAddress", "tradingAddress", "companyRegistrationNumber", "vatNumber", "vatRegistrationCountry", "ossRegistrationStatus", "customerSupportEmail", "privacyRequestEmail", "customerSupportTelephone", "warehouseAddress", "returnsAddress", "companyRegistryName", "effectiveDate"] as const;
const optionalProfileFields = ["productLiabilityInsurerReference"] as const;
const profileSchema = z.object(Object.fromEntries([...profileFields, ...optionalProfileFields].map((key) => [key, z.string().trim().max(1000)])) as Record<(typeof profileFields)[number] | (typeof optionalProfileFields)[number], z.ZodString>)
  .superRefine((value, context) => {
    for (const key of ["customerSupportEmail", "privacyRequestEmail"] as const) if (value[key] && !z.string().email().safeParse(value[key]).success) context.addIssue({ code: "custom", path: [key], message: "Enter a valid email address." });
    if (value.countryOfEstablishment && value.countryOfEstablishment !== "Cyprus") context.addIssue({ code: "custom", path: ["countryOfEstablishment"], message: "The declared establishment country is Cyprus." });
    if (value.primaryOperatingRegion && value.primaryOperatingRegion !== "European Union") context.addIssue({ code: "custom", path: ["primaryOperatingRegion"], message: "The declared operating region is the European Union." });
    if (value.merchantSellerType && value.merchantSellerType !== "Direct retailer") context.addIssue({ code: "custom", path: ["merchantSellerType"], message: "The declared seller model is Direct retailer." });
  });
const placeholder = /\[.*?\]|<[^>]+>|(?:lorem ipsum|tbd|todo|placeholder|insert .* here)/i;
const publicationBlocker = /lawyer-review-required|internal (?:draft|review|required)|unresolved|publication blocker|not for publication/i;
const versionId = z.string().uuid();
const PDF_MAX_BYTES = 20 * 1024 * 1024;
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PDF_MAX_BYTES, files: 1, fields: 4 } });
const acceptPdfUpload: RequestHandler = (request, response, next) => {
  pdfUpload.single("file")(request, response, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      next(new AppError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "LEGAL_PDF_UPLOAD_REJECTED", error.code === "LIMIT_FILE_SIZE" ? "The PDF must be 20 MB or smaller." : "The PDF upload could not be accepted."));
      return;
    }
    next(error);
  });
};

type Profile = z.infer<typeof profileSchema>;
type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };
const defaultProfile: Profile = { tradingName: "Lizzor", legalEntityName: "", legalStructure: "", countryOfEstablishment: "Cyprus", primaryOperatingRegion: "European Union", merchantSellerType: "Direct retailer", registeredAddress: "", tradingAddress: "", companyRegistrationNumber: "", vatNumber: "", vatRegistrationCountry: "", ossRegistrationStatus: "", customerSupportEmail: "", privacyRequestEmail: "", customerSupportTelephone: "", warehouseAddress: "", returnsAddress: "", companyRegistryName: "", productLiabilityInsurerReference: "", effectiveDate: "" };

function profileStatus(profile: Profile) {
  const missing = profileFields.filter((key) => !profile[key]);
  return { complete: missing.length === 0, missing };
}

function documentSafe(version: any, profile: Profile) {
  const text = `${version.title} ${(version.bodyJson?.blocks ?? []).map((item: any) => item.text).join("\n")}`;
  const hasApprovedMaterial = Boolean(version.bodyJson?.blocks?.length || version.pdfStorageKey);
  return !!(profileStatus(profile).complete && version.contentReviewedAt && version.profileApplicabilityVerifiedAt && version.versionNumber > 0 && version.effectiveAt && version.title.trim() && hasApprovedMaterial && !placeholder.test(text) && !publicationBlocker.test(text));
}

function validPdf(file: Express.Multer.File): boolean {
  const tail = file.buffer.subarray(Math.max(0, file.buffer.length - 2048)).toString("latin1");
  return file.mimetype === "application/pdf"
    && path.extname(file.originalname).toLowerCase() === ".pdf"
    && file.buffer.length >= 16
    && file.buffer.subarray(0, 5).toString("ascii") === "%PDF-"
    && tail.includes("%%EOF");
}

async function currentProfile(queryable: Queryable = getDatabasePool()): Promise<Profile> {
  const row = (await queryable.query("SELECT value_json AS value FROM site_settings WHERE key='businessLegalProfile'")).rows[0];
  return profileSchema.parse({ ...defaultProfile, ...(row?.value ?? {}) });
}

async function audit(client: Queryable, actor: string, action: string, type: string, id: string | null, oldValue: unknown, newValue: unknown) {
  await client.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,$2,$3,$4,$5,$6)", [actor, action, type, id, JSON.stringify(oldValue), JSON.stringify(newValue)]);
}

async function lockLegalProfile(client: Queryable) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('businessLegalProfile'))");
}

const versionSelect = `v.id,v.document_id AS "documentId",v.version_number AS "versionNumber",v.language,v.title,v.body_json AS "bodyJson",v.status,v.effective_at AS "effectiveAt",v.published_at AS "publishedAt",v.content_reviewed_at AS "contentReviewedAt",v.content_reviewed_by AS "contentReviewedBy",v.profile_applicability_verified_at AS "profileApplicabilityVerifiedAt",v.profile_applicability_verified_by AS "profileApplicabilityVerifiedBy",v.website_visible AS "websiteVisible",v.app_visible AS "appVisible",v.pdf_storage_key AS "pdfStorageKey",v.pdf_original_filename AS "pdfOriginalFilename",v.pdf_size_bytes AS "pdfSizeBytes",v.pdf_sha256 AS "pdfSha256",v.pdf_uploaded_at AS "pdfUploadedAt",v.pdf_uploaded_by AS "pdfUploadedBy",v.created_at AS "createdAt",v.updated_at AS "updatedAt"`;
const versionReturning = `id,document_id AS "documentId",version_number AS "versionNumber",language,title,body_json AS "bodyJson",status,effective_at AS "effectiveAt",published_at AS "publishedAt",content_reviewed_at AS "contentReviewedAt",content_reviewed_by AS "contentReviewedBy",profile_applicability_verified_at AS "profileApplicabilityVerifiedAt",profile_applicability_verified_by AS "profileApplicabilityVerifiedBy",website_visible AS "websiteVisible",app_visible AS "appVisible",pdf_storage_key AS "pdfStorageKey",pdf_original_filename AS "pdfOriginalFilename",pdf_size_bytes AS "pdfSizeBytes",pdf_sha256 AS "pdfSha256",pdf_uploaded_at AS "pdfUploadedAt",pdf_uploaded_by AS "pdfUploadedBy",created_at AS "createdAt",updated_at AS "updatedAt"`;

function publicVersion(row: any, destination: "website" | "app") {
  return {
    canonicalKey: row.canonicalKey,
    publicRoute: row.publicRoute,
    audience: row.audience,
    versionNumber: row.versionNumber,
    language: row.language,
    title: row.title,
    bodyJson: row.bodyJson,
    status: row.status,
    effectiveAt: row.effectiveAt,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    pdfOriginalFilename: row.pdfOriginalFilename,
    pdfSizeBytes: row.pdfSizeBytes,
    pdfUrl: row.pdfStorageKey ? `/api/v1/legal-documents/versions/${row.id}/pdf?destination=${destination}` : null,
  };
}

async function sendPdf(response: Response, storageKey: string, filename: string, download: boolean) {
  if (!isManagedLegalPdfKey(storageKey)) throw new AppError(404, "LEGAL_PDF_NOT_FOUND", "The legal PDF was not found.");
  const bytes = await legalPdfStorage.load(storageKey);
  if (!bytes) throw new AppError(404, "LEGAL_PDF_NOT_FOUND", "The legal PDF was not found.");
  const disposition = download ? "attachment" : "inline";
  const safeFilename = path.basename(filename || "legal-document.pdf").replace(/[^A-Za-z0-9._ -]/g, "_");
  response.set({
    "Content-Type": "application/pdf",
    "Content-Length": String(bytes.length),
    "Content-Disposition": `${disposition}; filename="${safeFilename}"`,
    "Cache-Control": download ? "private, no-store" : "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  }).send(bytes);
}

export const legalRouter = Router();

legalRouter.get("/legal-requirements", async (_request, response) => {
  response.json({ data: await legalRequirements() });
});

legalRouter.get("/legal-documents", async (request, response) => {
  const parsed = z.enum(["website", "app"]).safeParse(request.query.destination ?? "website");
  if (!parsed.success) throw new AppError(400, "LEGAL_DESTINATION_INVALID", "The legal document destination is invalid.");
  const visibility = parsed.data === "app" ? "v.app_visible" : "v.website_visible";
  const rows = await getDatabasePool().query(`SELECT d.canonical_key AS "canonicalKey",d.public_route AS "publicRoute",d.audience,${versionSelect}
    FROM legal_documents d
    JOIN legal_document_publications p ON p.document_id=d.id AND p.language='en'
    JOIN legal_document_versions v ON v.id=p.version_id
    WHERE v.status='published' AND v.effective_at<=now() AND ${visibility}=true
    ORDER BY d.public_route`);
  response.json({ data: rows.rows.map((row) => publicVersion(row, parsed.data)) });
});

legalRouter.get("/legal-navigation", async (_request, response) => {
  const profile = await currentProfile();
  const rows = (await getDatabasePool().query(`SELECT d.title,d.public_route AS "publicRoute" FROM legal_documents d
    JOIN legal_document_publications p ON p.document_id=d.id AND p.language='en'
    JOIN legal_document_versions v ON v.id=p.version_id
    WHERE v.status='published' AND v.effective_at<=now() AND v.website_visible=true
    ORDER BY d.public_route`)).rows;
  const required = Number((await getDatabasePool().query("SELECT count(*) AS count FROM legal_documents WHERE required_for_commercial_launch=true")).rows[0].count);
  const enabled = profileStatus(profile).complete && rows.length >= required;
  response.json({ data: { enabled, links: enabled ? rows : [] } });
});

legalRouter.get("/legal-documents/versions/:id/pdf", async (request, response) => {
  const destination = z.enum(["website", "app"]).safeParse(request.query.destination ?? "website");
  if (!destination.success) throw new AppError(400, "LEGAL_DESTINATION_INVALID", "The legal document destination is invalid.");
  const visibility = destination.data === "app" ? "v.app_visible" : "v.website_visible";
  const row = (await getDatabasePool().query(`SELECT v.pdf_storage_key AS "storageKey",v.pdf_original_filename AS filename
    FROM legal_document_versions v
    JOIN legal_document_publications p ON p.version_id=v.id
    WHERE v.id=$1 AND v.status='published' AND v.effective_at<=now() AND ${visibility}=true`, [versionId.parse(request.params.id)])).rows[0];
  if (!row?.storageKey) throw new AppError(404, "LEGAL_PDF_NOT_FOUND", "The legal PDF is not published for this destination.");
  await sendPdf(response, row.storageKey, row.filename, request.query.download === "1");
});

legalRouter.get("/legal-documents/route/*path", async (request, response) => {
  const routePath = request.params.path;
  const route = `/${Array.isArray(routePath) ? routePath.join("/") : routePath}`;
  const language = z.string().trim().min(2).max(12).safeParse(request.query.language ?? "en");
  if (!language.success) throw new AppError(400, "LEGAL_LANGUAGE_INVALID", "The requested legal document language is invalid.");
  const row = (await getDatabasePool().query(`SELECT d.canonical_key AS "canonicalKey",d.public_route AS "publicRoute",d.audience,${versionSelect}
    FROM legal_documents d
    LEFT JOIN legal_document_aliases a ON a.document_id=d.id
    JOIN legal_document_publications p ON p.document_id=d.id AND p.language=$2
    JOIN legal_document_versions v ON v.id=p.version_id
    WHERE (d.public_route=$1 OR a.alias_route=$1) AND v.status='published' AND v.effective_at<=now() AND v.website_visible=true`, [route, language.data])).rows[0];
  if (!row) throw new AppError(404, "LEGAL_DOCUMENT_NOT_FOUND", "The legal document is not published for the website.");
  response.json({ data: publicVersion(row, "website") });
});

legalRouter.get("/admin/legal", requireAdmin, requirePermission("legal.view"), async (_request, response) => {
  const profile = await currentProfile();
  const documents = (await getDatabasePool().query(`SELECT d.id,p.version_id AS "currentPublishedVersionId",d.canonical_key AS "canonicalKey",d.public_route AS "publicRoute",d.title,d.audience,
     (SELECT json_agg(x ORDER BY x."versionNumber" DESC) FROM (SELECT ${versionSelect} FROM legal_document_versions v WHERE v.document_id=d.id AND v.language='en') x) AS versions
     FROM legal_documents d LEFT JOIN legal_document_publications p ON p.document_id=d.id AND p.language='en' ORDER BY d.title`)).rows;
  const missingDocuments = documents.filter((document) => {
    const current = document.versions?.find((version: any) => version.id === document.currentPublishedVersionId);
    return !current || current.status !== "published" || !current.websiteVisible || !current.effectiveAt || new Date(current.effectiveAt).getTime() > Date.now();
  }).map((document) => document.canonicalKey);
  const drafts = documents.filter((document) => document.versions?.some((version: any) => version.status === "draft")).map((document) => document.canonicalKey);
  const missingDates = documents.flatMap((document) => (document.versions ?? []).filter((version: any) => version.status === "draft" && !version.effectiveAt).map((version: any) => `${document.canonicalKey} v${version.versionNumber}`));
  const missingPdfs = documents.filter((document) => !(document.versions?.[0]?.pdfStorageKey)).map((document) => document.canonicalKey);
  const awaitingReview = documents.filter((document) => document.versions?.some((version: any) => version.status === "draft" && (!version.contentReviewedAt || !version.profileApplicabilityVerifiedAt))).map((document) => document.canonicalKey);
  const status = profileStatus(profile);
  response.json({ data: { profile, profileStatus: status, documents, readiness: { missingDocuments, drafts, missingDates, missingPdfs, awaitingReview, legalNavigationSafe: status.complete && !missingDocuments.length } } });
});

legalRouter.put("/admin/legal/profile", requireCsrf, requireAdmin, requirePermission("legal.manage"), async (request, response) => {
  const parsed = profileSchema.safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "LEGAL_PROFILE_INVALID", "The legal profile is invalid.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await lockLegalProfile(client);
    const old = await currentProfile(client);
    const publishedCount = Number((await client.query("SELECT count(*) AS count FROM legal_document_versions WHERE status='published'")).rows[0].count);
    if (publishedCount && !profileStatus(parsed.data).complete) throw new AppError(409, "LEGAL_PROFILE_REQUIRED", "A profile supporting published legal documents cannot be made incomplete.");
    await client.query(`INSERT INTO site_settings (key,value_json,updated_by) VALUES ('businessLegalProfile',$1,$2) ON CONFLICT (key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_by=EXCLUDED.updated_by,updated_at=now()`, [JSON.stringify(parsed.data), request.auth!.userId]);
    await audit(client, request.auth!.userId, "legal.profile_updated", "site_settings", null, old, parsed.data);
    await client.query("COMMIT");
    response.json({ data: { profile: parsed.data, profileStatus: profileStatus(parsed.data) } });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

legalRouter.post("/admin/legal/documents/:key/drafts", requireCsrf, requireAdmin, requirePermission("legal.manage"), async (request, response) => {
  const parsed = draftSchema.safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "LEGAL_DRAFT_INVALID", "The legal draft is invalid.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const document = (await client.query("SELECT id FROM legal_documents WHERE canonical_key=$1 FOR UPDATE", [request.params.key])).rows[0];
    if (!document) throw new AppError(404, "LEGAL_DOCUMENT_NOT_FOUND", "The legal document was not found.");
    const next = (await client.query("SELECT COALESCE(MAX(version_number),0)+1 AS number FROM legal_document_versions WHERE document_id=$1 AND language=$2", [document.id, parsed.data.language])).rows[0].number;
    const row = (await client.query(`INSERT INTO legal_document_versions (document_id,version_number,language,title,body_json,effective_at,website_visible,app_visible,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${versionReturning}`, [document.id, next, parsed.data.language, parsed.data.title, JSON.stringify(parsed.data.bodyJson), parsed.data.effectiveAt ?? null, parsed.data.websiteVisible, parsed.data.appVisible, request.auth!.userId])).rows[0];
    await audit(client, request.auth!.userId, "legal.draft_created", "legal_document_version", row.id, null, row);
    await client.query("COMMIT");
    response.status(201).json({ data: row });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

legalRouter.get("/admin/legal/versions/:id/preview", requireAdmin, requirePermission("legal.view"), async (request, response) => {
  const row = (await getDatabasePool().query(`SELECT d.canonical_key AS "canonicalKey",d.public_route AS "publicRoute",d.audience,${versionSelect} FROM legal_document_versions v JOIN legal_documents d ON d.id=v.document_id WHERE v.id=$1`, [versionId.parse(request.params.id)])).rows[0];
  if (!row) throw new AppError(404, "LEGAL_DOCUMENT_NOT_FOUND", "The legal document version was not found.");
  response.json({ data: { ...row, pdfUrl: row.pdfStorageKey ? `/api/v1/admin/legal/versions/${row.id}/pdf` : null } });
});

legalRouter.get("/admin/legal/versions/:id/pdf", requireAdmin, requirePermission("legal.view"), async (request, response) => {
  const row = (await getDatabasePool().query(`SELECT pdf_storage_key AS "storageKey",pdf_original_filename AS filename FROM legal_document_versions WHERE id=$1`, [versionId.parse(request.params.id)])).rows[0];
  if (!row?.storageKey) throw new AppError(404, "LEGAL_PDF_NOT_FOUND", "This version does not have a PDF.");
  await sendPdf(response, row.storageKey, row.filename, request.query.download === "1");
});

legalRouter.post("/admin/legal/versions/:id/pdf", requireCsrf, requireAdmin, requirePermission("legal.manage"), acceptPdfUpload, async (request, response) => {
  const file = request.file;
  if (!file) throw new AppError(400, "LEGAL_PDF_REQUIRED", "Choose a PDF to upload.");
  if (!validPdf(file)) throw new AppError(400, "LEGAL_PDF_INVALID", "Upload a valid PDF file with a .pdf extension.");
  const id = versionId.parse(request.params.id);
  const client = await getDatabasePool().connect();
  let newStorageKey: string | null = null;
  let committed = false;
  let oldStorageKey: string | null = null;
  try {
    await client.query("BEGIN");
    const old = (await client.query(`SELECT ${versionSelect} FROM legal_document_versions v WHERE v.id=$1 FOR UPDATE`, [id])).rows[0];
    if (!old) throw new AppError(404, "LEGAL_DOCUMENT_NOT_FOUND", "The legal document version was not found.");
    if (old.status !== "draft") throw new AppError(409, "LEGAL_PDF_LOCKED", "Published legal PDFs are immutable. Create a new draft version.");
    oldStorageKey = old.pdfStorageKey;
    const stored = await legalPdfStorage.store(file.buffer);
    newStorageKey = stored.storageKey;
    const checksum = createHash("sha256").update(file.buffer).digest("hex");
    const originalFilename = path.basename(file.originalname).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "legal-document.pdf";
    const row = (await client.query(`UPDATE legal_document_versions SET pdf_storage_key=$2,pdf_original_filename=$3,pdf_size_bytes=$4,pdf_sha256=$5,pdf_uploaded_at=now(),pdf_uploaded_by=$6,content_reviewed_at=NULL,content_reviewed_by=NULL,profile_applicability_verified_at=NULL,profile_applicability_verified_by=NULL,updated_at=now() WHERE id=$1 RETURNING ${versionReturning}`, [id, newStorageKey, originalFilename, file.size, checksum, request.auth!.userId])).rows[0];
    await audit(client, request.auth!.userId, oldStorageKey ? "legal.pdf_replaced" : "legal.pdf_uploaded", "legal_document_version", id, old, row);
    await client.query("COMMIT");
    committed = true;
    response.json({ data: row });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    if (!committed && newStorageKey) await legalPdfStorage.remove(newStorageKey).catch(() => undefined);
    if (committed && oldStorageKey && oldStorageKey !== newStorageKey && isManagedLegalPdfKey(oldStorageKey)) await legalPdfStorage.remove(oldStorageKey).catch(() => undefined);
  }
});

legalRouter.patch("/admin/legal/versions/:id/settings", requireCsrf, requireAdmin, requirePermission("legal.manage"), async (request, response) => {
  const parsed = settingsSchema.safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "LEGAL_SETTINGS_INVALID", "The legal version settings are invalid.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const old = (await client.query(`SELECT ${versionSelect} FROM legal_document_versions v WHERE v.id=$1 FOR UPDATE`, [versionId.parse(request.params.id)])).rows[0];
    if (!old) throw new AppError(404, "LEGAL_DOCUMENT_NOT_FOUND", "The legal document version was not found.");
    if (old.status !== "draft") throw new AppError(409, "LEGAL_SETTINGS_LOCKED", "Published legal version settings are immutable. Create a new draft version.");
    const row = (await client.query(`UPDATE legal_document_versions SET effective_at=$2,website_visible=$3,app_visible=$4,content_reviewed_at=NULL,content_reviewed_by=NULL,profile_applicability_verified_at=NULL,profile_applicability_verified_by=NULL,updated_at=now() WHERE id=$1 RETURNING ${versionReturning}`, [old.id, parsed.data.effectiveAt, parsed.data.websiteVisible, parsed.data.appVisible])).rows[0];
    await audit(client, request.auth!.userId, "legal.settings_updated", "legal_document_version", old.id, old, row);
    await client.query("COMMIT");
    response.json({ data: row });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

legalRouter.patch("/admin/legal/versions/:id/readiness", requireCsrf, requireAdmin, requirePermission("legal.manage"), async (request, response) => {
  const parsed = z.object({ contentReviewed: z.boolean(), profileApplicabilityVerified: z.boolean() }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "LEGAL_READINESS_INVALID", "Both legal readiness confirmations must be specified.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const old = (await client.query(`SELECT ${versionSelect} FROM legal_document_versions v WHERE v.id=$1 FOR UPDATE`, [versionId.parse(request.params.id)])).rows[0];
    if (!old) throw new AppError(404, "LEGAL_DOCUMENT_NOT_FOUND", "The legal document version was not found.");
    if (old.status !== "draft") throw new AppError(409, "LEGAL_READINESS_LOCKED", "Readiness confirmations can only be changed on a draft.");
    await client.query(`UPDATE legal_document_versions SET content_reviewed_at=${parsed.data.contentReviewed ? "now()" : "NULL"},content_reviewed_by=${parsed.data.contentReviewed ? "$2" : "NULL"},profile_applicability_verified_at=${parsed.data.profileApplicabilityVerified ? "now()" : "NULL"},profile_applicability_verified_by=${parsed.data.profileApplicabilityVerified ? "$2" : "NULL"},updated_at=now() WHERE id=$1`, [old.id, request.auth!.userId]);
    const row = (await client.query(`SELECT ${versionSelect} FROM legal_document_versions v WHERE v.id=$1`, [old.id])).rows[0];
    await audit(client, request.auth!.userId, "legal.readiness_confirmed", "legal_document_version", old.id, old, row);
    await client.query("COMMIT");
    response.json({ data: row });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

legalRouter.post("/admin/legal/versions/:id/publish", requireCsrf, requireAdmin, requirePermission("legal.manage"), async (request, response) => {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await lockLegalProfile(client);
    const version = (await client.query(`SELECT ${versionSelect} FROM legal_document_versions v WHERE v.id=$1 FOR UPDATE`, [versionId.parse(request.params.id)])).rows[0];
    if (!version) throw new AppError(404, "LEGAL_DOCUMENT_NOT_FOUND", "The legal document version was not found.");
    if (version.status !== "draft") throw new AppError(409, "LEGAL_VERSION_LOCKED", "Only a draft legal version can be published.");
    await client.query("SELECT id FROM legal_documents WHERE id=$1 FOR UPDATE", [version.documentId]);
    const profile = await currentProfile(client);
    if (!documentSafe(version, profile)) throw new AppError(409, "LEGAL_PUBLICATION_NOT_READY", "Publication requires reviewed content or PDF, verified profile applicability, a complete legal profile, effective date, version, and no placeholder text.");
    await client.query("UPDATE legal_document_versions SET status='archived',updated_at=now() WHERE document_id=$1 AND language=$2 AND status='published'", [version.documentId, version.language]);
    const published = (await client.query(`UPDATE legal_document_versions SET status='published',published_at=now(),published_by=$2,updated_at=now() WHERE id=$1 RETURNING ${versionReturning}`, [version.id, request.auth!.userId])).rows[0];
    await client.query(`INSERT INTO legal_document_publications (document_id,language,version_id,published_at,updated_at) VALUES ($1,$2,$3,now(),now()) ON CONFLICT (document_id,language) DO UPDATE SET version_id=EXCLUDED.version_id,published_at=EXCLUDED.published_at,updated_at=now()`, [version.documentId, version.language, version.id]);
    if (version.language === "en") await client.query("UPDATE legal_documents SET current_published_version_id=$2,updated_at=now() WHERE id=$1", [version.documentId, version.id]);
    await audit(client, request.auth!.userId, "legal.version_published", "legal_document_version", version.id, version, published);
    await client.query("COMMIT");
    response.json({ data: published });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});