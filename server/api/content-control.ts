import { Router } from "express";
import { z } from "zod";
import { getDatabasePool } from "../db/client.js";
import { env } from "../config/env.js";
import { getPaymentProvider } from "../payments/provider.js";
import { requireAdmin, requireCsrf, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";

const supportedSections = ["hero", "best_sellers", "deals", "categories", "why_lizzor", "app_banner"] as const;
const sectionLabels: Record<typeof supportedSections[number], string> = { hero: "Hero", best_sellers: "Best Sellers", deals: "Deals", categories: "Categories", why_lizzor: "Why Lizzor", app_banner: "App Banner" };
const pageTypes = ["about", "help", "faq", "informational", "legal"] as const;
const statuses = ["draft", "published", "archived"] as const;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reservedRoutes = new Set([
  "admin", "api", "account", "auth", "cart", "checkout", "content", "pages", "shop", "products", "categories", "brands",
  "deals", "search", "wishlist", "orders", "order-confirmation", "guest-order", "new-arrivals", "start-a-business", "support",
  "chat", "legal", "privacy", "terms", "terms-of-sale", "business-terms", "shipping-delivery", "returns-refunds", "cookies",
  "company-information", "account-deletion", "withdrawal-rights", "returns", "shipping", "consumer-rights", "warranty",
  "payment-information", "contact", "sitemap.xml", "robots.txt",
]);
const nodeTypes = new Set(["doc", "heading", "paragraph", "text", "bulletList", "orderedList", "listItem", "blockquote", "table", "tableRow", "tableHeader", "tableCell", "hardBreak"]);
const markTypes = new Set(["bold", "italic", "link"]);
const MAX_DEPTH = 12, MAX_NODES = 1000, MAX_TEXT = 100000;
function normalizeSlug(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
}
function safeHref(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return false;
  const href = value.trim();
  if (/^(https?:|mailto:|tel:)/i.test(href)) return !/^(?:javascript|data|vbscript):/i.test(href);
  return href.startsWith("/") && !href.startsWith("//") && !/[\u0000-\u001f]/.test(href);
}
function sanitizeBody(input: unknown) {
  let count = 0, chars = 0;
  const walk = (value: any, depth: number): any => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (depth > MAX_DEPTH || ++count > MAX_NODES) throw new AppError(400, "CONTENT_BODY_TOO_LARGE", "Body content exceeds the allowed structure size.");
    const type = typeof value.type === "string" ? value.type : "";
    if (!nodeTypes.has(type)) return null;
    if (type === "text") {
      if (typeof value.text !== "string" || !value.text.length) return null;
      chars += value.text.length;
      if (chars > MAX_TEXT) throw new AppError(400, "CONTENT_BODY_TOO_LARGE", "Body content exceeds the allowed text size.");
      const text = value.text;
      const marks = Array.isArray(value.marks) ? value.marks.flatMap((mark: any) => {
        if (!mark || !markTypes.has(mark.type)) return [];
        if (mark.type === "link") return safeHref(mark.attrs?.href) ? [{ type: "link", attrs: { href: String(mark.attrs.href).trim() } }] : [];
        return [{ type: mark.type }];
      }) : undefined;
      return { type, text, ...(marks?.length ? { marks } : {}) };
    }
    const result: any = { type };
    if (type === "heading") {
      const level = Number(value.attrs?.level);
      if (![2, 3, 4].includes(level)) return null;
      result.attrs = { level };
    }
    if (Array.isArray(value.content)) {
      result.content = value.content.map((child: any) => walk(child, depth + 1)).filter(Boolean);
    }
    return result;
  };
  const result = walk(input, 0);
  if (!result || result.type !== "doc") throw new AppError(400, "CONTENT_BODY_INVALID", "Body content must be a bounded Tiptap document.");
  const children: Record<string, Set<string>> = {
    doc: new Set(["heading", "paragraph", "bulletList", "orderedList", "blockquote", "table"]),
    heading: new Set(["text", "hardBreak"]), paragraph: new Set(["text", "hardBreak"]),
    bulletList: new Set(["listItem"]), orderedList: new Set(["listItem"]),
    listItem: new Set(["paragraph", "bulletList", "orderedList", "blockquote"]),
    blockquote: new Set(["heading", "paragraph", "bulletList", "orderedList"]),
    table: new Set(["tableRow"]), tableRow: new Set(["tableHeader", "tableCell"]),
    tableHeader: new Set(["paragraph", "bulletList", "orderedList", "blockquote"]),
    tableCell: new Set(["paragraph", "bulletList", "orderedList", "blockquote"]),
    text: new Set(), hardBreak: new Set(),
  };
  const validate = (node: any) => {
    const content = Array.isArray(node.content) ? node.content : [];
    if ((node.type === "doc" || ["bulletList", "orderedList", "listItem", "blockquote", "table", "tableRow", "tableHeader", "tableCell"].includes(node.type)) && !content.length) {
      throw new AppError(400, "CONTENT_BODY_INVALID", `The ${node.type} node cannot be empty.`);
    }
    if (content.some((child: any) => !children[node.type]?.has(child.type))) throw new AppError(400, "CONTENT_BODY_INVALID", "Body content contains an invalid node structure.");
    content.forEach(validate);
  };
  validate(result);
  return result;
}
function hasMeaningfulContent(node: any): boolean {
  if (node?.type === "text" && typeof node.text === "string" && node.text.trim()) return true;
  return Array.isArray(node?.content) && node.content.some(hasMeaningfulContent);
}
const pageInput = z.object({
  slug: z.string().trim().min(1).max(240).transform(normalizeSlug).refine((value) => value.length >= 2 && slugPattern.test(value), "Invalid slug"),
  pageType: z.enum(pageTypes), title: z.string().trim().min(2).max(250),
  excerpt: z.string().trim().max(500).nullable().optional(), bodyJson: z.unknown().transform(sanitizeBody),
  seoTitle: z.string().trim().max(70).nullable().optional(), seoDescription: z.string().trim().max(170).nullable().optional(), noIndex: z.boolean().default(false),
});
const uuid = z.string().uuid();

function identifier(value: string | string[]) {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new AppError(400, "INVALID_ID", "A valid identifier is required.");
  return parsed.data;
}

async function audit(client: any, actor: string, action: string, type: string, id: string, oldValue: unknown, newValue: unknown) {
  await client.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,$2,$3,$4,$5,$6)", [actor, action, type, id, JSON.stringify(oldValue), JSON.stringify(newValue)]);
}

export const contentControlRouter = Router();

contentControlRouter.get("/storefront/homepage-sections", async (_request, response) => {
  const rows = await getDatabasePool().query(`SELECT key,title,sort_order AS "sortOrder" FROM homepage_sections WHERE active=true AND key=ANY($1::text[]) ORDER BY sort_order,key`, [supportedSections]);
  response.json({ data: rows.rows });
});

contentControlRouter.get("/admin/homepage", requireAdmin, requirePermission("homepage.view"), async (_request, response) => {
  const pool = getDatabasePool();
  const [sections, banners] = await Promise.all([
    pool.query(`SELECT id,key,title,sort_order AS "sortOrder",active,updated_at AS "updatedAt" FROM homepage_sections WHERE key=ANY($1::text[]) ORDER BY sort_order,key`, [supportedSections]),
    pool.query(`SELECT slot,enabled,published_at AS "publishedAt" FROM storefront_banners WHERE slot IN ('homepage_hero','homepage_app_banner')`),
  ]);
  const byKey = new Map(sections.rows.map((row) => [row.key, row]));
  response.json({ data: {
    sections: supportedSections.map((key, index) => byKey.get(key) ?? { key, title: sectionLabels[key], sortOrder: (index + 1) * 10, active: true, updatedAt: null }),
    banners: banners.rows,
    shortcuts: { hero: "/admin/storefront/banners", app_banner: "/admin/storefront/banners" },
  } });
});

contentControlRouter.put("/admin/homepage", requireCsrf, requireAdmin, requirePermission("homepage.manage"), async (request, response) => {
  const parsed = z.object({ sections: z.array(z.object({ key: z.enum(supportedSections), active: z.boolean() })).length(supportedSections.length) }).safeParse(request.body);
  if (!parsed.success || new Set(parsed.data.sections.map((item) => item.key)).size !== supportedSections.length) throw new AppError(400, "HOMEPAGE_VALIDATION_ERROR", "Submit every supported homepage section exactly once.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const old = (await client.query(`SELECT key,sort_order AS "sortOrder",active FROM homepage_sections WHERE key=ANY($1::text[]) ORDER BY sort_order,key FOR UPDATE`, [supportedSections])).rows;
    for (const [index, section] of parsed.data.sections.entries()) {
      await client.query(`INSERT INTO homepage_sections (key,title,content_json,sort_order,active) VALUES ($1,$2,'{}'::jsonb,$3,$4)
        ON CONFLICT (key) DO UPDATE SET sort_order=EXCLUDED.sort_order,active=EXCLUDED.active,updated_at=now()`, [section.key, sectionLabels[section.key], (index + 1) * 10, section.active]);
    }
    const next = (await client.query(`SELECT key,sort_order AS "sortOrder",active FROM homepage_sections WHERE key=ANY($1::text[]) ORDER BY sort_order,key`, [supportedSections])).rows;
    await audit(client, request.auth!.userId, "homepage.sections_updated", "homepage", request.auth!.userId, old, next);
    await client.query("COMMIT");
    response.json({ data: next });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

const pageSelect = `content_pages.id,content_pages.slug,content_pages.page_type AS "pageType",content_pages.title,content_pages.excerpt,content_pages.body_json AS "bodyJson",content_pages.seo_title AS "seoTitle",content_pages.seo_description AS "seoDescription",content_pages.no_index AS "noIndex",content_pages.status,content_pages.published_at AS "publishedAt",content_pages.archived_at AS "archivedAt",content_pages.created_at AS "createdAt",content_pages.updated_at AS "updatedAt",
  NULLIF(concat_ws(' ',created_actor.first_name,created_actor.last_name),'') AS "createdByAdmin",
  NULLIF(concat_ws(' ',updated_actor.first_name,updated_actor.last_name),'') AS "updatedByAdmin",
  NULLIF(concat_ws(' ',published_actor.first_name,published_actor.last_name),'') AS "publishedByAdmin",
  NULLIF(concat_ws(' ',archived_actor.first_name,archived_actor.last_name),'') AS "archivedByAdmin"`;
const pageJoins = `LEFT JOIN users created_actor ON created_actor.id=content_pages.created_by
  LEFT JOIN users updated_actor ON updated_actor.id=content_pages.updated_by
  LEFT JOIN users published_actor ON published_actor.id=content_pages.published_by
  LEFT JOIN users archived_actor ON archived_actor.id=content_pages.archived_by`;
async function selectPage(client: any, pageId: string) {
  return (await client.query(`SELECT ${pageSelect} FROM content_pages ${pageJoins} WHERE content_pages.id=$1`, [pageId])).rows[0];
}
async function assertSlugAvailable(client: any, slug: string, pageId?: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`content-page-slug:${slug}`]);
  if (reservedRoutes.has(slug)) throw new AppError(409, "CONTENT_SLUG_RESERVED", "That slug is reserved.");
  const collision = await client.query(`SELECT 1 FROM content_pages WHERE slug=$1 AND ($2::uuid IS NULL OR id<>$2)
    UNION ALL SELECT 1 FROM products WHERE slug=$1 UNION ALL SELECT 1 FROM categories WHERE slug=$1 UNION ALL SELECT 1 FROM brands WHERE slug=$1
    UNION ALL SELECT 1 FROM legal_documents WHERE public_route IN ($3,$4)
    UNION ALL SELECT 1 FROM legal_document_aliases WHERE alias_route IN ($3,$4)
    UNION ALL SELECT 1 FROM slug_redirects WHERE old_slug=$1 LIMIT 1`, [slug, pageId ?? null, `/${slug}`, `/pages/${slug}`]);
  if (collision.rows[0]) throw new AppError(409, "CONTENT_SLUG_RESERVED", "That slug conflicts with an existing route.");
}

contentControlRouter.get("/content/:slug", async (request, response) => {
  const slug = z.string().regex(slugPattern).safeParse(request.params.slug);
  if (!slug.success) throw new AppError(404, "CONTENT_NOT_FOUND", "The page was not found.");
  const row = (await getDatabasePool().query(`SELECT slug,page_type AS "pageType",title,excerpt,body_json AS "bodyJson",seo_title AS "seoTitle",seo_description AS "seoDescription",no_index AS "noIndex",status,published_at AS "publishedAt",updated_at AS "updatedAt" FROM content_pages WHERE slug=$1 AND status='published' AND published_at IS NOT NULL`, [slug.data])).rows[0];
  if (!row) throw new AppError(404, "CONTENT_NOT_FOUND", "The page was not found.");
  response.json({ data: row });
});

contentControlRouter.get("/admin/content", requireAdmin, requirePermission("content.view"), async (request, response) => {
  const parsed = z.object({ status: z.enum(statuses).optional(), search: z.string().trim().max(120).optional() }).safeParse(request.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "The content filters are invalid.");
  const values: unknown[] = [], conditions = ["1=1"];
  if (parsed.data.status) { values.push(parsed.data.status); conditions.push(`content_pages.status=$${values.length}`); }
  if (parsed.data.search) { values.push(`%${parsed.data.search}%`); conditions.push(`(content_pages.title ILIKE $${values.length} OR content_pages.slug ILIKE $${values.length})`); }
  const rows = await getDatabasePool().query(`SELECT ${pageSelect} FROM content_pages ${pageJoins} WHERE ${conditions.join(" AND ")} ORDER BY content_pages.updated_at DESC`, values);
  response.json({ data: { items: rows.rows } });
});

contentControlRouter.get("/admin/content/:id", requireAdmin, requirePermission("content.view"), async (request, response) => {
  const row = await selectPage(getDatabasePool(), identifier(request.params.id));
  if (!row) throw new AppError(404, "CONTENT_NOT_FOUND", "The content page was not found.");
  response.json({ data: row });
});

contentControlRouter.post("/admin/content", requireCsrf, requireAdmin, requirePermission("content.manage"), async (request, response) => {
  const parsed = pageInput.safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "CONTENT_VALIDATION_ERROR", "The content page could not be validated.", parsed.error.flatten());
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await assertSlugAvailable(client, parsed.data.slug);
    const pageId = (await client.query(`INSERT INTO content_pages (slug,page_type,title,excerpt,body_json,seo_title,seo_description,no_index,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`, [parsed.data.slug, parsed.data.pageType, parsed.data.title, parsed.data.excerpt ?? null, JSON.stringify(parsed.data.bodyJson), parsed.data.seoTitle ?? null, parsed.data.seoDescription ?? null, parsed.data.noIndex, request.auth!.userId])).rows[0].id;
    const row = await selectPage(client, pageId);
    await audit(client, request.auth!.userId, "content.created", "content_page", row.id, null, { slug: row.slug, status: row.status, pageType: row.pageType });
    await client.query("COMMIT"); response.status(201).json({ data: row });
  } catch (error: any) { await client.query("ROLLBACK"); if (error?.code === "23505") throw new AppError(409, "CONTENT_SLUG_EXISTS", "That content slug already exists."); throw error; } finally { client.release(); }
});

contentControlRouter.patch("/admin/content/:id", requireCsrf, requireAdmin, requirePermission("content.manage"), async (request, response) => {
  const parsed = pageInput.safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "CONTENT_VALIDATION_ERROR", "The content page could not be validated.", parsed.error.flatten());
  const pageId = identifier(request.params.id), client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const old = (await client.query("SELECT * FROM content_pages WHERE id=$1 FOR UPDATE", [pageId])).rows[0];
    if (!old) throw new AppError(404, "CONTENT_NOT_FOUND", "The content page was not found.");
    await assertSlugAvailable(client, parsed.data.slug, pageId);
    await client.query(`UPDATE content_pages SET slug=$2,page_type=$3,title=$4,excerpt=$5,body_json=$6,seo_title=$7,seo_description=$8,no_index=$9,status=CASE WHEN status='published' THEN 'draft' ELSE status END,updated_by=$10,updated_at=now() WHERE id=$1`, [pageId, parsed.data.slug, parsed.data.pageType, parsed.data.title, parsed.data.excerpt ?? null, JSON.stringify(parsed.data.bodyJson), parsed.data.seoTitle ?? null, parsed.data.seoDescription ?? null, parsed.data.noIndex, request.auth!.userId]);
    const row = await selectPage(client, pageId);
    await audit(client, request.auth!.userId, "content.updated", "content_page", pageId, old, row);
    await client.query("COMMIT"); response.json({ data: row });
  } catch (error: any) { await client.query("ROLLBACK"); if (error?.code === "23505") throw new AppError(409, "CONTENT_SLUG_EXISTS", "That content slug already exists."); throw error; } finally { client.release(); }
});

contentControlRouter.post("/admin/content/:id/preview", requireCsrf, requireAdmin, requirePermission("content.view"), async (request, response) => {
  const pageId = identifier(request.params.id), client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const row = await selectPage(client, pageId);
    if (!row) throw new AppError(404, "CONTENT_NOT_FOUND", "The content page was not found.");
    await client.query("DELETE FROM content_page_preview_receipts WHERE consumed_at IS NOT NULL OR expires_at<=now()");
    const receipt = (await client.query(`INSERT INTO content_page_preview_receipts (page_id,actor_id,session_id,page_updated_at,expires_at)
      VALUES ($1,$2,$3,$4,now()+interval '15 minutes') RETURNING id,expires_at AS "expiresAt"`, [pageId, request.auth!.userId, request.auth!.sessionId, row.updatedAt])).rows[0];
    await client.query("COMMIT");
    response.json({ data: { page: row, previewReceipt: receipt.id, expiresAt: receipt.expiresAt } });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

contentControlRouter.post("/admin/content/:id/status", requireCsrf, requireAdmin, requirePermission("content.manage"), async (request, response) => {
  const parsed = z.object({ action: z.enum(["publish", "unpublish", "archive"]), confirmed: z.literal(true), previewReceipt: uuid.optional() }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "CONTENT_ACTION_INVALID", "Choose publish, unpublish, or archive.");
  const pageId = identifier(request.params.id), client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const old = (await client.query("SELECT * FROM content_pages WHERE id=$1 FOR UPDATE", [pageId])).rows[0];
    if (!old) throw new AppError(404, "CONTENT_NOT_FOUND", "The content page was not found.");
    if (parsed.data.action === "publish") {
      if (old.status !== "draft") throw new AppError(409, "CONTENT_TRANSITION_INVALID", "Only a draft can be published.");
      if (!parsed.data.previewReceipt) throw new AppError(409, "CONTENT_PREVIEW_REQUIRED", "Preview the current draft before publishing.");
      const receipt = await client.query(`UPDATE content_page_preview_receipts SET consumed_at=now()
        WHERE id=$1 AND page_id=$2 AND actor_id=$3 AND session_id=$4 AND consumed_at IS NULL AND expires_at>now() AND page_updated_at=$5
        RETURNING id`, [parsed.data.previewReceipt, pageId, request.auth!.userId, request.auth!.sessionId, old.updated_at]);
      if (!receipt.rows[0]) throw new AppError(409, "CONTENT_PREVIEW_REQUIRED", "Preview the current draft again before publishing.");
      await assertSlugAvailable(client, old.slug, pageId);
      const bodyReady = old.body_json?.type === "doc" && Array.isArray(old.body_json.content) && old.body_json.content.length > 0;
      if (!old.title || !bodyReady || !hasMeaningfulContent(old.body_json) || !old.seo_description) throw new AppError(409, "CONTENT_NOT_READY", "Published pages require a title, meaningful content, and SEO description.");
    } else if (parsed.data.action === "unpublish" && old.status !== "published") throw new AppError(409, "CONTENT_TRANSITION_INVALID", "Only a published page can be unpublished.");
    else if (parsed.data.action === "archive" && old.status === "archived") throw new AppError(409, "CONTENT_TRANSITION_INVALID", "That page is already archived.");
    const status = parsed.data.action === "publish" ? "published" : parsed.data.action === "archive" ? "archived" : "draft";
    await client.query(`UPDATE content_pages SET status=$2::content_status,
      published_at=CASE WHEN $2::content_status='published'::content_status THEN now() ELSE published_at END,
      published_by=CASE WHEN $2::content_status='published'::content_status THEN $3 ELSE published_by END,
      archived_at=CASE WHEN $2::content_status='archived'::content_status THEN now() ELSE NULL END,
      archived_by=CASE WHEN $2::content_status='archived'::content_status THEN $3 ELSE archived_by END,
      updated_by=$3,updated_at=now() WHERE id=$1`, [pageId, status, request.auth!.userId]);
    const row = await selectPage(client, pageId);
    await audit(client, request.auth!.userId, `content.${parsed.data.action}`, "content_page", pageId, { status: old.status }, { status: row.status });
    await client.query("COMMIT"); response.json({ data: row });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

const settingDefinitions = {
  storeName: { group: "store", label: "Store name", schema: z.string().trim().min(2).max(80), default: "Lizzor" },
  storefrontAnnouncement: { group: "storefront", label: "Storefront announcement", schema: z.string().trim().max(180), default: "" },
} as const;

async function resolvedSettings() {
  const rows = await getDatabasePool().query("SELECT key,value_json AS value,updated_at AS \"updatedAt\" FROM site_settings WHERE key=ANY($1::text[])", [Object.keys(settingDefinitions)]);
  const stored = new Map(rows.rows.map((row) => [row.key, row]));
  return Object.entries(settingDefinitions).map(([key, definition]) => ({ key, group: definition.group, label: definition.label, value: stored.get(key)?.value ?? definition.default, updatedAt: stored.get(key)?.updatedAt ?? null }));
}

contentControlRouter.get("/admin/settings", requireAdmin, requirePermission("settings.view"), async (_request, response) => {
  const payment = getPaymentProvider();
  response.json({ data: { settings: await resolvedSettings(), invariants: { currency: "EUR", checkoutReservationMinutes: env.CHECKOUT_RESERVATION_MINUTES, paymentProvider: env.PAYMENT_PROVIDER }, readiness: { database: env.DATABASE_URL ? "configured" : "not_configured", sessions: env.SESSION_SECRET ? "configured" : env.NODE_ENV === "production" ? "not_configured" : "development_only", payment: payment.configured ? "configured" : "not_configured", email: env.NODE_ENV === "production" ? env.RESEND_API_KEY ? "configured" : "not_configured" : "development_only" } } });
});

contentControlRouter.get("/storefront/site-settings", async (_request, response) => {
  const settings = await resolvedSettings();
  response.json({ data: Object.fromEntries(settings.map((setting) => [setting.key, setting.value])) });
});

contentControlRouter.patch("/admin/settings", requireCsrf, requireAdmin, requirePermission("settings.manage"), async (request, response) => {
  const parsed = z.object({ values: z.record(z.string(), z.unknown()) }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, "SETTINGS_VALIDATION_ERROR", "Settings must be submitted as an allowlisted value map.");
  const entries = Object.entries(parsed.data.values);
  if (!entries.length || entries.some(([key]) => !(key in settingDefinitions))) throw new AppError(400, "SETTINGS_KEY_INVALID", "One or more settings are not editable.");
  const validated = entries.map(([key, value]) => {
    const definition = settingDefinitions[key as keyof typeof settingDefinitions];
    const result = definition.schema.safeParse(value);
    if (!result.success) throw new AppError(400, "SETTINGS_VALUE_INVALID", `${definition.label} is invalid.`);
    return [key, result.data] as const;
  });
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const old = (await client.query("SELECT key,value_json AS value FROM site_settings WHERE key=ANY($1::text[]) FOR UPDATE", [validated.map(([key]) => key)])).rows;
    for (const [key, value] of validated) await client.query(`INSERT INTO site_settings (key,value_json,updated_by) VALUES ($1,$2,$3)
      ON CONFLICT (key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_by=EXCLUDED.updated_by,updated_at=now()`, [key, JSON.stringify(value), request.auth!.userId]);
    await audit(client, request.auth!.userId, "settings.updated", "site_settings", request.auth!.userId, old, validated.map(([key, value]) => ({ key, value })));
    await client.query("COMMIT"); response.json({ data: { settings: await resolvedSettings() } });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});