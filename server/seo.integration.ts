import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { closeDatabase, getDatabasePool } from "./db/client.js";
import { saveBrand } from "./catalog/service.js";
import { getSeoPage, injectSeo } from "./seo.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const slug = `seo-${suffix}`;

async function main() {
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SEO test server did not start.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let categoryId = "";
  let brandId = "";
  let productId = "";
  try {
    categoryId = (await pool.query<{ id: string }>(
      `INSERT INTO categories (name,slug,description,active,seo_title,seo_description)
       VALUES ($1,$2,$3,true,$4,$5) RETURNING id`,
      [`SEO ${suffix}`, slug, "Public category", "Search-safe title", "Search-safe description"],
    )).rows[0]!.id;
    brandId = await saveBrand({
      name: `SEO Brand ${suffix}`,
      slug: `${slug}-brand`,
      logoUrl: "https://images.example.test/brand.png",
      description: "Public brand",
      seoTitle: "Brand title",
      seoDescription: "Brand description",
      active: true,
    });
    productId = (await pool.query<{ id: string }>(
      `INSERT INTO products
        (name,slug,parent_sku,brand_id,category_id,short_description,description,status,cost_price,base_price,vat_rate,weight,published_at,seo_title,seo_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',2,10,19,1,now(),$8,$9) RETURNING id`,
      [`SEO Product ${suffix}`, `${slug}-product`, `${slug}-sku`, brandId, categoryId, "Public short copy", "Public description", "Product title", "Product description"],
    )).rows[0]!.id;

    const robots = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /Sitemap: https:\/\/shop\.example\.test\/sitemap\.xml/);

    const sitemap = await fetch(`${baseUrl}/sitemap.xml`);
    const sitemapXml = await sitemap.text();
    assert.equal(sitemap.status, 200);
    assert.match(sitemapXml, new RegExp(`<loc>https://shop\\.example\\.test/products/${slug}-product</loc>`));
    assert.doesNotMatch(sitemapXml, /cost_price|quantity_on_hand|customer/i);

    const fakeRequest = {
      originalUrl: `/products/${slug}-product?utm_source=test`,
      protocol: "https",
      get: () => "untrusted.example.test",
    } as any;
    const page = await getSeoPage(fakeRequest);
    assert.equal(page.title, "Product title");
    assert.equal(page.canonicalPath, `/products/${slug}-product`);
    assert.equal(page.indexable, false);
    assert.equal(page.type, "product");
    assert.match(JSON.stringify(page.jsonLd), /"price":10/);
    assert.doesNotMatch(JSON.stringify(page.jsonLd), /cost|margin|quantity_on_hand/i);
    const html = injectSeo("<html><head><title>old</title></head><body></body></html>", page, "https://shop.example.test");
    assert.match(html, /<meta name="robots" content="noindex,follow">/);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://shop\\.example\\.test/products/${slug}-product">`));
    assert.doesNotMatch(html, /untrusted\.example\.test/);

    await pool.query(
      "INSERT INTO slug_redirects (entity_type,entity_id,old_slug) VALUES ('brand',$1,$2)",
      [brandId, `${slug}-old-brand`],
    );
    await assert.rejects(
      saveBrand({
        name: `Other SEO Brand ${suffix}`,
        slug: `${slug}-old-brand`,
        logoUrl: null,
        description: null,
        seoTitle: null,
        seoDescription: null,
        active: true,
      }),
      (error: any) => error?.code === "SLUG_RESERVED" || error?.errorCode === "SLUG_RESERVED",
    );

    const raceSlug = `${slug}-race`;
    const raceBrandId = await saveBrand({
      name: `Race Brand ${suffix}`,
      slug: raceSlug,
      logoUrl: null,
      description: null,
      seoTitle: null,
      seoDescription: null,
      active: true,
    });
    const rename = saveBrand({
      name: `Race Brand ${suffix}`,
      slug: `${raceSlug}-renamed`,
      logoUrl: null,
      description: null,
      seoTitle: null,
      seoDescription: null,
      active: true,
    }, raceBrandId);
    const reuse = saveBrand({
      name: `Race Reuse ${suffix}`,
      slug: raceSlug,
      logoUrl: null,
      description: null,
      seoTitle: null,
      seoDescription: null,
      active: true,
    });
    const [renameResult, reuseResult] = await Promise.allSettled([rename, reuse]);
    assert.equal(renameResult.status, "fulfilled");
    assert.equal(reuseResult.status, "rejected");
    const invariant = await pool.query<{ live: string; reserved: string }>(
      `SELECT
         (SELECT count(*)::text FROM brands WHERE slug=$1) AS live,
         (SELECT count(*)::text FROM slug_redirects WHERE entity_type='brand' AND old_slug=$1) AS reserved`,
      [raceSlug],
    );
    assert.deepEqual(invariant.rows[0], { live: "0", reserved: "1" });
    await pool.query("DELETE FROM brands WHERE id=$1", [raceBrandId]);

    const searchMetadata = await fetch(`${baseUrl}/api/v1/seo/metadata?path=${encodeURIComponent("/search")}`);
    const searchBody = await searchMetadata.json() as any;
    assert.equal(searchBody.data.indexable, false);
    const missingContent = await getSeoPage({ originalUrl: "/pages/definitely-missing-content-page", protocol: "https", get: () => "shop.example.test" } as any);
    assert.equal(missingContent.statusCode, 404);
    assert.equal(missingContent.indexable, false);
    console.log("SEO metadata, crawler controls, privacy, and redirect checks passed.");
  } finally {
    if (productId) await pool.query("DELETE FROM products WHERE id=$1", [productId]);
    if (brandId) await pool.query("DELETE FROM slug_redirects WHERE entity_type='brand' AND entity_id=$1", [brandId]);
    await pool.query("DELETE FROM slug_redirects WHERE old_slug LIKE $1", [`${slug}%`]);
    if (brandId) await pool.query("DELETE FROM brands WHERE id=$1", [brandId]);
    if (categoryId) await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});