import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { hashPassword } from "../auth/password.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = "ContentCmsIntegrationPassword1";
type Json = Record<string, any>;
async function fullLegalState(pool: any) {
  const [documents, aliases, publications, versions] = await Promise.all([
    pool.query("SELECT to_jsonb(d) AS row FROM legal_documents d ORDER BY d.id"),
    pool.query("SELECT to_jsonb(a) AS row FROM legal_document_aliases a ORDER BY a.alias_route"),
    pool.query("SELECT to_jsonb(p) AS row FROM legal_document_publications p ORDER BY p.document_id,p.language"),
    pool.query("SELECT to_jsonb(v) AS row FROM legal_document_versions v ORDER BY v.id"),
  ]);
  return { documents: documents.rows, aliases: aliases.rows, publications: publications.rows, versions: versions.rows };
}

class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly origin: string) {}
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (!["GET", "HEAD"].includes(init.method ?? "GET")) {
      const csrf = this.cookies.get("lizzor_csrf");
      if (csrf) headers.set("x-csrf-token", decodeURIComponent(csrf));
    }
    const response = await fetch(`${this.origin}/api/v1${path}`, { ...init, headers });
    for (const raw of (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const [key, value] = pair.split("=");
      if (value) this.cookies.set(key, value);
    }
    let body: any = null;
    try { body = await response.json(); } catch { /* non-JSON response */ }
    return { response, body };
  }
}

const documentBody = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2, bogus: "removed" }, content: [{ type: "text", text: "CMS heading", marks: [{ type: "bold" }] }] },
    { type: "paragraph", content: [
      { type: "text", text: "safe ", marks: [{ type: "italic" }] },
      { type: "text", text: "bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)", target: "_blank" } }] },
      { type: "hardBreak" },
      { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.test/docs", target: "_blank" } }] },
    ] },
    { type: "unknownNode", attrs: { onclick: "alert(1)" }, content: [{ type: "text", text: "removed" }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] },
    { type: "table", attrs: { class: "unsafe" }, content: [{ type: "tableRow", content: [
      { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Column" }] }] },
      { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
    ] }] },
  ],
};
const body = (title = "CMS test page"): Json => ({
  slug: `CMS  ${title}  ${suffix}`,
  pageType: "informational",
  title,
  excerpt: "A CMS integration page",
  bodyJson: documentBody,
  seoTitle: `${title} SEO`,
  seoDescription: `${title} description`,
  noIndex: false,
});

async function run() {
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const anonymous = new Client(origin), manager = new Client(origin), managerOtherSession = new Client(origin), viewer = new Client(origin);
  const createdPageIds: string[] = [], actorIds: string[] = [], roleIds: string[] = [], auditEntityIds: string[] = [];
  let legalSnapshot: any;
  try {
    legalSnapshot = await fullLegalState(pool);
    assert.equal(legalSnapshot.documents.length, 13, "the canonical legal set must remain intact");

    const permissions = (await pool.query(`SELECT id,permission_key FROM admin_permissions WHERE permission_key IN ('content.view','content.manage')`)).rows;
    assert.equal(permissions.length, 2);
    const managerId = (await pool.query(`INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at)
      VALUES ($1,$2,'Content','Manager','active',now()) RETURNING id`, [`cms-manager-${suffix}@example.test`, await hashPassword(password)])).rows[0].id;
    const viewerId = (await pool.query(`INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at)
      VALUES ($1,$2,'Content','Viewer','active',now()) RETURNING id`, [`cms-viewer-${suffix}@example.test`, await hashPassword(password)])).rows[0].id;
    actorIds.push(managerId, viewerId);
    const managerRole = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`CMS manager ${suffix}`])).rows[0].id;
    const viewerRole = (await pool.query("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`CMS viewer ${suffix}`])).rows[0].id;
    roleIds.push(managerRole, viewerRole);
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key IN ('content.view','content.manage')", [managerRole]);
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key='content.view'", [viewerRole]);
    await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2),($3,$4)", [managerId, managerRole, viewerId, viewerRole]);

    assert.equal((await anonymous.request("/admin/content")).response.status, 403);
    await manager.request("/auth/me");
    await managerOtherSession.request("/auth/me");
    await viewer.request("/auth/me");
    assert.equal((await manager.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `cms-manager-${suffix}@example.test`, password }) })).response.status, 200);
    assert.equal((await managerOtherSession.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `cms-manager-${suffix}@example.test`, password }) })).response.status, 200);
    assert.equal((await viewer.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `cms-viewer-${suffix}@example.test`, password }) })).response.status, 200);
    assert.equal((await viewer.request("/admin/content", { method: "POST", body: "{}" })).response.status, 403);
    assert.equal((await viewer.request("/admin/content")).response.status, 200);

    const draftResponse = await manager.request("/admin/content", { method: "POST", body: JSON.stringify(body()) });
    assert.equal(draftResponse.response.status, 201);
    const draft = draftResponse.body.data;
    createdPageIds.push(draft.id);
    assert.equal(draft.slug, draft.slug.toLowerCase());
    assert.match(draft.slug, /^cms-cms-test-page-/);
    assert.equal((await anonymous.request(`/content/${draft.slug}`)).response.status, 404);
    assert.equal((await anonymous.request(`/admin/content/${draft.id}/preview`, { method: "POST", body: "{}" })).response.status, 403);
    const viewerPreview = await viewer.request(`/admin/content/${draft.id}/preview`, { method: "POST", body: "{}" });
    assert.equal(viewerPreview.response.status, 200);
    const previewResponse = await manager.request(`/admin/content/${draft.id}/preview`, { method: "POST", body: "{}" });
    const preview = previewResponse.body.data.page;
    assert.equal(preview.bodyJson.type, "doc");
    assert.equal(preview.bodyJson.content.some((n: any) => n.type === "unknownNode"), false);
    assert.equal(preview.bodyJson.content.find((n: any) => n.type === "table").content[0].content[0].type, "tableHeader");
    const serialized = JSON.stringify(preview.bodyJson);
    assert.equal(serialized.includes("javascript:"), false);
    assert.equal(serialized.includes("onclick"), false);
    assert.match(serialized, /https:\/\/example\.test/);
    assert.equal((await manager.request("/admin/content", { method: "POST", body: JSON.stringify({
      ...body("Invalid structure"),
      bodyJson: { type: "doc", content: [{ type: "table", content: [{ type: "paragraph", content: [{ type: "text", text: "not a row" }] }] }] },
    }) })).response.status, 400);
    assert.equal((await manager.request("/admin/content", { method: "POST", body: JSON.stringify({
      ...body("Oversized"),
      bodyJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(100_001) }] }] },
    }) })).response.status, 400);

    const duplicate = await manager.request("/admin/content", { method: "POST", body: JSON.stringify(body("Duplicate")) });
    assert.equal(duplicate.response.status, 201);
    createdPageIds.push(duplicate.body.data.id);
    assert.equal((await manager.request("/admin/content", { method: "POST", body: JSON.stringify({ ...body(), slug: draft.slug }) })).response.status, 409);
    for (const slug of ["admin", "shop", "products", "cart"]) {
      assert.equal((await manager.request("/admin/content", { method: "POST", body: JSON.stringify({ ...body("Reserved"), slug }) })).response.status, 409);
    }
    const legalRows = (await pool.query("SELECT public_route FROM legal_documents ORDER BY canonical_key")).rows;
    const legalRoute = legalRows.find((row: any) => /^\/[a-z0-9-]+$/.test(row.public_route));
    if (legalRoute) {
      const collision = await manager.request("/admin/content", { method: "POST", body: JSON.stringify({ ...body("Legal collision"), slug: legalRoute.public_route.slice(1) }) });
      assert.equal(collision.response.status, 409);
    }

    assert.equal((await manager.request(`/admin/content/${draft.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: false }) })).response.status, 400);
    assert.equal((await manager.request(`/admin/content/${draft.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: true }) })).response.status, 409, "confirmation cannot bypass preview");
    assert.equal((await manager.request(`/admin/content/${draft.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: true, previewReceipt: viewerPreview.body.data.previewReceipt }) })).response.status, 409, "another administrator's preview receipt cannot be used");
    assert.equal((await managerOtherSession.request(`/admin/content/${draft.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: true, previewReceipt: previewResponse.body.data.previewReceipt }) })).response.status, 409, "a preview receipt is bound to the exact authenticated session");
    const expiredPreview = await manager.request(`/admin/content/${draft.id}/preview`, { method: "POST", body: "{}" });
    await pool.query("UPDATE content_page_preview_receipts SET expires_at=now()-interval '1 second' WHERE id=$1", [expiredPreview.body.data.previewReceipt]);
    assert.equal((await manager.request(`/admin/content/${draft.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: true, previewReceipt: expiredPreview.body.data.previewReceipt }) })).response.status, 409, "expired preview receipts cannot publish");
    assert.equal((await manager.request(`/admin/content/${draft.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: true, previewReceipt: previewResponse.body.data.previewReceipt }) })).response.status, 200);
    const publicPage = await anonymous.request(`/content/${draft.slug}`);
    assert.equal(publicPage.response.status, 200);
    assert.equal("publishedByAdmin" in publicPage.body.data, false, "public responses must not expose administrator attribution");
    const listed = await manager.request("/admin/content?status=published&search=cms%20test");
    assert.equal(listed.response.status, 200);
    assert.ok(listed.body.data.items.some((item: any) => item.id === draft.id && item.publishedByAdmin && item.publishedAt));
    assert.equal((await manager.request(`/admin/content/${draft.id}`, { method: "PATCH", body: JSON.stringify({ ...body("Edited"), slug: draft.slug }) })).response.status, 200);
    assert.equal((await anonymous.request(`/content/${draft.slug}`)).response.status, 404);
    assert.equal((await manager.request(`/admin/content/${draft.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: true, previewReceipt: previewResponse.body.data.previewReceipt }) })).response.status, 409, "a stale or consumed preview receipt cannot publish an edited draft");
    const editedPreview = await manager.request(`/admin/content/${draft.id}/preview`, { method: "POST", body: "{}" });
    assert.equal((await manager.request(`/admin/content/${draft.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: true, previewReceipt: editedPreview.body.data.previewReceipt }) })).response.status, 200);
    assert.equal((await manager.request(`/admin/content/${draft.id}/status`, { method: "POST", body: JSON.stringify({ action: "unpublish", confirmed: true }) })).response.status, 200);
    assert.equal((await anonymous.request(`/content/${draft.slug}`)).response.status, 404);

    const noIndex = await manager.request("/admin/content", { method: "POST", body: JSON.stringify({ ...body("No index"), noIndex: true }) });
    assert.equal(noIndex.response.status, 201);
    createdPageIds.push(noIndex.body.data.id);
    const noIndexPreview = await manager.request(`/admin/content/${noIndex.body.data.id}/preview`, { method: "POST", body: "{}" });
    assert.equal((await manager.request(`/admin/content/${noIndex.body.data.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: true, previewReceipt: noIndexPreview.body.data.previewReceipt }) })).response.status, 200);
    const sitemap = await fetch(`${origin}/sitemap.xml`);
    assert.equal((await sitemap.text()).includes(`/pages/${noIndex.body.data.slug}`), false);
    assert.equal((await manager.request(`/admin/content/${noIndex.body.data.id}/status`, { method: "POST", body: JSON.stringify({ action: "archive", confirmed: true }) })).response.status, 200);
    assert.equal((await manager.request(`/admin/content/${noIndex.body.data.id}/status`, { method: "POST", body: JSON.stringify({ action: "archive", confirmed: true }) })).response.status, 409);
    const empty = await manager.request("/admin/content", { method: "POST", body: JSON.stringify({ ...body("Empty"), bodyJson: { type: "doc", content: [{ type: "paragraph" }] } }) });
    assert.equal(empty.response.status, 201);
    createdPageIds.push(empty.body.data.id);
    const emptyPreview = await manager.request(`/admin/content/${empty.body.data.id}/preview`, { method: "POST", body: "{}" });
    assert.equal((await manager.request(`/admin/content/${empty.body.data.id}/status`, { method: "POST", body: JSON.stringify({ action: "publish", confirmed: true, previewReceipt: emptyPreview.body.data.previewReceipt }) })).response.status, 409, "empty layout nodes are not publishable content");
    const auditCount = await pool.query("SELECT count(*) FROM audit_logs WHERE entity_type='content_page' AND entity_id=ANY($1::uuid[])", [createdPageIds]);
    assert.ok(Number(auditCount.rows[0].count) >= 4);
    console.log("Content CMS integration passed.");
  } finally {
    // Each cleanup is independent so one missing optional table/row cannot preserve test data.
    await pool.query("DELETE FROM audit_logs WHERE entity_type='content_page' AND entity_id=ANY($1::uuid[])", [createdPageIds]).catch(() => undefined);
    await pool.query("DELETE FROM content_pages WHERE id=ANY($1::uuid[])", [createdPageIds]).catch(() => undefined);
    await pool.query("DELETE FROM admin_user_roles WHERE user_id=ANY($1::uuid[])", [actorIds]).catch(() => undefined);
    await pool.query("DELETE FROM admin_role_permissions WHERE role_id=ANY($1::uuid[])", [roleIds]).catch(() => undefined);
    await pool.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [roleIds]).catch(() => undefined);
    await pool.query("DELETE FROM admin_sessions WHERE user_id=ANY($1::uuid[])", [actorIds]).catch(() => undefined);
    await pool.query("DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])", [actorIds]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [actorIds]).catch(() => undefined);
    const after = await fullLegalState(pool);
    assert.deepEqual(after, legalSnapshot, "CMS test must not modify canonical legal documents");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });