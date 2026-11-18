import assert from "node:assert/strict";
import type { Server } from "node:http";
import ExcelJS from "exceljs";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { runMediaCleanup } from "./media-cleanup.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `phase4b-${suffix}`;
const password = "SecureCatalogPassword1";
const adminEmail = `${marker}-admin@example.test`;
const limitedEmail = `${marker}-limited@example.test`;
const customerEmail = `${marker}-customer@example.test`;

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
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = getSetCookie ? getSetCookie.call(response.headers) : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = response.status === 204 ? null : contentType.includes("application/json") ? await response.json() : await response.text();
    return { response, body };
  }
}

async function setupAccounts() {
  const pool = getDatabasePool();
  const permissionKeys = [
    "products.view", "products.create", "products.edit", "products.archive", "products.delete", "products.import", "products.export",
    "categories.view", "categories.create", "categories.edit", "brands.view", "brands.create", "brands.edit", "product_cost.view",
  ];
  const passwordHash = await hashPassword(password);
  const adminRole = await pool.query<{ id: string }>("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`Catalog Admin ${suffix}`]);
  const limitedRole = await pool.query<{ id: string }>("INSERT INTO admin_roles (name) VALUES ($1) RETURNING id", [`Catalog Limited ${suffix}`]);
  const admin = await pool.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, first_name, last_name, status, email_verified_at) VALUES ($1, $2, 'Catalog', 'Admin', 'active', now()) RETURNING id",
    [adminEmail, passwordHash],
  );
  const limited = await pool.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, first_name, last_name, status, email_verified_at) VALUES ($1, $2, 'Catalog', 'Limited', 'active', now()) RETURNING id",
    [limitedEmail, passwordHash],
  );
  const customer = await pool.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, first_name, last_name, status, email_verified_at) VALUES ($1, $2, 'Catalog', 'Customer', 'active', now()) RETURNING id",
    [customerEmail, passwordHash],
  );
  await pool.query("INSERT INTO admin_user_roles (user_id, role_id) VALUES ($1, $2), ($3, $4)", [admin.rows[0]!.id, adminRole.rows[0]!.id, limited.rows[0]!.id, limitedRole.rows[0]!.id]);
  await pool.query(
    `INSERT INTO admin_role_permissions (role_id, permission_id)
     SELECT $1, id FROM admin_permissions WHERE permission_key = ANY($2::text[])`,
    [adminRole.rows[0]!.id, permissionKeys],
  );
  await pool.query(
    `INSERT INTO admin_role_permissions (role_id, permission_id)
     SELECT $1, id FROM admin_permissions WHERE permission_key = ANY($2::text[])`,
    [limitedRole.rows[0]!.id, ["products.view", "products.import"]],
  );
}

async function login(client: Client, email: string, admin = true): Promise<void> {
  await client.request("/auth/me");
  const result = await client.request(admin ? "/auth/admin/login" : "/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  assert.equal(result.response.status, 200);
}

function categoryPayload(name: string, parentId: string | null = null) {
  return { name, slug: `${marker}-${name.toLowerCase()}`, parentId, description: `${name} test category`, imageUrl: null, sortOrder: 0, active: true };
}

function productPayload(categoryId: string, brandId: string, parentSku = `${marker}-parent`) {
  return {
    name: `Catalog Product ${suffix}`,
    slug: `${marker}-product`,
    parentSku,
    barcode: `${marker}-barcode`,
    brandId,
    categoryId,
    shortDescription: "Temporary integration product",
    description: "Temporary product created only for automated verification.",
    status: "draft",
    costPrice: 10,
    basePrice: 20,
    vatRate: 19,
    weight: 1,
    width: 2,
    height: 3,
    length: 4,
    featured: false,
    newArrival: false,
    homepageWholesale: false,
    options: [{ name: "Color", values: ["Black", "White"] }, { name: "Size", values: ["M", "L"] }],
    variants: [
      ["Black", "M"], ["Black", "L"], ["White", "M"], ["White", "L"],
    ].map(([color, size]) => ({
      sku: `${parentSku}-${color}-${size}`,
      barcode: null,
      title: `${color} / ${size}`,
      costPrice: null,
      basePrice: null,
      weight: null,
      active: true,
      optionValues: [{ attribute: "Color", value: color }, { attribute: "Size", value: size }],
    })),
  };
}

async function run(): Promise<void> {
  await setupAccounts();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = new Client(baseUrl);
  const limited = new Client(baseUrl);
  const customer = new Client(baseUrl);
  let productId = "";
  let mediaId = "";
  let blockedDeleteOrderId = "";
  let createdVariants: Array<Record<string, unknown>> = [];

  try {
    await login(admin, adminEmail);
    await login(limited, limitedEmail);
    await login(customer, customerEmail, false);
    assert.equal((await customer.request("/admin/products")).response.status, 403);
    assert.equal((await limited.request("/admin/products")).response.status, 200);

    let result = await admin.request("/admin/categories", { method: "POST", body: JSON.stringify(categoryPayload("Root")) });
    assert.equal(result.response.status, 201);
    const rootId = result.body.data.id as string;
    result = await admin.request("/admin/categories", { method: "POST", body: JSON.stringify(categoryPayload("Child", rootId)) });
    assert.equal(result.response.status, 201);
    const childId = result.body.data.id as string;
    result = await admin.request(`/admin/categories/${rootId}`, { method: "PATCH", body: JSON.stringify(categoryPayload("Root", childId)) });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, "CATEGORY_CYCLE");
    result = await admin.request("/admin/categories", { method: "POST", body: JSON.stringify(categoryPayload("Empty")) });
    assert.equal(result.response.status, 201);
    const emptyCategoryId = result.body.data.id as string;
    assert.equal((await limited.request(`/admin/categories/${emptyCategoryId}`, { method: "DELETE", body: "{}" })).response.status, 403);
    result = await admin.request(`/admin/categories/${emptyCategoryId}`, { method: "DELETE", body: "{}" });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.productCount, 0);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM categories WHERE id=$1", [emptyCategoryId])).rows[0].count), 0);

    const brandPayload = { name: `Brand ${suffix}`, slug: `${marker}-brand`, logoUrl: null, description: "Temporary test brand", active: true };
    result = await admin.request("/admin/brands", { method: "POST", body: JSON.stringify(brandPayload) });
    assert.equal(result.response.status, 201);
    const brandId = result.body.data.id as string;

    result = await limited.request("/admin/products", { method: "POST", body: JSON.stringify(productPayload(childId, brandId)) });
    assert.equal(result.response.status, 403);
    result = await admin.request("/admin/products", { method: "POST", body: JSON.stringify(productPayload(childId, brandId)) });
    assert.equal(result.response.status, 201);
    productId = result.body.data.id;
    assert.equal(result.body.data.variants.length, 4);
    assert.equal(result.body.data.costPrice, 10);
    assert.equal(result.body.data.homepageWholesale, false);
    createdVariants = result.body.data.variants;
    assert.equal((await limited.request(`/admin/products/${productId}/archive`, { method: "POST", body: JSON.stringify({ restore: false }) })).response.status, 403);

    result = await admin.request(`/admin/products?status=all&search=${encodeURIComponent(`${marker}-parent-Black-M`)}&page=1&pageSize=1`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.items.length, 1);
    assert.equal(result.body.data.items[0].id, productId);
    assert.equal(typeof result.body.data.meta.total, "number");

    const duplicate = productPayload(childId, brandId, `${marker}-duplicate`);
    duplicate.slug = `${marker}-duplicate`;
    duplicate.barcode = `${marker}-duplicate-barcode`;
    duplicate.variants[0]!.sku = `${marker}-parent-Black-M`;
    result = await admin.request("/admin/products", { method: "POST", body: JSON.stringify(duplicate) });
    assert.equal(result.response.status, 409);

    const updatedPayload = productPayload(childId, brandId);
    updatedPayload.name = `Updated Catalog Product ${suffix}`;
    updatedPayload.status = "active";
    updatedPayload.homepageWholesale = true;
    updatedPayload.variants = createdVariants as typeof updatedPayload.variants;
    result = await admin.request(`/admin/products/${productId}`, { method: "PATCH", body: JSON.stringify(updatedPayload) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.name, updatedPayload.name);
    assert.equal(result.body.data.homepageWholesale, true);
    assert.equal((await getDatabasePool().query<{ homepage_wholesale: boolean }>("SELECT homepage_wholesale FROM products WHERE id=$1", [productId])).rows[0]?.homepage_wholesale, true);
    result = await admin.request(`/admin/products/${productId}`, { method: "PATCH", body: JSON.stringify({ ...updatedPayload, homepageWholesale: false }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.homepageWholesale, false);
    assert.equal((await getDatabasePool().query<{ homepage_wholesale: boolean }>("SELECT homepage_wholesale FROM products WHERE id=$1", [productId])).rows[0]?.homepage_wholesale, false);
    result = await admin.request(`/admin/products/${productId}`, { method: "PATCH", body: JSON.stringify({ ...updatedPayload, status: "archived" }) });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, "ARCHIVE_ENDPOINT_REQUIRED");

    result = await admin.request("/admin/products/bulk", { method: "POST", body: JSON.stringify({ ids: [productId], action: "feature" }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.updated, 1);
    result = await admin.request(`/catalog/products?search=${encodeURIComponent(updatedPayload.parentSku)}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.items.some((item: { id: string }) => item.id === productId), true);

    result = await admin.request(`/admin/products/${productId}/lifecycle`, { method: "POST", body: JSON.stringify({ status: "inactive" }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.status, "inactive");
    assert.equal((await limited.request(`/admin/products/${productId}/lifecycle`, { method: "POST", body: JSON.stringify({ status: "active" }) })).response.status, 403);
    result = await admin.request(`/admin/products?search=${encodeURIComponent(updatedPayload.parentSku)}`);
    assert.equal(result.body.data.items.some((item: { id: string }) => item.id === productId), false);
    result = await admin.request(`/admin/products?status=inactive&search=${encodeURIComponent(updatedPayload.parentSku)}`);
    assert.equal(result.body.data.items.some((item: { id: string }) => item.id === productId), true);
    result = await admin.request(`/admin/products?status=all&search=${encodeURIComponent(updatedPayload.parentSku)}`);
    assert.equal(result.body.data.items.some((item: { id: string }) => item.id === productId), true);
    result = await admin.request(`/catalog/products?search=${encodeURIComponent(updatedPayload.parentSku)}`);
    assert.equal(result.body.data.items.some((item: { id: string }) => item.id === productId), false);
    result = await admin.request(`/admin/products/${productId}/lifecycle`, { method: "POST", body: JSON.stringify({ status: "active" }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.status, "active");

    result = await admin.request(`/admin/products/${productId}/archive`, { method: "POST", body: JSON.stringify({ restore: false }) });
    assert.equal(result.body.data.status, "archived");
    result = await admin.request(`/admin/products/${productId}/lifecycle`, { method: "POST", body: JSON.stringify({ status: "active" }) });
    assert.equal(result.response.status, 409);
    result = await admin.request(`/catalog/products?search=${encodeURIComponent(updatedPayload.parentSku)}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.items.some((item: { id: string }) => item.id === productId), false);
    assert.equal((await getDatabasePool().query("SELECT status FROM products WHERE id=$1", [productId])).rows[0].status, "archived");
    result = await admin.request(`/admin/products/${productId}/archive`, { method: "POST", body: JSON.stringify({ restore: true }) });
    assert.equal(result.body.data.status, "active");

    const deletablePayload = productPayload(childId, brandId, `${marker}-deletable`);
    deletablePayload.name = `Deletable Product ${suffix}`;
    deletablePayload.slug = `${marker}-deletable`;
    deletablePayload.barcode = `${marker}-deletable-barcode`;
    deletablePayload.variants = deletablePayload.variants.map((variant, index) => ({
      ...variant,
      sku: `${marker}-deletable-${index}`,
    }));
    result = await admin.request("/admin/products", { method: "POST", body: JSON.stringify(deletablePayload) });
    assert.equal(result.response.status, 201);
    const deletableProductId = result.body.data.id as string;
    const deletableVariantId = result.body.data.variants[0].id as string;
    const warehouse = await getDatabasePool().query<{ id: string }>(
      "INSERT INTO warehouses (name, code, country_code, active) VALUES ($1,$2,'CY',true) RETURNING id",
      [`Delete test ${suffix}`, `DEL-${suffix}`.slice(0, 50)],
    );
    await getDatabasePool().query(
      `INSERT INTO inventory (warehouse_id, product_id, quantity_on_hand, quantity_reserved, low_stock_threshold)
       VALUES ($1,$2,5,0,0)`,
      [warehouse.rows[0]!.id, deletableProductId],
    );
    await getDatabasePool().query(
      "INSERT INTO price_tiers (product_id, min_quantity, max_quantity, unit_price, active) VALUES ($1,5,NULL,15,true)",
      [deletableProductId],
    );
    await getDatabasePool().query(
      "INSERT INTO price_tiers (variant_id, min_quantity, max_quantity, unit_price, active) VALUES ($1,10,NULL,14,true)",
      [deletableVariantId],
    );
    await getDatabasePool().query(
      "INSERT INTO product_media (product_id, type, url, alt_text, is_primary, sort_order) VALUES ($1,'image',$2,'Delete test',true,0)",
      [deletableProductId, `/catalog-media/${marker}-delete.png`],
    );
    await getDatabasePool().query("UPDATE categories SET image_url=$1 WHERE id=$2", [`/catalog-media/${marker}-delete.png`, childId]);
    await admin.request(`/admin/products/${deletableProductId}/archive`, { method: "POST", body: JSON.stringify({ restore: false }) });
    result = await admin.request(`/admin/products/${deletableProductId}/deletion-eligibility`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.eligible, true);
    assert.equal(result.body.data.removable.variants, 4);
    assert.equal(result.body.data.removable.media, 1);
    assert.ok(result.body.data.removable.priceTiers >= 1);
    assert.equal(result.body.data.removable.inventoryRecords, 1);
    assert.equal((await limited.request(`/admin/products/${deletableProductId}/deletion-eligibility`)).response.status, 403);
    result = await admin.request(`/admin/products/${deletableProductId}`, { method: "DELETE", body: JSON.stringify({ confirmationName: "wrong name" }) });
    assert.equal(result.response.status, 400);
    result = await admin.request(`/admin/products/${deletableProductId}`, { method: "DELETE", body: JSON.stringify({ confirmationName: deletablePayload.name }) });
    assert.equal(result.response.status, 200);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM products WHERE id=$1", [deletableProductId])).rows[0].count), 0);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM product_variants WHERE product_id=$1", [deletableProductId])).rows[0].count), 0);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM product_media WHERE product_id=$1", [deletableProductId])).rows[0].count), 0);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM price_tiers WHERE product_id=$1 OR variant_id=$2", [deletableProductId, deletableVariantId])).rows[0].count), 0);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM inventory WHERE product_id=$1 OR variant_id=$2", [deletableProductId, deletableVariantId])).rows[0].count), 0);
    await runMediaCleanup(100);
    assert.equal(
      (await getDatabasePool().query<{ status: string }>("SELECT status FROM media_cleanup_jobs WHERE url=$1", [`/catalog-media/${marker}-delete.png`])).rows[0]?.status,
      "completed",
      "shared managed media must be retained while a category still references it",
    );

    const blockedPayload = productPayload(childId, brandId, `${marker}-blocked-delete`);
    blockedPayload.name = `Historical Product ${suffix}`;
    blockedPayload.slug = `${marker}-blocked-delete`;
    blockedPayload.barcode = `${marker}-blocked-delete-barcode`;
    blockedPayload.variants = [];
    blockedPayload.options = [];
    result = await admin.request("/admin/products", { method: "POST", body: JSON.stringify(blockedPayload) });
    assert.equal(result.response.status, 201);
    const blockedProductId = result.body.data.id as string;
    const order = await getDatabasePool().query<{ id: string }>(
      `INSERT INTO orders (
         order_number, guest_email, status, payment_status, fulfillment_status, currency,
         subtotal, discount_total, shipping_total, tax_total, grand_total,
         billing_address_snapshot, shipping_address_snapshot
       ) VALUES ($1,$2,'pending','pending','unfulfilled','EUR',20,0,0,0,20,'{}'::jsonb,'{}'::jsonb)
       RETURNING id`,
      [`DEL-${suffix}`.slice(0, 40), `${marker}@example.test`],
    );
    blockedDeleteOrderId = order.rows[0]!.id;
    await getDatabasePool().query(
      `INSERT INTO order_items (
         order_id, product_id, sku_snapshot, product_name_snapshot, quantity,
         unit_price, cost_price_snapshot, tax_rate_snapshot, line_total
       ) VALUES ($1,$2,$3,$4,1,20,10,19,20)`,
      [blockedDeleteOrderId, blockedProductId, blockedPayload.parentSku, blockedPayload.name],
    );
    await admin.request(`/admin/products/${blockedProductId}/archive`, { method: "POST", body: JSON.stringify({ restore: false }) });
    result = await admin.request(`/admin/products/${blockedProductId}/deletion-eligibility`);
    assert.equal(result.body.data.eligible, false);
    assert.equal(result.body.data.blockers.orderItems, 1);
    result = await admin.request(`/admin/products/${blockedProductId}`, { method: "DELETE", body: JSON.stringify({ confirmationName: blockedPayload.name }) });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error.code, "PRODUCT_DELETE_BLOCKED");
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM products WHERE id=$1", [blockedProductId])).rows[0].count), 1);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM order_items WHERE product_id=$1", [blockedProductId])).rows[0].count), 1);

    const promotionPayload = productPayload(childId, brandId, `${marker}-promotion-delete`);
    promotionPayload.name = `Promotion History Product ${suffix}`;
    promotionPayload.slug = `${marker}-promotion-delete`;
    promotionPayload.barcode = `${marker}-promotion-delete-barcode`;
    promotionPayload.options = [];
    promotionPayload.variants = [];
    result = await admin.request("/admin/products", { method: "POST", body: JSON.stringify(promotionPayload) });
    assert.equal(result.response.status, 201);
    const promotionProductId = result.body.data.id as string;
    const campaign = await getDatabasePool().query<{ id: string }>(
      `INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,active)
       VALUES ($1,now()-interval '1 minute','product','percentage',5,true,true) RETURNING id`,
      [`${marker} deletion campaign`],
    );
    await getDatabasePool().query("INSERT INTO promotion_products (campaign_id,product_id) VALUES ($1,$2)", [campaign.rows[0]!.id, promotionProductId]);
    await getDatabasePool().query(
      "INSERT INTO promotion_usages (campaign_id,order_id,guest_session_id,discount_amount) VALUES ($1,$2,$3,1)",
      [campaign.rows[0]!.id, blockedDeleteOrderId, `${marker}-promotion-guest`],
    );
    await admin.request(`/admin/products/${promotionProductId}/archive`, { method: "POST", body: JSON.stringify({ restore: false }) });
    result = await admin.request(`/admin/products/${promotionProductId}/deletion-eligibility`);
    assert.equal(result.body.data.eligible, false);
    assert.equal(result.body.data.blockers.promotionUsages, 1);
    result = await admin.request(`/admin/products/${promotionProductId}`, { method: "DELETE", body: JSON.stringify({ confirmationName: promotionPayload.name }) });
    assert.equal(result.response.status, 409);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM promotion_products WHERE product_id=$1", [promotionProductId])).rows[0].count), 1);

    const badMedia = new FormData();
    badMedia.append("file", new Blob(["not-an-image"], { type: "image/png" }), "bad.png");
    result = await admin.request(`/admin/products/${productId}/media`, { method: "POST", body: badMedia });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, "MEDIA_CONTENT_INVALID");

    const validMedia = new FormData();
    validMedia.append("file", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: "image/png" }), "valid.png");
    validMedia.append("altText", "Temporary test image");
    validMedia.append("isPrimary", "true");
    result = await admin.request(`/admin/products/${productId}/media`, { method: "POST", body: validMedia });
    assert.equal(result.response.status, 201);
    mediaId = result.body.data.id;
    assert.match(result.body.data.url, /^\/catalog-media\//);
    assert.equal((await admin.request(`/admin/media/${mediaId}`, { method: "DELETE" })).response.status, 204);
    mediaId = "";

    result = await admin.request(`/admin/products/export?ids=${productId}`);
    assert.equal(result.response.status, 200);
    assert.match(result.body as string, /cost_price/);
    assert.match(result.body as string, new RegExp(`${marker}-parent`));

    const invalidCsv = new FormData();
    invalidCsv.append("file", new Blob(["product_name,parent_sku,category,cost_price,base_price,vat_rate,weight\nMissing SKU,,Unknown,1,2,19,1\n"], { type: "text/csv" }), "invalid.csv");
    result = await admin.request("/admin/products/import/preview", { method: "POST", body: invalidCsv });
    assert.equal(result.response.status, 202);
    assert.ok(result.body.data.errors.length > 0);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Products");
    worksheet.addRow(["product_name", "slug", "parent_sku", "brand", "category", "description", "cost_price", "base_price", "vat_rate", "weight", "status"]);
    worksheet.addRow(["XLSX Preview Product", `${marker}-xlsx-preview`, `${marker}-xlsx-preview`, brandPayload.name, "Child", "Validated XLSX preview", 5, 12, 19, 1, "draft"]);
    const xlsxPreview = new FormData();
    xlsxPreview.append("file", new Blob([Buffer.from(await workbook.xlsx.writeBuffer())], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "preview.xlsx");
    result = await admin.request("/admin/products/import/preview", { method: "POST", body: xlsxPreview });
    assert.equal(result.response.status, 202);
    assert.equal(result.body.data.errors.length, 0);

    const importSku = `${marker}-imported`;
    const validCsv = new FormData();
    validCsv.append("file", new Blob([
      `product_name,slug,parent_sku,brand,category,description,cost_price,base_price,vat_rate,weight,status,variant_sku,variant_title,option_color\n` +
      `Imported Product,${marker}-imported,${importSku},${brandPayload.name},Child,Imported from validation,5,12,19,1,draft,${importSku}-BLACK,Black,Black\n`,
    ], { type: "text/csv" }), "valid.csv");
    result = await admin.request("/admin/products/import/preview", { method: "POST", body: validCsv });
    assert.equal(result.response.status, 202);
    assert.equal(result.body.data.errors.length, 0);
    assert.equal(result.body.data.unresolvedBrands.length, 0);
    assert.equal(result.body.data.unresolvedCategories.length, 0);
    result = await admin.request("/admin/products/import/commit", { method: "POST", body: JSON.stringify({ previewId: result.body.data.previewId, resolution: { brands: {}, categories: {} } }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.imported, 1);

    result = await admin.request(`/admin/products?status=all&search=${encodeURIComponent(importSku)}&page=1&pageSize=25`);
    assert.equal(result.body.data.meta.total, 1);
    assert.equal(result.body.data.items[0].parentSku, importSku);

    const limitedSku = `${marker}-limited-import`;
    const limitedCsv = new FormData();
    limitedCsv.append("file", new Blob([
      `product_name,slug,parent_sku,brand,category,description,cost_price,base_price,vat_rate,weight,status,variant_sku,variant_title,variant_cost_price\n` +
      `Limited Import,${marker}-limited-import,${limitedSku},${brandPayload.name},Child,No cost access,999,12,19,1,draft,${limitedSku}-ONE,One,777\n`,
    ], { type: "text/csv" }), "limited.csv");
    result = await limited.request("/admin/products/import/preview", { method: "POST", body: limitedCsv });
    assert.equal(result.response.status, 202);
    result = await limited.request("/admin/products/import/commit", { method: "POST", body: JSON.stringify({ previewId: result.body.data.previewId, resolution: { brands: {}, categories: {} } }) });
    assert.equal(result.response.status, 200);
    const hiddenCosts = await getDatabasePool().query<{ cost_price: string; variant_cost: string | null }>(
      "SELECT p.cost_price::text, pv.cost_price::text AS variant_cost FROM products p LEFT JOIN product_variants pv ON pv.product_id = p.id WHERE p.parent_sku = $1 LIMIT 1",
      [limitedSku],
    );
    assert.equal(hiddenCosts.rows[0]?.cost_price, "0.00");
    assert.equal(hiddenCosts.rows[0]?.variant_cost, null);

    result = await admin.request("/admin/categories", { method: "POST", body: JSON.stringify({ ...categoryPayload("Child", rootId), slug: `${marker}-child-duplicate` }) });
    assert.equal(result.response.status, 201);
    const ambiguousCsv = new FormData();
    ambiguousCsv.append("file", new Blob([
      `product_name,slug,parent_sku,brand,category,description,cost_price,base_price,vat_rate,weight,status\n` +
      `Ambiguous Category,${marker}-ambiguous,${marker}-ambiguous,${brandPayload.name},Child,Must be mapped,1,2,19,1,draft\n`,
    ], { type: "text/csv" }), "ambiguous.csv");
    result = await admin.request("/admin/products/import/preview", { method: "POST", body: ambiguousCsv });
    assert.equal(result.response.status, 202);
    assert.deepEqual(result.body.data.unresolvedCategories, ["child"]);

    result = await admin.request(`/admin/categories/${childId}`, { method: "DELETE", body: "{}" });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error.code, "CATEGORY_HAS_PRODUCTS");
    result = await admin.request("/admin/categories", { method: "POST", body: JSON.stringify(categoryPayload("Destination")) });
    assert.equal(result.response.status, 201);
    const destinationId = result.body.data.id as string;
    result = await admin.request(`/admin/categories/${childId}`, { method: "DELETE", body: JSON.stringify({ reassignToCategoryId: destinationId }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.reassignedToCategoryId, destinationId);
    assert.ok(result.body.data.productCount > 0);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM products WHERE category_id=$1", [childId])).rows[0].count), 0);
    assert.equal(Number((await getDatabasePool().query("SELECT count(*) AS count FROM products WHERE category_id=$1", [destinationId])).rows[0].count), result.body.data.productCount);
    const auditActions = await getDatabasePool().query<{ action: string; oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> | null }>(
      `SELECT action, old_values_json AS "oldValues", new_values_json AS "newValues"
         FROM audit_logs
        WHERE actor_user_id=(SELECT id FROM users WHERE email=$1)
          AND action IN ('catalog.product_archived','catalog.category_deleted','catalog.category_reassigned_deleted')`,
      [adminEmail],
    );
    assert.ok(auditActions.rows.some((row) => row.action === "catalog.product_archived" && row.oldValues?.sku === updatedPayload.parentSku));
    assert.ok(auditActions.rows.some((row) => row.action === "catalog.category_deleted" && row.oldValues?.name === "Empty"));
    assert.ok(auditActions.rows.some((row) => row.action === "catalog.category_reassigned_deleted" && row.newValues?.reassignedToCategoryId === destinationId));

    console.info("Phase 4B catalog integration checks passed.");
  } finally {
    const pool = getDatabasePool();
    if (mediaId) await admin.request(`/admin/media/${mediaId}`, { method: "DELETE" }).catch(() => undefined);
    const userRows = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = ANY($1::text[])", [[adminEmail, limitedEmail, customerEmail]]);
    const userIds = userRows.rows.map((row) => row.id);
    if (userIds.length) await pool.query("DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])", [userIds]);
    if (blockedDeleteOrderId) await pool.query("DELETE FROM orders WHERE id=$1", [blockedDeleteOrderId]);
    await pool.query("DELETE FROM products WHERE parent_sku LIKE $1", [`${marker}%`]);
    await pool.query("DELETE FROM categories WHERE slug LIKE $1", [`${marker}%`]);
    await pool.query("DELETE FROM brands WHERE slug LIKE $1", [`${marker}%`]);
    await pool.query("DELETE FROM media_cleanup_jobs WHERE url LIKE $1", [`%${marker}%`]);
    await pool.query("DELETE FROM users WHERE email = ANY($1::text[])", [[adminEmail, limitedEmail, customerEmail]]);
    await pool.query("DELETE FROM admin_roles WHERE name = ANY($1::text[])", [[`Catalog Admin ${suffix}`, `Catalog Limited ${suffix}`]]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeDatabase();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});