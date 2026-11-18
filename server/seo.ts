import type { Request } from "express";
import { env } from "./config/env.js";
import { getDatabasePool } from "./db/client.js";
import { getPricing } from "./pricing/service.js";

export type SeoPage = { title: string; description: string; canonicalPath: string; indexable: boolean; image?: string; type?: "website" | "product"; jsonLd: Record<string, unknown>[]; redirectPath?: string; statusCode?: number };
const blocked = /^(\/(?:search|cart|checkout|account|admin|wishlist|orders?|auth)(?:\/|$))/;
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const originFor = (request: Request) => env.APP_ORIGIN?.replace(/\/$/, "") ?? (env.NODE_ENV === "production" ? "" : `${request.protocol}://${request.get("host")}`);
const absolute = (origin: string, value: string) => value.startsWith("http") ? value : `${origin}${value.startsWith("/") ? value : `/${value}`}`;

export async function getSeoPage(request: Request, requestedPath?: string): Promise<SeoPage> {
  const url = new URL(requestedPath ?? request.originalUrl, "http://seo.local");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const origin = originFor(request);
  const generic = (title: string, description: string, indexable = true): SeoPage => ({ title, description, canonicalPath: pathname, indexable: indexable && !url.search, jsonLd: [] });
  if (blocked.test(pathname)) return generic("Lizzor", "Lizzor wholesale commerce", false);
  if (pathname === "/") {
    const page = generic("Lizzor — Wholesale commerce", "Lizzor wholesale commerce platform");
    page.jsonLd = [
      { "@context": "https://schema.org", "@type": "Organization", name: "Lizzor", url: absolute(origin, "/") },
      { "@context": "https://schema.org", "@type": "WebSite", name: "Lizzor", url: absolute(origin, "/") },
    ];
    return page;
  }
  const staticPages: Record<string, [string, string]> = {
    "/shop": ["Shop | Lizzor", "Browse Lizzor products."], "/categories": ["Categories | Lizzor", "Browse Lizzor product categories."],
    "/brands": ["Brands | Lizzor", "Browse brands available from Lizzor."], "/deals": ["Deals | Lizzor", "Browse current Lizzor deals."],
    "/new-arrivals": ["New arrivals | Lizzor", "Browse new Lizzor products."],
  };
  if (staticPages[pathname]) return generic(...staticPages[pathname]);
  const legal = await getDatabasePool().query<{ title: string; public_route: string }>(
    `SELECT v.title,d.public_route FROM legal_documents d
       LEFT JOIN legal_document_aliases a ON a.document_id=d.id
       JOIN legal_document_publications p ON p.document_id=d.id AND p.language='en'
       JOIN legal_document_versions v ON v.id=p.version_id AND v.status='published' AND v.effective_at<=now() AND v.website_visible=true
     WHERE d.public_route=$1 OR a.alias_route=$1 LIMIT 1`,
    [pathname],
  );
  if (legal.rows[0]) {
    const document = legal.rows[0];
    return { title: document.title, description: `${document.title} at Lizzor.`, canonicalPath: document.public_route, indexable: !url.search, jsonLd: [], redirectPath: pathname === document.public_route ? undefined : document.public_route };
  }
  const contentMatch = pathname.match(/^\/pages\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (contentMatch) {
    const result = await getDatabasePool().query<{ slug: string; title: string; excerpt: string | null; seo_title: string | null; seo_description: string | null; no_index: boolean }>(
      "SELECT slug,title,excerpt,seo_title,seo_description,no_index FROM content_pages WHERE slug=$1 AND status='published' AND published_at IS NOT NULL",
      [contentMatch[1]],
    );
    const content = result.rows[0];
    if (!content) return { ...generic("Page not found | Lizzor", "The requested content page was not found.", false), statusCode: 404 };
    return { title: content.seo_title || `${content.title} | Lizzor`, description: content.seo_description || content.excerpt || `${content.title} at Lizzor.`, canonicalPath: `/pages/${content.slug}`, indexable: !content.no_index && !url.search, type: "website", jsonLd: [] };
  }
  const match = pathname.match(/^\/(products|categories|brands)\/([^/]+)$/);
  if (!match) return generic("Lizzor", "Lizzor wholesale commerce", false);
  const [, segment, slug] = match;
  const table = segment === "products" ? "products" : segment;
  const entity = segment === "products" ? "product" : segment === "categories" ? "category" : "brand";
  const condition = entity === "product"
    ? "status = 'active' AND published_at IS NOT NULL"
    : entity === "category"
      ? "active=true AND (parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=categories.parent_id AND parent.active=true))"
      : "active=true AND EXISTS (SELECT 1 FROM products p WHERE p.brand_id=brands.id AND p.status='active' AND p.published_at IS NOT NULL)";
  const row = await getDatabasePool().query<any>(`SELECT * FROM ${table} WHERE slug = $1 AND ${condition}`, [slug]);
  if (!row.rows[0]) {
    const redirected = await getDatabasePool().query<any>(`SELECT sr.entity_type, p.slug AS product_slug, c.slug AS category_slug, b.slug AS brand_slug
       FROM slug_redirects sr LEFT JOIN products p ON sr.entity_type='product' AND p.id=sr.entity_id AND p.status='active' AND p.published_at IS NOT NULL
       LEFT JOIN categories c ON sr.entity_type='category' AND c.id=sr.entity_id AND c.active=true
         AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))
       LEFT JOIN brands b ON sr.entity_type='brand' AND b.id=sr.entity_id AND b.active=true
         AND EXISTS (SELECT 1 FROM products p WHERE p.brand_id=b.id AND p.status='active' AND p.published_at IS NOT NULL)
      WHERE sr.old_slug=$1 AND sr.entity_type=$2`, [slug, entity]);
    const redirect = redirected.rows[0];
    if (redirect) {
      const targetSlug = redirect.product_slug ?? redirect.category_slug ?? redirect.brand_slug;
      if (targetSlug) return { ...generic("Lizzor", "Lizzor wholesale commerce", false), redirectPath: `/${redirect.entity_type === "product" ? "products" : `${redirect.entity_type}s`}/${targetSlug}` };
    }
    return generic("Lizzor", "Lizzor wholesale commerce", false);
  }
  const item = row.rows[0];
  const label = item.name as string;
  const canonicalPath = `/${segment}/${item.slug}`;
  const page: SeoPage = { title: item.seo_title || `${label} | Lizzor`, description: item.seo_description || item.short_description || item.description || `${label} at Lizzor`, canonicalPath, indexable: !url.search, jsonLd: [] };
  let trail: Array<{ name: string; slug: string }> = [];
  if (entity === "product" || entity === "category") {
    const categoryId = entity === "product" ? item.category_id : item.id;
    trail = (await getDatabasePool().query<{ name: string; slug: string }>(
      `WITH RECURSIVE ancestors AS (
         SELECT id,parent_id,name,slug,0 AS depth FROM categories WHERE id=$1 AND active=true
         UNION ALL
         SELECT c.id,c.parent_id,c.name,c.slug,a.depth+1 FROM categories c JOIN ancestors a ON a.parent_id=c.id WHERE c.active=true
       ) SELECT name,slug FROM ancestors ${entity === "category" ? "WHERE id <> $1" : ""} ORDER BY depth DESC`,
      [categoryId],
    )).rows;
  }
  const rootName = entity === "brand" ? "Brands" : "Categories";
  const rootPath = entity === "brand" ? "/brands" : "/categories";
  const breadcrumbItems = [
    { name: "Home", path: "/" },
    { name: rootName, path: rootPath },
    ...trail.map((category) => ({ name: category.name, path: `/categories/${category.slug}` })),
    { name: label, path: canonicalPath },
  ];
  const breadcrumbs = breadcrumbItems.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, name: crumb.name, item: absolute(origin, crumb.path) }));
  page.jsonLd.push({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: breadcrumbs });
  if (entity === "product") {
    const price = await getPricing(item.id, null, 1);
    const image = await getDatabasePool().query<{ url: string }>("SELECT url FROM product_media WHERE product_id=$1 AND type='image' ORDER BY is_primary DESC, sort_order, created_at LIMIT 1", [item.id]);
    const available = await getDatabasePool().query<{ available: string }>("SELECT COALESCE(sum(i.quantity_on_hand-i.quantity_reserved),0)::text AS available FROM inventory i LEFT JOIN product_variants pv ON pv.id=i.variant_id WHERE i.active=true AND (i.product_id=$1 OR pv.product_id=$1)", [item.id]);
    page.type = "product";
    if (image.rows[0]) page.image = absolute(origin, image.rows[0].url);
    page.jsonLd.push({ "@context": "https://schema.org", "@type": "Product", name: label, url: absolute(origin, canonicalPath), ...(page.image ? { image: page.image } : {}), description: page.description, sku: item.parent_sku, offers: { "@type": "Offer", priceCurrency: "EUR", price: price.unitPrice, availability: Number(available.rows[0]?.available ?? 0) > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", url: absolute(origin, canonicalPath) } });
  } else {
    const imageValue = entity === "category" ? item.image_url : item.logo_url;
    if (imageValue) page.image = absolute(origin, imageValue);
  }
  return page;
}

export function injectSeo(html: string, page: SeoPage, origin: string): string {
  const canonical = absolute(origin, page.canonicalPath);
  const imageTags = page.image ? `<meta property="og:image" content="${escape(page.image)}"><meta name="twitter:image" content="${escape(page.image)}">` : "";
  const head = `<title>${escape(page.title)}</title><meta name="description" content="${escape(page.description)}"><link rel="canonical" href="${escape(canonical)}"><meta name="robots" content="${page.indexable ? "index,follow" : "noindex,follow"}"><meta property="og:title" content="${escape(page.title)}"><meta property="og:description" content="${escape(page.description)}"><meta property="og:type" content="${page.type ?? "website"}"><meta property="og:site_name" content="Lizzor"><meta property="og:url" content="${escape(canonical)}">${imageTags}<meta name="twitter:card" content="${page.image ? "summary_large_image" : "summary"}"><meta name="twitter:title" content="${escape(page.title)}"><meta name="twitter:description" content="${escape(page.description)}">${page.jsonLd.map((data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`).join("")}`;
  return html.replace(/<title>[\s\S]*?<\/title>/i, "").replace(/<meta name="description"[^>]*>/i, "").replace("</head>", `${head}</head>`);
}

export async function sitemap(origin: string): Promise<string> {
  const pool = getDatabasePool();
  // A sitemap document permits at most 50,000 URLs. Keep the combined query
  // bounded, rather than materializing 50,000 rows for each entity type.
  const entries = await pool.query<{ path: string; updated_at: string }>(`SELECT path, updated_at FROM (
    SELECT '/products/' || slug AS path, updated_at FROM products WHERE status='active' AND published_at IS NOT NULL
    UNION ALL
    SELECT '/categories/' || c.slug AS path, c.updated_at FROM categories c
      WHERE c.active=true AND (c.parent_id IS NULL OR EXISTS (SELECT 1 FROM categories parent WHERE parent.id=c.parent_id AND parent.active=true))
      AND EXISTS (SELECT 1 FROM products p WHERE p.category_id=c.id AND p.status='active' AND p.published_at IS NOT NULL)
    UNION ALL
    SELECT '/brands/' || b.slug AS path, b.updated_at FROM brands b WHERE b.active=true
      AND EXISTS (SELECT 1 FROM products p WHERE p.brand_id=b.id AND p.status='active' AND p.published_at IS NOT NULL)
    UNION ALL
    SELECT '/pages/' || slug AS path, updated_at FROM content_pages WHERE status='published' AND published_at IS NOT NULL AND no_index=false
    UNION ALL
    SELECT d.public_route AS path, v.updated_at FROM legal_documents d
      JOIN legal_document_publications lp ON lp.document_id=d.id AND lp.language='en'
      JOIN legal_document_versions v ON v.id=lp.version_id AND v.status='published' AND v.effective_at<=now() AND v.website_visible=true
  ) sitemap_entries ORDER BY updated_at DESC LIMIT 49994`);
  const urls: Array<{ path: string; updated?: string }> = [{ path: "/" }, { path: "/shop" }, { path: "/categories" }, { path: "/brands" }, { path: "/deals" }, { path: "/new-arrivals" },
    ...entries.rows.map((entry) => ({ path: entry.path, updated: entry.updated_at }))];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((x) => `<url><loc>${escape(absolute(origin, x.path))}</loc>${x.updated ? `<lastmod>${new Date(x.updated).toISOString()}</lastmod>` : ""}</url>`).join("")}</urlset>`;
}