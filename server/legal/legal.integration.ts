import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { hashPassword } from "../auth/password.js";
import { legalPdfStorage } from "./storage.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = "LegalIntegrationPassword1";
const profile = {
  tradingName: "Lizzor", legalEntityName: "Legal Test Entity", legalStructure: "Limited company", countryOfEstablishment: "Cyprus", primaryOperatingRegion: "European Union", merchantSellerType: "Direct retailer", registeredAddress: "1 Test Street", tradingAddress: "1 Trading Street", companyRegistrationNumber: `REG-${suffix}`, vatNumber: `VAT-${suffix}`, vatRegistrationCountry: "CY", ossRegistrationStatus: "registered", customerSupportEmail: `support-${suffix}@example.test`, privacyRequestEmail: `privacy-${suffix}@example.test`, customerSupportTelephone: "+35722000000", warehouseAddress: "2 Warehouse Road", returnsAddress: "3 Returns Road", companyRegistryName: "Test registry", productLiabilityInsurerReference: "", effectiveDate: "2026-01-01",
};
class Client {
  private cookies = new Map<string, string>();
  constructor(private baseUrl: string) {}
  async requestRaw(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (!["GET", "HEAD"].includes(init.method ?? "GET")) { const csrf = this.cookies.get("lizzor_csrf"); if (csrf) headers.set("x-csrf-token", decodeURIComponent(csrf)); }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    for (const raw of (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []) { const [pair] = raw.split(";"); const [key, value] = pair.split("="); if (value) this.cookies.set(key, value); }
    return response;
  }
  async request(path: string, init: RequestInit = {}) {
    const response = await this.requestRaw(path, init);
    return { response, body: await response.json() };
  }
}
const payload = (title: string, text = "Synthetic test legal text with substantive test content.") => ({ title, bodyJson: { blocks: [{ type: "paragraph", text }] }, effectiveAt: "2026-01-01T00:00:00.000Z" });
const confirm = (client: Client, id: string) => client.request(`/admin/legal/versions/${id}/readiness`, { method: "PATCH", body: JSON.stringify({ contentReviewed: true, profileApplicabilityVerified: true }) });
const pdfForm = (name = "approved-legal-document.pdf", content = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF") => {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "application/pdf" }), name);
  return form;
};

async function run() {
  const pool = getDatabasePool(), app = await createApp({ serveFrontend: false }), server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
  const anonymous = new Client(`http://127.0.0.1:${address.port}`), admin = new Client(`http://127.0.0.1:${address.port}`);
    const createdVersions: string[] = []; const createdStorageKeys: string[] = []; let userId = ""; let roleId = ""; let priorProfile: any; let priorPointers: any[] = []; let priorPublications: any[] = [];
  try {
    priorProfile = (await pool.query("SELECT value_json FROM site_settings WHERE key='businessLegalProfile'")).rows[0];
    priorPointers = (await pool.query("SELECT id,current_published_version_id AS pointer FROM legal_documents")).rows;
    priorPublications = (await pool.query("SELECT document_id,language,version_id,published_at,updated_at FROM legal_document_publications")).rows;
    const permissions = (await pool.query(`INSERT INTO admin_permissions (permission_key,description) VALUES ('legal.view','test'),('legal.manage','test') ON CONFLICT (permission_key) DO UPDATE SET description=EXCLUDED.description RETURNING id,permission_key`)).rows;
    userId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Legal','Tester','active',now()) RETURNING id", [`legal-${suffix}@example.test`, await hashPassword(password)])).rows[0].id;
    roleId = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`Legal test ${suffix}`])).rows[0].id;
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key IN ('legal.view','legal.manage')", [roleId]);
    await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2)", [userId, roleId]);
    await admin.request("/auth/me"); assert.equal((await admin.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `legal-${suffix}@example.test`, password }) })).response.status, 200);

    const privacyDraft = await admin.request("/admin/legal/documents/privacy-policy/drafts", { method: "POST", body: JSON.stringify(payload("Privacy v1")) }); assert.equal(privacyDraft.response.status, 201); createdVersions.push(privacyDraft.body.data.id);
    assert.equal((await anonymous.request(`/admin/legal/versions/${privacyDraft.body.data.id}/preview`)).response.status, 403, "anonymous users cannot preview drafts");
    assert.equal((await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/preview`)).response.status, 200, "authorized admins can preview drafts");
    assert.equal((await anonymous.requestRaw(`/legal-documents/versions/${privacyDraft.body.data.id}/pdf`)).status, 404, "draft PDFs never have a public endpoint");
    assert.equal((await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/pdf`, { method: "POST", body: pdfForm("invalid.txt") })).response.status, 400, "PDF filename validation is enforced");
    assert.equal((await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/pdf`, { method: "POST", body: pdfForm("too-large.pdf", `%PDF-1.7\n${"x".repeat(20 * 1024 * 1024)}\n%%EOF`) })).response.status, 413, "oversized PDFs are rejected explicitly");
    const firstPdf = await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/pdf`, { method: "POST", body: pdfForm() });
    assert.equal(firstPdf.response.status, 200);
    assert.equal(firstPdf.body.data.pdfSizeBytes > 0, true);
    assert.equal(firstPdf.body.data.pdfSha256.length, 64);
    createdStorageKeys.push(firstPdf.body.data.pdfStorageKey);
    const replacementPdf = await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/pdf`, { method: "POST", body: pdfForm("privacy-replacement.pdf", "%PDF-1.7\nreplacement\n%%EOF") });
    assert.equal(replacementPdf.response.status, 200, "draft PDF replacement is allowed");
    assert.notEqual(replacementPdf.body.data.pdfStorageKey, firstPdf.body.data.pdfStorageKey);
    createdStorageKeys.push(replacementPdf.body.data.pdfStorageKey);
    assert.equal((await admin.requestRaw(`/admin/legal/versions/${privacyDraft.body.data.id}/pdf`)).status, 200, "authorized admins can preview draft PDFs");
    assert.equal((await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/settings`, { method: "PATCH", body: JSON.stringify({ effectiveAt: "2026-01-01T00:00:00.000Z", websiteVisible: true, appVisible: true }) })).response.status, 200, "website and app destinations are independently stored");
    assert.equal((await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/publish`, { method: "POST" })).response.status, 409, "blank profile blocks publishing");
    const blank = await admin.request("/admin/legal"); assert.equal(blank.body.data.profileStatus.complete, false, "blank profile cannot be complete");
    await admin.request("/admin/legal/profile", { method: "PUT", body: JSON.stringify(profile) });
    const placeholderDraft = await admin.request("/admin/legal/documents/terms-of-use/drafts", { method: "POST", body: JSON.stringify(payload("Terms placeholder", "[INSERT COMPANY DETAILS HERE]")) }); createdVersions.push(placeholderDraft.body.data.id);
    assert.equal((await admin.request(`/admin/legal/versions/${placeholderDraft.body.data.id}/publish`, { method: "POST" })).response.status, 409, "placeholder text blocks publishing");

    assert.equal((await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/publish`, { method: "POST" })).response.status, 409, "unreviewed publication is rejected");
    assert.equal((await confirm(admin, privacyDraft.body.data.id)).response.status, 200, "auditable readiness confirmation is accepted");
    assert.equal((await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/publish`, { method: "POST" })).response.status, 200);
    const publicV1 = await anonymous.request("/legal-documents/route/privacy"); assert.equal(publicV1.response.status, 200); assert.equal(publicV1.body.data.title, "Privacy v1");
    assert.match(publicV1.body.data.pdfUrl, /destination=website$/, "public page receives a controlled PDF URL");
    assert.equal((await anonymous.requestRaw(publicV1.body.data.pdfUrl.replace("/api/v1", ""))).status, 200, "published website PDF is readable");
    assert.equal((await anonymous.request("/legal-documents?destination=app")).body.data.some((item: any) => item.title === "Privacy v1"), true, "app destination returns only the current app-enabled version");
    assert.equal((await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/pdf`, { method: "POST", body: pdfForm() })).response.status, 409, "published PDFs are immutable");
    assert.equal((await admin.request(`/admin/legal/versions/${privacyDraft.body.data.id}/settings`, { method: "PATCH", body: JSON.stringify({ effectiveAt: "2026-01-01T00:00:00.000Z", websiteVisible: false, appVisible: false }) })).response.status, 409, "published destination settings are immutable");
    const second = await admin.request("/admin/legal/documents/privacy-policy/drafts", { method: "POST", body: JSON.stringify(payload("Privacy v2")) }); createdVersions.push(second.body.data.id);
    assert.equal((await anonymous.request("/legal-documents/route/privacy")).body.data.title, "Privacy v1", "draft is never public");
    assert.ok((await anonymous.request("/legal-documents")).body.data.every((item: any) => item.status === "published"), "public list exposes no drafts");
    await admin.request(`/admin/legal/versions/${second.body.data.id}/settings`, { method: "PATCH", body: JSON.stringify({ effectiveAt: "2026-01-01T00:00:00.000Z", websiteVisible: true, appVisible: false }) });
    await confirm(admin, second.body.data.id); await admin.request(`/admin/legal/versions/${second.body.data.id}/publish`, { method: "POST" });
    assert.equal((await anonymous.request("/legal-documents/route/privacy")).body.data.title, "Privacy v2", "canonical route resolves current published version only");
    assert.equal((await pool.query("SELECT status FROM legal_document_versions WHERE id=$1", [privacyDraft.body.data.id])).rows[0].status, "archived", "prior version remains preserved");
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM legal_document_versions v JOIN legal_documents d ON d.id=v.document_id WHERE d.canonical_key='privacy-policy' AND v.language='en' AND v.status='published'")).rows[0].count), 1, "database invariant leaves one current published version per document/language");
    const french = await admin.request("/admin/legal/documents/privacy-policy/drafts", { method: "POST", body: JSON.stringify({ ...payload("Privacy FR"), language: "fr" }) }); createdVersions.push(french.body.data.id); await confirm(admin, french.body.data.id); assert.equal((await admin.request(`/admin/legal/versions/${french.body.data.id}/publish`, { method: "POST" })).response.status, 200);
    assert.equal((await anonymous.request("/legal-documents/route/privacy?language=fr")).body.data.title, "Privacy FR", "language publication pointer resolves selected language");
    assert.equal((await anonymous.request("/legal-documents/route/privacy")).body.data.title, "Privacy v2", "default English pointer remains independent");
    assert.equal((await anonymous.request("/legal-navigation")).body.data.enabled, false);
    const keys = ["terms-of-use", "consumer-terms-of-sale", "business-terms-of-sale", "shipping-delivery-policy", "returns-refunds-cancellation-policy", "cookie-policy", "company-contact-information", "account-data-deletion-information", "consumer-withdrawal-information", "warranty-legal-guarantee", "payment-information", "contact-complaints"];
    for (const key of keys) { const draft = await admin.request(`/admin/legal/documents/${key}/drafts`, { method: "POST", body: JSON.stringify(payload(`Synthetic ${key}`)) }); createdVersions.push(draft.body.data.id); await confirm(admin, draft.body.data.id); assert.equal((await admin.request(`/admin/legal/versions/${draft.body.data.id}/publish`, { method: "POST" })).response.status, 200); }
    const nav = await anonymous.request("/legal-navigation"); assert.equal(nav.body.data.enabled, true); assert.equal(nav.body.data.links.length, 13);
    const cmsSlug = `legal-cms-${suffix}`; await pool.query("INSERT INTO content_pages (slug,title,body_json,status,published_at) VALUES ($1,'CMS preservation',$2,'published',now())", [cmsSlug, JSON.stringify({ blocks: [{ type: "paragraph", text: "Existing CMS content" }] })]);
    assert.equal((await anonymous.request(`/content/${cmsSlug}`)).response.status, 200, "existing /pages/:slug backing CMS endpoint remains available");
    console.log("Legal integration passed.");
  } finally {
    for (const storageKey of createdStorageKeys) await legalPdfStorage.remove(storageKey).catch(() => undefined);
    await pool.query("DELETE FROM content_pages WHERE slug=$1", [`legal-cms-${suffix}`]).catch(() => undefined);
    await pool.query("DELETE FROM legal_document_publications WHERE version_id=ANY($1::uuid[])", [createdVersions]).catch(() => undefined);
    await pool.query("UPDATE legal_documents SET current_published_version_id=NULL WHERE current_published_version_id=ANY($1::uuid[])", [createdVersions]).catch(() => undefined);
    await pool.query("DELETE FROM legal_document_versions WHERE id=ANY($1::uuid[])", [createdVersions]).catch(() => undefined);
    for (const document of priorPointers) await pool.query("UPDATE legal_documents SET current_published_version_id=$2 WHERE id=$1", [document.id, document.pointer]).catch(() => undefined);
    for (const publication of priorPublications) await pool.query("INSERT INTO legal_document_publications (document_id,language,version_id,published_at,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (document_id,language) DO UPDATE SET version_id=EXCLUDED.version_id,published_at=EXCLUDED.published_at,updated_at=EXCLUDED.updated_at", [publication.document_id, publication.language, publication.version_id, publication.published_at, publication.updated_at]).catch(() => undefined);
    if (priorProfile) await pool.query("UPDATE site_settings SET value_json=$1 WHERE key='businessLegalProfile'", [priorProfile.value_json]).catch(() => undefined); else await pool.query("DELETE FROM site_settings WHERE key='businessLegalProfile'").catch(() => undefined);
    await pool.query("DELETE FROM admin_user_roles WHERE user_id=$1", [userId]).catch(() => undefined); await pool.query("DELETE FROM admin_roles WHERE id=$1", [roleId]).catch(() => undefined); await pool.query("DELETE FROM users WHERE id=$1", [userId]).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve())); await closeDatabase();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });