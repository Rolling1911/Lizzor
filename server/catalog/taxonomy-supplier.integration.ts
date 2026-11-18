/**
 * Regression coverage for migration 0063. This file is deliberately a test
 * executable rather than a production bootstrap: it refuses to run outside a
 * mutable integration-test database.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `taxonomy-test-${suffix}`;
const password = "TaxonomyRegressionPassword1";

class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (!["GET", "HEAD"].includes(init.method?.toUpperCase() ?? "GET")) {
      const csrf = this.cookies.get("lizzor_csrf");
      if (csrf) headers.set("x-csrf-token", decodeURIComponent(csrf));
    }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value);
    }
    const type = response.headers.get("content-type") ?? "";
    return { response, body: response.status === 204 ? null : type.includes("json") ? await response.json() : await response.text() };
  }
}

async function run(): Promise<void> {
  assertMutableIntegrationTestDatabase("taxonomy and supplier mapping integration");
  const pool = getDatabasePool();
  let server: Server | undefined;
  const categoryIds: string[] = [];
  const productIds: string[] = [];
  const supplierIds: string[] = [];
  const mappingIds: string[] = [];
  const roleIds: string[] = [];
  const userIds: string[] = [];
  try {
  const productBefore = Number((await pool.query("SELECT count(*) AS count FROM products")).rows[0].count);
  const supplierBefore = Number((await pool.query("SELECT count(*) AS count FROM suppliers")).rows[0].count);
  const mappingBefore = Number((await pool.query("SELECT count(*) AS count FROM supplier_category_mappings")).rows[0].count);
  const expectedRoots = [
    ["women", "Women"], ["men", "Men"], ["kids-baby", "Kids & Baby"], ["home-kitchen", "Home & Kitchen"],
    ["electronics", "Electronics"], ["beauty-personal-care", "Beauty & Personal Care"], ["toys-games", "Toys & Games"],
    ["sports-outdoors", "Sports & Outdoors"], ["travel-luggage", "Travel & Luggage"], ["office-stationery", "Office & Stationery"],
    ["pet-supplies", "Pet Supplies"], ["automotive", "Automotive"], ["tools-diy", "Tools & DIY"],
    ["health-wellness", "Health & Wellness"], ["other", "Other"],
  ] as const;
  const expectedChildSlugs = [
    "women-clothing", "women-shoes", "women-bags", "women-jewellery-accessories", "women-activewear",
    "men-clothing", "men-shoes", "men-bags-accessories", "men-activewear",
    "kids-baby-girls", "kids-baby-boys", "kids-baby-clothing", "kids-baby-essentials", "kids-baby-maternity",
    "home-kitchen-kitchen-dining", "home-kitchen-storage-organization", "home-kitchen-home-decor", "home-kitchen-bedding-textiles", "home-kitchen-cleaning", "home-kitchen-bathroom", "home-kitchen-lighting", "home-kitchen-garden-outdoor", "home-kitchen-furniture",
    "electronics-phone-accessories", "electronics-cables-chargers", "electronics-audio-earbuds", "electronics-smartwatches-wearables", "electronics-power-banks", "electronics-computer-accessories", "electronics-smart-home", "electronics-cameras-security", "electronics-electronic-accessories",
    "beauty-personal-care-skincare", "beauty-personal-care-hair-care", "beauty-personal-care-makeup", "beauty-personal-care-personal-care", "beauty-personal-care-fragrance", "beauty-personal-care-beauty-tools",
    "toys-games-educational-toys", "toys-games-games-puzzles", "toys-games-electronic-toys", "toys-games-outdoor-toys", "toys-games-collectibles",
    "sports-outdoors-fitness", "sports-outdoors-outdoor-camping", "sports-outdoors-sports-equipment", "sports-outdoors-cycling", "sports-outdoors-sports-accessories",
    "travel-luggage-suitcases", "travel-luggage-travel-bags", "travel-luggage-backpacks", "travel-luggage-travel-accessories", "travel-luggage-organizers",
    "office-stationery-pens-writing", "office-stationery-desk-accessories", "office-stationery-office-supplies", "office-stationery-storage-filing", "office-stationery-school-supplies",
    "pet-supplies-dogs", "pet-supplies-cats", "pet-supplies-feeding", "pet-supplies-grooming", "pet-supplies-toys", "pet-supplies-beds-accessories",
    "automotive-car-accessories", "automotive-car-cleaning", "automotive-interior-accessories", "automotive-electronics", "automotive-tools-maintenance",
    "tools-diy-hand-tools", "tools-diy-power-tool-accessories", "tools-diy-hardware", "tools-diy-electrical", "tools-diy-home-improvement",
    "health-wellness-personal-wellness", "health-wellness-mobility-daily-living", "health-wellness-health-accessories", "other-uncategorized",
  ] as const;
  assert.equal(expectedRoots.length, 15);
  assert.equal(expectedChildSlugs.length, 78, "The supplied taxonomy specification contains 78 child entries.");
  const roots = await pool.query<{ canonicalKey: string; name: string; sortOrder: number }>(
    `SELECT canonical_key AS "canonicalKey", name, sort_order AS "sortOrder"
       FROM categories WHERE parent_id IS NULL AND canonical_key = ANY($1::text[]) ORDER BY sort_order`,
    [expectedRoots.map(([key]) => key)],
  );
  assert.deepEqual(roots.rows.map((row) => [row.canonicalKey, row.name]), expectedRoots);
  assert.deepEqual(roots.rows.map((row) => row.sortOrder), expectedRoots.map((_, index) => index + 1));
  const children = await pool.query<{ slug: string; canonicalKey: string; sortOrder: number }>(
    `SELECT slug, canonical_key AS "canonicalKey", sort_order AS "sortOrder" FROM categories
      WHERE slug = ANY($1::text[]) ORDER BY slug`,
    [expectedChildSlugs],
  );
  assert.equal(children.rows.length, expectedChildSlugs.length);
  const expectedChildKeys = expectedChildSlugs.map((slug) => {
    const rootKey = expectedRoots.map(([key]) => key).find((key) => slug.startsWith(`${key}-`));
    assert.ok(rootKey, `missing canonical root for ${slug}`);
    const childKey = slug === "kids-baby-clothing" ? "baby-clothing"
      : slug === "kids-baby-essentials" ? "baby-essentials"
      : slug === "home-kitchen-home-decor" ? "home-d-cor"
      : slug.slice(rootKey.length + 1);
    return `${rootKey}.${childKey}`;
  }).sort();
  assert.deepEqual(children.rows.map((row) => row.canonicalKey).sort(), expectedChildKeys);
  const duplicateCheck = await pool.query(
    `SELECT count(*) AS total, count(DISTINCT lower(slug)) AS slugs, count(DISTINCT lower(canonical_key)) AS keys
       FROM categories WHERE canonical_key IS NOT NULL`,
  );
  assert.equal(duplicateCheck.rows[0].total, duplicateCheck.rows[0].slugs);
  assert.equal(duplicateCheck.rows[0].total, duplicateCheck.rows[0].keys);

  const auditedRoots = [
    ["demo-electronics", "electronics", "5ff935ad-beaf-477e-8d5c-0688123ac756", 3],
    ["demo-home-kitchen", "home-kitchen", "b2e3df42-d570-4603-be35-93d827ec7c6a", 3],
    ["demo-beauty-care", "beauty-personal-care", "ff6297c7-cf6f-42b2-92c8-811378122d91", 1],
    ["demo-travel-accessories", "travel-luggage", "54acfa4b-a0fe-444c-b697-e8d066d8ba42", 2],
    ["demo-office-essentials", "office-stationery", "6a594015-0a27-4dda-babe-fe4c1ac6d439", 3],
  ] as const;
  for (const [oldSlug, canonicalKey, auditedId, expectedProductCount] of auditedRoots) {
    const redirect = await pool.query<{ entityId: string; targetSlug: string }>(
      `SELECT sr.entity_id AS "entityId", c.slug AS "targetSlug" FROM slug_redirects sr JOIN categories c ON c.id=sr.entity_id
        WHERE sr.entity_type='category' AND sr.old_slug=$1`,
      [oldSlug],
    );
    assert.equal(redirect.rows.length, 1);
    assert.equal(redirect.rows[0]!.entityId, auditedId);
    const current = await pool.query<{ id: string; slug: string; canonicalKey: string }>(
      `SELECT id, slug, canonical_key AS "canonicalKey" FROM categories WHERE id=$1`,
      [auditedId],
    );
    assert.equal(current.rows[0]!.canonicalKey, canonicalKey);
    assert.equal(current.rows[0]!.slug, canonicalKey);
    const ownership = await pool.query(
      `SELECT 1 FROM slug_redirects WHERE old_slug=$1
         AND (entity_type <> 'category' OR entity_id <> $2)
       LIMIT 1`,
      [oldSlug, redirect.rows[0]!.entityId],
    );
    assert.equal(ownership.rows.length, 0);
    const relationship = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM products WHERE category_id=$1", [redirect.rows[0]!.entityId]);
    if (process.env.NODE_ENV !== "production") assert.equal(Number(relationship.rows[0]!.count), expectedProductCount);
  }
  assert.equal(Number((await pool.query("SELECT count(*) AS count FROM suppliers")).rows[0].count), supplierBefore);
  assert.equal(Number((await pool.query("SELECT count(*) AS count FROM supplier_category_mappings")).rows[0].count), mappingBefore);

  const root = (await pool.query<{ id: string }>("SELECT id FROM categories WHERE canonical_key='women'")).rows[0]!.id;
  const child = (await pool.query<{ id: string }>("SELECT id FROM categories WHERE canonical_key='women.clothing'")).rows[0]!.id;
  const fixtureRoot = (await pool.query<{ id: string }>(
    "INSERT INTO categories (name,slug,canonical_key,sort_order) VALUES ($1,$2,$3,999) RETURNING id",
    [`${marker} Root`, `${marker}-root`, `${marker}.root`],
  )).rows[0]!.id;
  categoryIds.push(fixtureRoot);
  const fixtureChild = (await pool.query<{ id: string }>(
    "INSERT INTO categories (parent_id,name,slug,canonical_key,sort_order) VALUES ($1,$2,$3,$4,1) RETURNING id",
    [fixtureRoot, `${marker} Child`, `${marker}-child`, `${marker}.child`],
  )).rows[0]!.id;
  categoryIds.push(fixtureChild);
  const fixtureProduct = (await pool.query<{ id: string }>(
    `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at)
     VALUES ($1,$2,$3,$4,'taxonomy storefront fixture',1,2,19,1,'active',now()) RETURNING id`,
    [`${marker} Product`, `${marker}-product`, `${marker}-sku`, fixtureChild],
  )).rows[0]!.id;
  productIds.push(fixtureProduct);
  const invalidDepth = await pool.query("INSERT INTO categories (parent_id,name,slug,canonical_key) VALUES ($1,$2,$3,$4)", [fixtureChild, `${marker} Grandchild`, `${marker}-grandchild`, `${marker}.grandchild`]).catch((error) => error);
  assert.equal((invalidDepth as { code?: string }).code, "23514");
  const app = await createApp({ serveFrontend: false });
  server = app.listen(0, "127.0.0.1");
  const listeningServer = server;
  await new Promise<void>((resolve) => listeningServer.once("listening", resolve));
  const address = listeningServer.address();
  assert.ok(address && typeof address !== "string");
  const adminEmail = `${marker}-admin@example.test`;
  const viewerEmail = `${marker}-viewer@example.test`;
  const role = await pool.query<{ id: string }>("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${marker} role`]);
  roleIds.push(role.rows[0]!.id);
  const viewerRole = await pool.query<{ id: string }>("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`${marker} viewer`]);
  roleIds.push(viewerRole.rows[0]!.id);
  const passwordHash = await hashPassword(password);
  const admin = await pool.query<{ id: string }>("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Taxonomy','Admin','active',now()) RETURNING id", [adminEmail, passwordHash]);
  userIds.push(admin.rows[0]!.id);
  const viewer = await pool.query<{ id: string }>("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Taxonomy','Viewer','active',now()) RETURNING id", [viewerEmail, passwordHash]);
  userIds.push(viewer.rows[0]!.id);
  await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2),($3,$4)", [admin.rows[0]!.id, role.rows[0]!.id, viewer.rows[0]!.id, viewerRole.rows[0]!.id]);
  await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key = ANY($2::text[])", [role.rows[0]!.id, ["categories.edit", "supplier_category_mappings.view", "supplier_category_mappings.manage"]]);
  await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key='supplier_category_mappings.view'", [viewerRole.rows[0]!.id]);
  const supplier = await pool.query<{ id: string }>("INSERT INTO suppliers (name,slug) VALUES ($1,$2) RETURNING id", [`${marker} Supplier`, `${marker}-supplier`]);
  supplierIds.push(supplier.rows[0]!.id);
  const mapping = await pool.query<{ id: string }>(
    "INSERT INTO supplier_category_mappings (supplier_id,external_category_id,external_category_name,external_category_path) VALUES ($1,$2,$3,$4) RETURNING id",
    [supplier.rows[0]!.id, `${marker}-external`, "External", "External / Child"],
  );
  mappingIds.push(mapping.rows[0]!.id);
  const secondMapping = await pool.query<{ id: string }>(
    "INSERT INTO supplier_category_mappings (supplier_id,external_category_id,external_category_name,external_category_path) VALUES ($1,$2,$3,$4) RETURNING id",
    [supplier.rows[0]!.id, `${marker}-external-2`, "External 2", "External / Second"],
  );
  mappingIds.push(secondMapping.rows[0]!.id);
  const defaults = await pool.query<{ status: string; publicationEnabled: boolean; complianceExcluded: boolean }>(
    `SELECT status, publication_enabled AS "publicationEnabled", compliance_excluded AS "complianceExcluded"
       FROM supplier_category_mappings WHERE id=$1`,
    [mapping.rows[0]!.id],
  );
  assert.deepEqual(defaults.rows[0], { status: "unmapped", publicationEnabled: false, complianceExcluded: true });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adminClient = new Client(baseUrl);
  const viewerClient = new Client(baseUrl);
  await adminClient.request("/auth/me");
  await viewerClient.request("/auth/me");
  assert.equal((await adminClient.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: adminEmail, password }) })).response.status, 200);
  assert.equal((await viewerClient.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: viewerEmail, password }) })).response.status, 200);
  let result;
  assert.equal((await viewerClient.request("/admin/catalog/supplier-category-mappings")).response.status, 200);
  assert.equal((await viewerClient.request("/admin/catalog/supplier-category-mappings/categories")).response.status, 200);
  assert.equal((await viewerClient.request(`/admin/catalog/supplier-category-mappings/${mapping.rows[0]!.id}`, { method: "PATCH", body: JSON.stringify({ status: "mapped", rootCategoryId: root }) })).response.status, 403);
  const publicCategories = await adminClient.request("/catalog/categories");
  assert.ok(publicCategories.body.data.some((item: { slug: string }) => item.slug === "women"), "active empty canonical roots remain browsable");
  assert.ok(publicCategories.body.data.some((item: { slug: string }) => item.slug === "women-clothing"), "active empty canonical children remain browsable");
  let storefront = await adminClient.request(`/catalog/categories/${marker}-root`);
  assert.equal(storefront.response.status, 200);
  assert.equal(storefront.body.data.products.items.some((item: { id: string }) => item.id === fixtureProduct), true);
  assert.equal((await adminClient.request(`/catalog/products?categoryId=${fixtureRoot}`)).body.data.items.some((item: { id: string }) => item.id === fixtureProduct), true);
  result = await adminClient.request(`/admin/categories/${fixtureChild}`, {
    method: "PATCH",
    body: JSON.stringify({ name: `${marker} Child`, slug: `${marker}-child`, canonicalKey: `${marker}.child`, parentId: fixtureRoot, description: null, imageUrl: null, sortOrder: 1, active: false }),
  });
  assert.equal(result.response.status, 200);
  result = await adminClient.request(`/admin/categories/${fixtureChild}`, {
    method: "PATCH",
    body: JSON.stringify({ name: `${marker} Child Renamed`, slug: `${marker}-child`, parentId: fixtureRoot, description: null, imageUrl: null, sortOrder: 1, active: false }),
  });
  assert.equal(result.response.status, 200);
  const preservedCanonical = await pool.query<{ canonicalKey: string }>("SELECT canonical_key AS \"canonicalKey\" FROM categories WHERE id=$1", [fixtureChild]);
  assert.equal(preservedCanonical.rows[0]!.canonicalKey, `${marker}.child`);
  result = await adminClient.request(`/admin/categories/${fixtureRoot}`, {
    method: "PATCH",
    body: JSON.stringify({ name: `${marker} Root`, slug: `${marker}-root`, canonicalKey: `${marker}.root`, parentId: root, description: null, imageUrl: null, sortOrder: 999, active: true }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "CATEGORY_HAS_CHILDREN");
  storefront = await adminClient.request(`/catalog/categories/${marker}-root`);
  assert.equal(storefront.response.status, 200);
  assert.equal(storefront.body.data.products.items.some((item: { id: string }) => item.id === fixtureProduct), false);
  result = await adminClient.request(`/admin/categories/${fixtureRoot}/archive`, { method: "POST", body: JSON.stringify({ active: false }) });
  assert.equal(result.response.status, 204);
  assert.equal((await adminClient.request(`/catalog/categories/${marker}-root`)).response.status, 404);
  assert.equal((await adminClient.request(`/catalog/products/${marker}-product`)).response.status, 404);
  assert.equal((await adminClient.request(`/catalog/products/${marker}-product/quote?quantity=1`)).response.status, 404);
  assert.equal((await adminClient.request(`/pricing/quote?productId=${fixtureProduct}&quantity=1`)).response.status, 404);
  assert.equal((await adminClient.request("/shop/products")).body.data.items.some((item: { productId: string }) => item.productId === fixtureProduct), false);
  // A descendant parent assignment is rejected before the database write.
  result = await adminClient.request(`/admin/categories/${fixtureRoot}`, {
    method: "PATCH",
    body: JSON.stringify({ name: `${marker} Root`, slug: `${marker}-root`, canonicalKey: `${marker}.root`, parentId: fixtureChild, description: null, imageUrl: null, sortOrder: 999, active: false }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "CATEGORY_CYCLE");
  result = await adminClient.request(`/admin/catalog/supplier-category-mappings/${secondMapping.rows[0]!.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "mapped", rootCategoryId: fixtureRoot, childCategoryId: fixtureChild }),
  });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error.code, /MAPPING_(ROOT|CHILD)_INACTIVE/);
  result = await adminClient.request(`/admin/catalog/supplier-category-mappings/${mapping.rows[0]!.id}`, { method: "PATCH", body: JSON.stringify({ status: "mapped", rootCategoryId: root, childCategoryId: child }) });
  assert.equal(result.response.status, 200);
  result = await adminClient.request(`/admin/catalog/supplier-category-mappings/${mapping.rows[0]!.id}`, { method: "PATCH", body: JSON.stringify({ publicationEnabled: true }) });
  assert.equal(result.response.status, 400);
  await pool.query("UPDATE suppliers SET active=true, publication_enabled=true WHERE id=$1", [supplier.rows[0]!.id]);
  result = await adminClient.request(`/admin/catalog/supplier-category-mappings/${mapping.rows[0]!.id}`, {
    method: "PATCH",
    body: JSON.stringify({ publicationEnabled: true, complianceExcluded: false }),
  });
  assert.equal(result.response.status, 200);
  result = await adminClient.request("/admin/catalog/supplier-category-mappings/bulk", {
    method: "POST",
    body: JSON.stringify({ ids: [mapping.rows[0]!.id, mapping.rows[0]!.id, secondMapping.rows[0]!.id], status: "needs_review", publicationEnabled: false, reason: "bulk regression" }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.updated, 2);
  const history = await pool.query("SELECT count(*) AS count FROM supplier_category_mapping_history WHERE mapping_id=$1", [mapping.rows[0]!.id]);
  assert.ok(Number(history.rows[0].count) >= 1);
  const bulkHistory = await pool.query("SELECT count(*) AS count FROM supplier_category_mapping_history WHERE mapping_id=$1 AND bulk_operation_id IS NOT NULL", [secondMapping.rows[0]!.id]);
  assert.equal(Number(bulkHistory.rows[0].count), 1);
  // The isolated storefront fixture is the only product created by this
  // regression; mapping operations must not import any additional products.
  assert.equal(Number((await pool.query("SELECT count(*) AS count FROM products")).rows[0].count), productBefore + 1);
  console.log("Taxonomy and supplier mapping regression passed.");
  } finally {
    const bestEffort = async (query: string, values: unknown[] = []) => {
      await pool.query(query, values).catch(() => undefined);
    };
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve())).catch(() => undefined);
    if (userIds.length) {
      await bestEffort("DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])", [userIds]);
      await bestEffort("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[]) OR actor_admin_id=ANY($1::uuid[]) OR entity_id=ANY($1::uuid[])", [userIds]);
    }
    if (mappingIds.length) {
      await bestEffort("DELETE FROM supplier_category_mapping_history WHERE mapping_id=ANY($1::uuid[])", [mappingIds]);
      await bestEffort("DELETE FROM supplier_category_mappings WHERE id=ANY($1::uuid[])", [mappingIds]);
    }
    if (supplierIds.length) await bestEffort("DELETE FROM suppliers WHERE id=ANY($1::uuid[])", [supplierIds]);
    if (userIds.length) await bestEffort("DELETE FROM admin_user_roles WHERE user_id=ANY($1::uuid[])", [userIds]);
    if (roleIds.length) await bestEffort("DELETE FROM admin_role_permissions WHERE role_id=ANY($1::uuid[])", [roleIds]);
    if (userIds.length) await bestEffort("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    if (roleIds.length) await bestEffort("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [roleIds]);
    if (productIds.length) await bestEffort("DELETE FROM products WHERE id=ANY($1::uuid[])", [productIds]);
    if (categoryIds.length) await bestEffort("DELETE FROM categories WHERE id=ANY($1::uuid[])", [categoryIds]);
    await closeDatabase().catch(() => undefined);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});