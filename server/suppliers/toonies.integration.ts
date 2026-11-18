/**
 * Phase 2 supplier integration regression suite.
 *
 * This suite is intentionally migration-dependent and refuses to run against
 * production/deployment databases. It is not included in the migration-free
 * test command; run it after migration 0066 has been reviewed and applied.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";
import {
  TooniesClient,
  TooniesError,
  TooniesFixtureTransport,
  signTooniesRequest,
} from "./toonies.js";
import {
  reconcileLinkedCatalogueItem,
  normalizeTooniesPrimaryMedia,
  resumeTooniesSync,
  setTooniesClient,
  syncTooniesSearch,
  testDistributedTooniesDetailGate,
} from "./toonies-service.js";
import { setFxClock, setFxProvider } from "../fx/service.js";
import { saveProduct } from "../catalog/service.js";
import { reconcileStaleTooniesSyncRuns } from "./toonies-reference-reconciliation.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `toonies-db-${suffix}`;
const taskId = `T${Date.now()}`;
const password = "TooniesIntegrationPassword1";
const fxNow = new Date();
const fxObservedAt = new Date(fxNow.getTime() - 24 * 60 * 60 * 1000);

class Client {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}

  async request(path: string, init: RequestInit = {}, csrf = true) {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (csrf && init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
      const token = this.cookies.get("lizzor_csrf");
      if (token) headers.set("x-csrf-token", decodeURIComponent(token));
    }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = response.status === 204 ? null : contentType.includes("json") ? await response.json() : await response.text();
    return { response, body };
  }
}

async function run(): Promise<void> {
  assertMutableIntegrationTestDatabase("Toonies supplier DB integration");
  const pool = getDatabasePool();
  const fixture = new TooniesFixtureTransport({
    "/v1/product/search": {
      status: true,
      code: 200,
      msg: "ok",
      data: { items: [{ product_code: `${marker}-product` }], total: 1, total_page: 1, page: 1, page_size: 20, currency: "CNY" },
    },
    "/v1/product/detail": {
      status: true,
      code: 200,
      msg: "ok",
      data: {
        product_code: `${marker}-product`,
        title: `${marker} product`,
        title_trans: `${marker} translated product`,
        category_id: `${marker}-category`,
        currency: "CNY",
        charge: "12.000000000001",
        images: ["https://cdn.example.test/toonies-product-1.jpg", "https://cdn.example.test/toonies-product-2.jpg", "https://cdn.example.test/toonies-product-3.jpg", "https://cdn.example.test/toonies-product-4.jpg"],
        desc_images: Array.from({ length: 14 }, (_, index) => `https://cdn.example.test/toonies-description-${index + 1}.jpg`),
        moq: 2,
        spec_list: [{ name: "规格", name_trans: "Specifications", options: [{ value: "塑料手柄", value_trans: "plastic handle" }] }],
        skus: [{
          sku_code: `${marker}-sku`,
          spec_desc: "Specifications:plastic handle",
          sku_attr: [{ name: "规格", name_trans: "Specifications", value: "塑料手柄", value_trans: "plastic handle" }],
          charge: "12.000000000001",
          stock: 4,
          weight: 0.25,
          image: "",
        }],
      },
    },
    "/v1/order/precheck": {
      status: true,
      code: 200,
      msg: "ok",
      data: { task_id: taskId, client_task_no: `${marker}-client`, status: "pending", item_count: 1, duplicated: false, next_step: "task" },
    },
    "/v1/order/task": [
      {
        status: true,
        code: 200,
        msg: "ok",
        data: {
          task_id: taskId, client_task_no: `${marker}-client`, status: "ready", expired: false,
          item_count: 1, ok_count: 1, product_sum: 12, currency: "CNY", rate: null, rate_currency: null,
          weight_missing: false, items: [{ product_code: `${marker}-product`, sku_code: `${marker}-sku`, num: 1, ok: true, charge: 12, stock: 4, moq: 1, weight: 0.25 }],
          date_expire: Math.floor(Date.now() / 1000) + 900, expire_in: 900,
        },
      },
    ],
  });
  let fxCalls = 0;
  const fixtureFxProvider = `ECB-Test-${marker}`;
  setFxClock(() => fxNow);
  setFxProvider({
    name: fixtureFxProvider,
    source: "ECB",
    series: "EXR.D.CNY.EUR.SP00.A",
    baseCurrency: "EUR",
    quoteCurrency: "CNY",
    fetchObservation: async () => {
      fxCalls += 1;
      return {
        provider: fixtureFxProvider,
        source: "ECB",
        series: "EXR.D.CNY.EUR.SP00.A",
        baseCurrency: "EUR",
        quoteCurrency: "CNY",
        rate: "8",
        observedAt: fxObservedAt,
        fetchedAt: fxNow,
        responseHash: "fixture",
      };
    },
  });
  const toonies = new TooniesClient({
    app_key: "fixture-key",
    app_secret: "fixture-secret",
    transport: fixture.request,
    now: () => 1_700_000_000,
    nonce: () => `${marker}-nonce`.slice(0, 32),
  });
  setTooniesClient(toonies);

  let server: Server | undefined;
  const categoryIds: string[] = [];
  const supplierIds: string[] = [];
  const catalogueIds: string[] = [];
  const variantIds: string[] = [];
  const productIds: string[] = [];
  const mappingIds: string[] = [];
  const shippingRuleIds: string[] = [];
  const userIds: string[] = [];
  const roleIds: string[] = [];
  let tooniesId = "";
  let businessSentinelId = "";
  try {
    const tooniesSupplier = (await pool.query<{ id: string }>("SELECT id FROM suppliers WHERE slug='toonies'")).rows[0];
    assert.ok(tooniesSupplier, "migration must create the Toonies supplier");
    tooniesId = tooniesSupplier.id;
    supplierIds.push(tooniesSupplier.id);
    const otherSupplier = (await pool.query<{ id: string }>("INSERT INTO suppliers(name,slug) VALUES($1,$2) RETURNING id", [`${marker} Other`, `${marker}-other`])).rows[0]!.id;
    supplierIds.push(otherSupplier);
    const category = (await pool.query<{ id: string }>("SELECT id FROM categories WHERE parent_id IS NULL AND active=true ORDER BY sort_order LIMIT 1")).rows[0]!.id;
    businessSentinelId = (await pool.query<{ id: string }>(
      "INSERT INTO products(name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status) VALUES('Business sentinel',$1,$2,$3,'Business sentinel',1,2,19,1,'draft') RETURNING id",
      [`business-sentinel-${suffix}`, `BUSINESS-SENTINEL-${suffix}`, category],
    )).rows[0]!.id;

    // Contract-level signer assertions use exact bytes and never expose the
    // lower-case secret in headers or fixture records.
    const raw = Buffer.from('{"b":2,"a":"é"}', "utf8");
    const signed = signTooniesRequest({ appKey: "key", appSecret: "secret", path: "/v1/product/search", timestamp: 1_700_000_000, nonce: "n", body: raw });
    assert.equal(signed["X-Signature"].length, 64);
    assert.equal(JSON.stringify(fixture.requests).includes("fixture-secret"), false);

    const app = await createApp({ serveFrontend: false });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const adminEmail = `${marker}-admin@example.test`;
    const viewerEmail = `${marker}-viewer@example.test`;
    const role = (await pool.query<{ id: string }>("INSERT INTO admin_roles(name) VALUES($1) RETURNING id", [`${marker} admin`])).rows[0]!.id;
    const viewerRole = (await pool.query<{ id: string }>("INSERT INTO admin_roles(name) VALUES($1) RETURNING id", [`${marker} viewer`])).rows[0]!.id;
    roleIds.push(role, viewerRole);
    const passwordHash = await hashPassword(password);
    const admin = (await pool.query<{ id: string }>("INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,'Toonies','Admin','active',now()) RETURNING id", [adminEmail, passwordHash])).rows[0]!.id;
    const viewer = (await pool.query<{ id: string }>("INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,'Toonies','Viewer','active',now()) RETURNING id", [viewerEmail, passwordHash])).rows[0]!.id;
    userIds.push(admin, viewer);
    await pool.query("INSERT INTO admin_user_roles(user_id,role_id) VALUES($1,$2),($3,$4)", [admin, role, viewer, viewerRole]);
    await pool.query("INSERT INTO admin_role_permissions(role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key=ANY($2::text[])", [role, ["analytics.view", "supplier_integrations.view", "supplier_integrations.manage", "supplier_integrations.import", "supplier_integrations.pricing", "supplier_integrations.sync", "supplier_shipping.view", "supplier_shipping.manage"]]);
    await pool.query("INSERT INTO admin_role_permissions(role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key='supplier_integrations.view'", [viewerRole]);
    const adminClient = new Client(baseUrl);
    const viewerClient = new Client(baseUrl);
    await adminClient.request("/auth/me");
    await viewerClient.request("/auth/me");
    assert.equal((await adminClient.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: adminEmail, password }) })).response.status, 200);
    assert.equal((await viewerClient.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: viewerEmail, password }) })).response.status, 200);
    assert.equal((await viewerClient.request("/admin/suppliers/toonies/overview")).response.status, 200);
    assert.equal((await viewerClient.request("/admin/suppliers/toonies/precheck", { method: "POST", body: "{}" })).response.status, 404);
    const pricingBefore = (await pool.query("SELECT id,name,rule_type,min_cost_eur,max_cost_eur,value,rounding_mode,priority,active,updated_at FROM supplier_pricing_rules WHERE supplier_id=$1 ORDER BY priority,id", [tooniesSupplier.id])).rows;
    const commercialBands = await adminClient.request("/admin/commercial-profit/pricing-bands");
    assert.equal(commercialBands.response.status, 200);
    assert.ok(Array.isArray(commercialBands.body.data));
    assert.ok(commercialBands.body.data.length > 0);
    assert.ok(commercialBands.body.data.every((rule: Record<string, unknown>) =>
      Object.keys(rule).sort().join(",") === "id,maxCostEur,minCostEur,name,priority,roundingMode,ruleType,value"));
    assert.equal((await viewerClient.request("/admin/commercial-profit/pricing-bands")).response.status, 403);
    const pricingAfter = (await pool.query("SELECT id,name,rule_type,min_cost_eur,max_cost_eur,value,rounding_mode,priority,active,updated_at FROM supplier_pricing_rules WHERE supplier_id=$1 ORDER BY priority,id", [tooniesSupplier.id])).rows;
    assert.deepEqual(pricingAfter, pricingBefore, "commercial profit band reads must not mutate production pricing rules");
    const overview = await adminClient.request("/admin/suppliers/toonies/overview", { method: "GET" });
    assert.equal(overview.response.status, 200);
    assert.equal(JSON.stringify(overview.body).includes("fixture-secret"), false);
    const catalogueSync = await adminClient.request("/admin/suppliers/toonies/catalogue/sync", { method: "POST", body: JSON.stringify({ keyword: marker }) });
    assert.equal(catalogueSync.response.status, 202, `catalogue sync failed: ${JSON.stringify(catalogueSync.body)}`);

    const catalogue = (await pool.query<{ id: string; title: string; category: string; originalAmount: string; normalizedEur: string; normalizedCurrency: string; fxSnapshotId: string; fxRateUsed: string; fxSource: string }>("SELECT id,title,external_category_id AS category,original_amount AS \"originalAmount\",normalized_eur AS \"normalizedEur\",normalized_currency AS \"normalizedCurrency\",fx_rate_snapshot_id AS \"fxSnapshotId\",fx_rate_used AS \"fxRateUsed\",fx_source AS \"fxSource\" FROM supplier_catalogue_items WHERE supplier_id=$1 AND external_product_id=$2", [tooniesSupplier.id, `${marker}-product`])).rows[0]!;
    assert.equal(catalogue.title, `${marker} translated product`);
    assert.ok(catalogue);
    catalogueIds.push(catalogue.id);
    assert.equal(catalogue.category, `${marker}-category`);
    assert.equal(catalogue.originalAmount, "12.000000000001");
    assert.equal(Number(catalogue.normalizedEur), 1.5);
    assert.equal(catalogue.normalizedCurrency, "EUR");
    assert.equal(Number(catalogue.fxRateUsed), 8);
    assert.equal(catalogue.fxSource, "ECB");
    const variant = (await pool.query<{ id: string; normalizedEur: string; fxSnapshotId: string }>("SELECT id,normalized_eur AS \"normalizedEur\",fx_rate_snapshot_id AS \"fxSnapshotId\" FROM supplier_catalogue_variants WHERE catalogue_item_id=$1", [catalogue.id])).rows[0]!;
    variantIds.push(variant.id);
    assert.equal(Number(variant.normalizedEur), 1.5);
    assert.equal(variant.fxSnapshotId, catalogue.fxSnapshotId);
    const mapping = (await pool.query<{ id: string }>("SELECT id FROM supplier_category_mappings WHERE supplier_id=$1 AND external_category_id=$2", [tooniesSupplier.id, `${marker}-category`])).rows[0]!;
    assert.ok(mapping);
    mappingIds.push(mapping.id);
    const sampleRows = await pool.query<{ id: string }>(
      `INSERT INTO supplier_catalogue_items
        (supplier_id,external_product_id,external_category_id,title,image_urls,original_amount,original_currency,stock)
       SELECT $1,$2 || value::text,$3,$4 || value::text,jsonb_build_array($5 || value::text),1,'CNY',1
         FROM generate_series(1,6) value
       RETURNING id`,
      [tooniesSupplier.id, `${marker}-sample-`, `${marker}-category`, `${marker} sample `, "https://example.test/sample-"],
    );
    catalogueIds.push(...sampleRows.rows.map((row) => row.id));
    const otherCategorySample = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_catalogue_items
        (supplier_id,external_product_id,external_category_id,title,original_amount,original_currency,stock)
       VALUES($1,$2,$3,$4,1,'CNY',1) RETURNING id`,
      [tooniesSupplier.id, `${marker}-wrong-category-sample`, `${marker}-other-category`, `${marker} wrong category`],
    )).rows[0]!.id;
    catalogueIds.push(otherCategorySample);
    const mappingResponse = await adminClient.request("/admin/suppliers/toonies/categories");
    assert.equal(mappingResponse.response.status, 200);
    const categoryPayload = (mappingResponse.body as any).data.items.find((row: any) => row.id === mapping.id);
    assert.equal(categoryPayload.externalCategoryName, null, "numeric placeholder names must not be presented as authoritative");
    assert.equal(categoryPayload.sampleProducts.length, 5, "category samples must remain bounded");
    assert.equal(categoryPayload.sampleProducts.every((sample: any) => sample.productCode.startsWith(`${marker}-sample-`)), true, "samples must belong to the exact external category");
    assert.equal(categoryPayload.sampleProducts.some((sample: any) => sample.productCode === `${marker}-wrong-category-sample`), false);

    // Mapping PATCH is Toonies-scoped and cannot mutate another supplier.
     const otherMapping = (await pool.query<{ id: string }>("INSERT INTO supplier_category_mappings(supplier_id,external_category_id,external_category_name) VALUES($1,$2,$2) RETURNING id", [otherSupplier, `${marker}-other-category`])).rows[0]!.id;
     mappingIds.push(otherMapping);
    assert.equal((await adminClient.request(`/admin/suppliers/toonies/categories/${otherMapping}`, { method: "PATCH", body: JSON.stringify({ status: "needs_review" }) })).response.status, 404);
    assert.equal((await adminClient.request(`/admin/suppliers/toonies/categories/${mapping.id}`, { method: "PATCH", body: JSON.stringify({ rootCategoryId: category, status: "mapped", complianceExcluded: false }) })).response.status, 200);
    const supplierRequestsBeforeCatalogueRead = fixture.requests.length;
    const mappedCatalogue = await adminClient.request(`/admin/suppliers/toonies/catalogue?mapping=mapped&categoryId=${category}&search=${encodeURIComponent(`${marker}-product`)}`);
    assert.equal(mappedCatalogue.response.status, 200);
    assert.equal((mappedCatalogue.body as any).data.items.length, 1);
    assert.equal((mappedCatalogue.body as any).data.items[0].externalCategoryId, `${marker}-category`);
    assert.equal((mappedCatalogue.body as any).data.items[0].categoryMappingStatus, "mapped");
    assert.ok((mappedCatalogue.body as any).data.items[0].mappedCategoryPath);
    assert.ok((mappedCatalogue.body as any).data.filters.mappedCategories.some((option: any) => option.id === category));
    const unmappedCatalogue = await adminClient.request(`/admin/suppliers/toonies/catalogue?mapping=unmapped&search=${encodeURIComponent("wrong-category-sample")}`);
    assert.equal(unmappedCatalogue.response.status, 200);
    assert.equal((unmappedCatalogue.body as any).data.items.length, 1);
    assert.equal((unmappedCatalogue.body as any).data.items[0].externalCategoryId, `${marker}-other-category`);
    assert.equal((unmappedCatalogue.body as any).data.items[0].mappedCategoryPath, null);
    assert.equal(fixture.requests.length, supplierRequestsBeforeCatalogueRead, "catalogue metadata reads must not call the Toonies API");
    assert.equal((await adminClient.request(`/admin/suppliers/toonies/catalogue/${catalogue.id}/normalized-cost`, { method: "PATCH", body: JSON.stringify({ normalizedEur: 2 }) })).response.status, 410);
    assert.equal((await adminClient.request(`/admin/suppliers/toonies/variants/${variant.id}/normalized-cost`, { method: "PATCH", body: JSON.stringify({ normalizedEur: 2 }) })).response.status, 410);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/catalogue/import", { method: "POST", body: JSON.stringify({ ids: [catalogue.id] }) })).response.status, 202);
    const product = (await pool.query<{ id: string; status: string; basePrice: string; publishedAt: string | null }>("SELECT p.id,p.status,p.base_price AS \"basePrice\",p.published_at AS \"publishedAt\" FROM products p JOIN supplier_import_records r ON r.product_id=p.id WHERE r.catalogue_item_id=$1 AND r.external_variant_id IS NULL", [catalogue.id])).rows[0]!;
    assert.ok(product);
    productIds.push(product.id);
    assert.equal(product.status, "draft");
    assert.equal(product.publishedAt, null);
    assert.equal(Number(product.basePrice), 3, "the automatic ECB-normalized 1.5 EUR cost must compute a 100% markup price");
    const importAudit = (await pool.query<{ nextCostCny: string; nextCostEur: string; fxRateUsed: string; fxSource: string; fxSnapshotId: string }>("SELECT next_cost_cny AS \"nextCostCny\",next_cost_eur AS \"nextCostEur\",fx_rate_used AS \"fxRateUsed\",fx_source AS \"fxSource\",fx_rate_snapshot_id AS \"fxSnapshotId\" FROM supplier_cost_price_history WHERE catalogue_item_id=$1 AND reason='import' ORDER BY created_at LIMIT 1", [catalogue.id])).rows[0]!;
    assert.equal(importAudit.nextCostCny, "12.000000000001");
    assert.equal(Number(importAudit.nextCostEur), 1.5);
    assert.equal(Number(importAudit.fxRateUsed), 8);
    assert.equal(importAudit.fxSource, "ECB");
    assert.equal(importAudit.fxSnapshotId, catalogue.fxSnapshotId);
    const createdVariant = (await pool.query<{ id: string }>("SELECT variant_id AS id FROM supplier_import_records WHERE catalogue_item_id=$1 AND external_variant_id IS NOT NULL", [catalogue.id])).rows[0]!;
    assert.ok(createdVariant);
    const structuredOption = (await pool.query<{ attribute: string; value: string; title: string; sku: string; moq: number }>(
      `SELECT pa.name AS attribute,av.value,pv.title,pv.sku,pv.minimum_order_quantity AS moq
         FROM variant_attribute_values vav
         JOIN product_attributes pa ON pa.id=vav.attribute_id
         JOIN attribute_values av ON av.id=vav.attribute_value_id
         JOIN product_variants pv ON pv.id=vav.variant_id
        WHERE vav.variant_id=$1`,
      [createdVariant.id],
    )).rows[0]!;
    assert.deepEqual(
      { attribute: structuredOption.attribute, value: structuredOption.value, title: structuredOption.title },
      { attribute: "Specifications", value: "plastic handle", title: "plastic handle" },
    );
    assert.equal(structuredOption.sku, `TOONIES-${marker}-sku`);
    assert.equal(Number(structuredOption.moq), 2, "supplier MOQ must remain authoritative");
    assert.equal((await pool.query("SELECT vat_classified_at FROM products WHERE id=$1", [product.id])).rows[0]!.vat_classified_at, null);
    assert.equal((await pool.query("SELECT weight FROM products WHERE id=$1", [product.id])).rows[0]!.weight, "0.000");
    const requestsBeforeReconciliation = fixture.requests.length;
    await reconcileLinkedCatalogueItem(catalogue.id);
    await reconcileLinkedCatalogueItem(catalogue.id);
    assert.equal(Number((await pool.query("SELECT count(*) FROM product_variants WHERE product_id=$1", [product.id])).rows[0]!.count), 1);
    assert.equal(Number((await pool.query("SELECT count(*) FROM variant_attribute_values WHERE variant_id=$1", [createdVariant.id])).rows[0]!.count), 1);
    await pool.query("DELETE FROM variant_attribute_values WHERE variant_id=$1", [createdVariant.id]);
    await pool.query("UPDATE product_variants SET title='Merchant-selected handle' WHERE id=$1", [createdVariant.id]);
    await pool.query("UPDATE supplier_catalogue_variants SET minimum_order_quantity=3,weight_kg=0.3 WHERE id=$1", [variant.id]);
    await reconcileLinkedCatalogueItem(catalogue.id);
    await reconcileLinkedCatalogueItem(catalogue.id);
    const repairedVariant = (await pool.query<{ title: string; moq: number; weight: string; optionCount: number }>(
      `SELECT pv.title,pv.minimum_order_quantity AS moq,pv.weight,
              (SELECT count(*)::int FROM variant_attribute_values WHERE variant_id=pv.id) AS "optionCount"
         FROM product_variants pv WHERE pv.id=$1`,
      [createdVariant.id],
    )).rows[0]!;
    assert.deepEqual(
      { title: repairedVariant.title, moq: Number(repairedVariant.moq), weight: Number(repairedVariant.weight), optionCount: repairedVariant.optionCount },
      { title: "Merchant-selected handle", moq: 3, weight: 0.3, optionCount: 1 },
    );
    assert.equal(Number((await pool.query("SELECT count(*) FROM product_variants WHERE product_id=$1", [product.id])).rows[0]!.count), 1, "repeated reconciliation must not duplicate variants");
    assert.equal(Number((await pool.query("SELECT count(*) FROM variant_attribute_values WHERE variant_id=$1", [createdVariant.id])).rows[0]!.count), 1, "repeated reconciliation must not duplicate option relationships");
    assert.equal(fixture.requests.length, requestsBeforeReconciliation, "catalogue reconciliation must not call a supplier or order endpoint");
    await pool.query("UPDATE supplier_catalogue_variants SET stock=0,state='Out of stock' WHERE id=$1", [variant.id]);
    await reconcileLinkedCatalogueItem(catalogue.id);
    const zeroStockState = (await pool.query<{ variantActive: boolean; inventoryActive: boolean; quantity: string }>(
      `SELECT pv.active AS "variantActive",i.active AS "inventoryActive",i.quantity_on_hand AS quantity
         FROM product_variants pv
         LEFT JOIN inventory i ON i.variant_id=pv.id
        WHERE pv.id=$1`,
      [createdVariant.id],
    )).rows[0]!;
    assert.equal(zeroStockState.variantActive, false, "zero-stock supplier SKU must remain unavailable");
    assert.equal(zeroStockState.inventoryActive, false, "zero-stock inventory must remain inactive");
    assert.equal(Number(zeroStockState.quantity), 0, "zero-stock quantity must remain zero");
    await pool.query("UPDATE supplier_catalogue_variants SET stock=4,state='Synced' WHERE id=$1", [variant.id]);
    await reconcileLinkedCatalogueItem(catalogue.id);
    await pool.query(
      `INSERT INTO product_media(product_id,type,url,is_primary,sort_order,source_workflow)
       SELECT $1,'image',$2 || value::text,false,value-1,'toonies-controlled-import'
         FROM generate_series(1,4) value`,
      [product.id, `/catalog-media/${marker}-`],
    );
    await normalizeTooniesPrimaryMedia(product.id);
    await normalizeTooniesPrimaryMedia(product.id);
    const mediaIntegrity = (await pool.query<{ total: number; primaryCount: number }>(
      `SELECT count(*)::int AS total,count(*) FILTER (WHERE is_primary)::int AS "primaryCount"
         FROM product_media WHERE product_id=$1 AND variant_id IS NULL AND type='image'`,
      [product.id],
    )).rows[0]!;
    assert.deepEqual(mediaIntegrity, { total: 4, primaryCount: 1 });
    const supplierMedia = (await pool.query<{ id: string; url: string }>(
      "SELECT id,url FROM product_media WHERE product_id=$1 AND variant_id IS NULL ORDER BY sort_order,id",
      [product.id],
    )).rows;
    await pool.query("UPDATE product_media SET sort_order=10 WHERE id=$1", [supplierMedia[0]!.id]);
    await pool.query("UPDATE product_media SET sort_order=0 WHERE id=$1", [supplierMedia[1]!.id]);
    await normalizeTooniesPrimaryMedia(product.id);
    assert.equal(
      (await pool.query("SELECT url FROM product_media WHERE product_id=$1 AND variant_id IS NULL AND is_primary=true", [product.id])).rows[0]!.url,
      supplierMedia[1]!.url,
      "supplier-owned primary must follow current authoritative gallery order",
    );
    const adminMedia = (await pool.query<{ id: string }>(
      "INSERT INTO product_media(product_id,type,url,is_primary,sort_order) VALUES($1,'image',$2,false,99) RETURNING id",
      [product.id, `/catalog-media/${marker}-admin-override.jpg`],
    )).rows[0]!;
    await pool.query("UPDATE product_media SET is_primary=false WHERE product_id=$1 AND variant_id IS NULL", [product.id]);
    await pool.query("UPDATE product_media SET is_primary=true WHERE id=$1", [adminMedia.id]);
    await normalizeTooniesPrimaryMedia(product.id);
    assert.equal(
      (await pool.query("SELECT id FROM product_media WHERE product_id=$1 AND variant_id IS NULL AND is_primary=true", [product.id])).rows[0]!.id,
      adminMedia.id,
      "an intentional admin primary must survive supplier reconciliation",
    );
    await assert.rejects(
      () => pool.query("INSERT INTO product_media(product_id,type,url,is_primary) VALUES($1,'image',$2,true)", [product.id, `/catalog-media/${marker}-duplicate-primary.jpg`]),
      (error: any) => error?.code === "23505",
    );
    await pool.query("UPDATE supplier_catalogue_variants SET sku_code=$1 WHERE id=$2", [`${marker}-sku-renamed`, variant.id]);
    await reconcileLinkedCatalogueItem(catalogue.id);
    assert.equal((await pool.query("SELECT sku FROM product_variants WHERE id=$1", [createdVariant.id])).rows[0]!.sku, `TOONIES-${marker}-sku-renamed`);
    assert.equal(Number((await pool.query("SELECT count(*) FROM product_variants WHERE product_id=$1", [product.id])).rows[0]!.count), 1);
    await pool.query("UPDATE supplier_catalogue_variants SET sku_code=$1 WHERE id=$2", [`${marker}-sku`, variant.id]);
    await reconcileLinkedCatalogueItem(catalogue.id);
    assert.equal(fixture.requests.some((request: any) => request.path?.startsWith("/v1/order/")), false, "catalogue import must not call a Toonies order endpoint");
    assert.equal((await pool.query<{ active: boolean }>("SELECT active FROM product_variants WHERE id=$1", [createdVariant.id])).rows[0]!.active, false);
    assert.equal((await pool.query<{ active: boolean }>("SELECT active FROM inventory WHERE variant_id=$1", [createdVariant.id])).rows[0]!.active, false);

    // Publication is a transaction boundary, not an eventual UI convention:
    // even a valid generic product payload cannot activate a Toonies draft
    // while supplier, mapping, or compliance publication switches are off.
    const publicationProduct = (await pool.query<any>(
      `SELECT name,slug,parent_sku AS "parentSku",category_id AS "categoryId",description,status,
              cost_price AS "costPrice",base_price AS "basePrice",vat_rate AS "vatRate",tax_mode AS "taxMode",weight,
              minimum_order_quantity AS "minimumOrderQuantity"
         FROM products WHERE id=$1`,
      [product.id],
    )).rows[0]!;
    const publicationVariant = (await pool.query<any>(
      `SELECT id,sku,barcode,title,cost_price AS "costPrice",base_price AS "basePrice",weight,
              minimum_order_quantity AS "minimumOrderQuantity",active
         FROM product_variants WHERE id=$1`,
      [createdVariant.id],
    )).rows[0]!;
    const publicationInput = {
      ...publicationProduct,
      status: "active" as const,
      seoTitle: null,
      seoDescription: null,
      barcode: null,
      brandId: null,
      shortDescription: null,
      featured: false,
      newArrival: false,
      homepageWholesale: false,
      width: null,
      height: null,
      length: null,
      options: [{ name: "Specifications", values: ["plastic handle"] }],
      variants: [{ ...publicationVariant, optionValues: [{ attribute: "Specifications", value: "plastic handle" }] }],
    };
    await pool.query("UPDATE suppliers SET publication_enabled=false,compliance_excluded=true WHERE id=$1", [tooniesId]);
    assert.equal((await pool.query("SELECT publication_enabled,compliance_excluded FROM suppliers WHERE id=$1", [tooniesId])).rows[0]!.publication_enabled, false);
    await assert.rejects(
      () => saveProduct(publicationInput, product.id),
      (error: any) => error?.statusCode === 409 && error?.code === "TOONIES_PUBLICATION_SUPPLIER_INVALID",
    );
    assert.equal((await pool.query("SELECT status FROM products WHERE id=$1", [product.id])).rows[0]!.status, "draft");
    await pool.query("UPDATE suppliers SET publication_enabled=true,compliance_excluded=false WHERE id=$1", [tooniesId]);
    await assert.rejects(
      () => saveProduct(publicationInput, product.id),
      (error: any) => error?.statusCode === 409 && error?.code === "TOONIES_PUBLICATION_MAPPING_INVALID",
    );
    await reconcileLinkedCatalogueItem(catalogue.id);
    assert.equal((await pool.query("SELECT active FROM product_variants WHERE id=$1", [createdVariant.id])).rows[0]!.active, false);
    assert.equal((await pool.query("SELECT active FROM inventory WHERE variant_id=$1", [createdVariant.id])).rows[0]!.active, false);
    await pool.query(
      "UPDATE supplier_category_mappings SET status='mapped',publication_enabled=true,compliance_excluded=false,root_category_id=$1,child_category_id=NULL WHERE id=$2",
      [category, mapping.id],
    );
    await pool.query("UPDATE supplier_catalogue_items SET state='Synced',needs_review=false WHERE id=$1", [catalogue.id]);
    await pool.query("UPDATE supplier_catalogue_variants SET state='Synced',needs_review=false WHERE id=$1", [variant.id]);
    await saveProduct(publicationInput, product.id);
    assert.equal((await pool.query("SELECT status,published_at AS \"publishedAt\" FROM products WHERE id=$1", [product.id])).rows[0]!.status, "active");
    assert.equal((await pool.query("SELECT active FROM product_variants WHERE id=$1", [createdVariant.id])).rows[0]!.active, true);
    const publishedInventory = (await pool.query<{ active: boolean; quantityOnHand: string }>(
      "SELECT active,quantity_on_hand AS \"quantityOnHand\" FROM inventory WHERE variant_id=$1",
      [createdVariant.id],
    )).rows[0]!;
    assert.equal(publishedInventory.active, true);
    assert.equal(Number(publishedInventory.quantityOnHand), 4, "publication must use authoritative supplier stock");
    await pool.query("UPDATE supplier_category_mappings SET publication_enabled=false,compliance_excluded=true WHERE id=$1", [mapping.id]);
    await pool.query("UPDATE suppliers SET publication_enabled=false,compliance_excluded=true WHERE id=$1", [tooniesId]);

    // Products with no Toonies link retain the ordinary generic save path.
    const genericProduct = (await pool.query<{ id: string }>(
      `INSERT INTO products(name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status)
       VALUES($1,$2,$3,$4,$5,1,2,19,1,'draft') RETURNING id`,
      [`${marker} generic`, `${marker}-generic`, `${marker}-generic-sku`, category, `${marker} generic`],
    )).rows[0]!.id;
    productIds.push(genericProduct);
    await saveProduct({
      name: `${marker} generic`,
      slug: `${marker}-generic`,
      seoTitle: null,
      seoDescription: null,
      parentSku: `${marker}-generic-sku`,
      barcode: null,
      brandId: null,
      categoryId: category,
      shortDescription: null,
      description: `${marker} generic`,
      status: "active",
      costPrice: 1,
      basePrice: 2,
      vatRate: 19,
      taxMode: "inclusive",
      weight: 1,
      minimumOrderQuantity: 1,
      width: null,
      height: null,
      length: null,
      featured: false,
      newArrival: false,
      homepageWholesale: false,
      options: [],
      variants: [],
    }, genericProduct);
    assert.equal((await pool.query("SELECT status,published_at FROM products WHERE id=$1", [genericProduct])).rows[0]!.status, "active");

    const override = 77;
    assert.equal((await adminClient.request(`/admin/suppliers/toonies/variants/${variant.id}/selling-price`, { method: "PATCH", body: JSON.stringify({ sellingPriceEur: override }) })).response.status, 200);
    const concurrent = await Promise.all([
      adminClient.request("/admin/suppliers/toonies/catalogue/import", { method: "POST", body: JSON.stringify({ ids: [catalogue.id] }) }),
      adminClient.request("/admin/suppliers/toonies/catalogue/import", { method: "POST", body: JSON.stringify({ ids: [catalogue.id] }) }),
    ]);
    assert.ok(concurrent.every((item) => item.response.status === 202));
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM supplier_import_records WHERE catalogue_item_id=$1", [catalogue.id])).rows[0]!.count), 2);
    assert.equal(fxCalls, 1, "one shared FX provider acquisition should serve the sync and imports");

    // An unmapped category remains a separate fail-closed import gate.
    const blocked = (await pool.query<{ id: string }>("INSERT INTO supplier_catalogue_items(supplier_id,external_product_id,title,original_amount,original_currency) VALUES($1,$2,$2,1,'CNY') RETURNING id", [tooniesSupplier.id, `${marker}-blocked`])).rows[0]!.id;
    catalogueIds.push(blocked);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/catalogue/import", { method: "POST", body: JSON.stringify({ ids: [blocked] }) })).response.status, 409);
    assert.equal((await pool.query("SELECT count(*) AS count FROM products WHERE parent_sku=$1", [`TOONIES-${marker}-blocked`])).rows[0]!.count, "0");

    const staleCatalogue = (await pool.query<{ id: string }>("INSERT INTO supplier_catalogue_items(supplier_id,external_product_id,external_category_id,title,original_amount,original_currency,stock) VALUES($1,$2,$3,$2,8,'CNY',1) RETURNING id", [tooniesSupplier.id, `${marker}-stale-fx`, `${marker}-category`])).rows[0]!.id;
    catalogueIds.push(staleCatalogue);
    const staleNow = new Date(fxNow.getTime() + 10 * 24 * 60 * 60 * 1000);
    setFxClock(() => staleNow);
    setFxProvider({
      name: "ECB", source: "ECB", series: "EXR.D.CNY.EUR.SP00.A", baseCurrency: "EUR", quoteCurrency: "CNY",
      fetchObservation: async () => ({ provider: "ECB", source: "ECB", series: "EXR.D.CNY.EUR.SP00.A", baseCurrency: "EUR", quoteCurrency: "CNY", rate: "8", observedAt: fxObservedAt, fetchedAt: staleNow }),
    });
    const staleImport = await adminClient.request("/admin/suppliers/toonies/catalogue/import", { method: "POST", body: JSON.stringify({ ids: [staleCatalogue] }) });
    assert.equal(staleImport.response.status, 409);
    assert.equal((staleImport.body as any).error.code, "FX_RATE_STALE");
    assert.equal((await pool.query("SELECT count(*) AS count FROM products WHERE parent_sku=$1", [`TOONIES-${marker}-stale-fx`])).rows[0]!.count, "0");

    const unavailableCatalogue = (await pool.query<{ id: string }>("INSERT INTO supplier_catalogue_items(supplier_id,external_product_id,external_category_id,title,original_amount,original_currency,stock) VALUES($1,$2,$3,$2,8,'CNY',1) RETURNING id", [tooniesSupplier.id, `${marker}-unavailable-fx`, `${marker}-category`])).rows[0]!.id;
    catalogueIds.push(unavailableCatalogue);
    setFxProvider({
      name: "ECB", source: "ECB", series: "EXR.D.CNY.EUR.SP00.A", baseCurrency: "EUR", quoteCurrency: "CNY",
      fetchObservation: async () => { throw new Error("fixture provider unavailable"); },
    });
    const unavailableImport = await adminClient.request("/admin/suppliers/toonies/catalogue/import", { method: "POST", body: JSON.stringify({ ids: [unavailableCatalogue] }) });
    assert.equal(unavailableImport.response.status, 409);
    assert.equal((unavailableImport.body as any).error.code, "FX_RATE_UNAVAILABLE");
    assert.equal((await pool.query("SELECT count(*) AS count FROM products WHERE parent_sku=$1", [`TOONIES-${marker}-unavailable-fx`])).rows[0]!.count, "0");
    setFxClock(() => fxNow);

    // The bounded sync processes five pages per call. The fixture has six
    // authoritative pages, so the first call must persist a resumable cursor
    // rather than claiming completion.
    setFxProvider({
      name: fixtureFxProvider,
      source: "ECB",
      series: "EXR.D.CNY.EUR.SP00.A",
      baseCurrency: "EUR",
      quoteCurrency: "CNY",
      fetchObservation: async () => ({
        provider: fixtureFxProvider, source: "ECB", series: "EXR.D.CNY.EUR.SP00.A",
        baseCurrency: "EUR", quoteCurrency: "CNY", rate: "8", observedAt: fxObservedAt, fetchedAt: fxNow,
      }),
    });
    const syncCodes = Array.from({ length: 6 }, (_, index) => `${marker}-sync-${index + 1}`);
    const syncRequests: string[] = [];
    let failPageSixOnce = true;
    const syncTransport = async ({ path, body }: { path: string; body: Buffer }) => {
      const request = JSON.parse(body.toString()) as { page?: number; product_code?: string };
      syncRequests.push(`${path}:${request.page ?? request.product_code ?? ""}`);
      if (path === "/v1/product/search") {
        const page = request.page ?? 1;
        if (page === 6 && failPageSixOnce) {
          failPageSixOnce = false;
          return {
            envelope: {
              status: false, code: 40040, msg: "fixture page six failure", data: null,
            },
          };
        }
        return {
          envelope: {
            status: true, code: 200, msg: "ok",
            data: {
              items: [{ product_code: syncCodes[page - 1] }],
              total: syncCodes.length, total_page: syncCodes.length, page, page_size: 1,
              currency: "CNY",
            },
          },
        };
      }
      const code = request.product_code!;
      return {
        envelope: {
          status: true, code: 200, msg: "ok",
          data: {
            product_code: code, title: `${code} title`, title_trans: `${code} translated`,
            category_id: `${marker}-sync-category`, currency: "CNY", charge: "8",
            images: [], skus: [{ sku_code: `${code}-sku`, spec_desc: "Blue", charge: "8", stock: 2, weight: 0.2 }],
          },
        },
      };
    };
    setTooniesClient(new TooniesClient({
      app_key: "fixture-key", app_secret: "fixture-secret", transport: syncTransport,
      now: () => 1_700_000_000, nonce: () => `${marker}-sync-nonce`.slice(0, 32),
    }));
    let releaseConcurrentSearch!: () => void;
    let concurrentSearchStarted!: () => void;
    const concurrentStarted = new Promise<void>((resolve) => { concurrentSearchStarted = resolve; });
    const concurrentRelease = new Promise<void>((resolve) => { releaseConcurrentSearch = resolve; });
    setTooniesClient(new TooniesClient({
      app_key: "fixture-key", app_secret: "fixture-secret",
      transport: async (request) => {
        const input = JSON.parse(request.body.toString("utf8"));
        if (request.path === "/v1/product/search" && input.keyword === `${marker}-concurrent`) {
          concurrentSearchStarted();
          await concurrentRelease;
          return { envelope: { status: true, code: 200, msg: "ok", data: { items: [], has_next: false, total: 0 } } };
        }
        return syncTransport(request);
      },
      now: () => 1_700_000_000, nonce: () => `${marker}-concurrent-nonce`.slice(0, 32),
    }));
    const beforeConcurrent = Number((await pool.query(
      "SELECT count(*) AS count FROM supplier_sync_runs WHERE supplier_id=$1",
      [tooniesId],
    )).rows[0].count);
    const acceptedConcurrent = syncTooniesSearch({ keyword: `${marker}-concurrent`, pageSize: 20 });
    await concurrentStarted;
    await assert.rejects(
      () => syncTooniesSearch({ keyword: `${marker}-concurrent`, pageSize: 20 }),
      (error: any) => error?.statusCode === 409 && error?.code === "TOONIES_SYNC_ALREADY_RUNNING",
    );
    assert.equal(Number((await pool.query(
      "SELECT count(*) AS count FROM supplier_sync_runs WHERE supplier_id=$1",
      [tooniesId],
    )).rows[0].count), beforeConcurrent + 1);
    releaseConcurrentSearch();
    await acceptedConcurrent;
    const afterAcceptedConcurrent = Number((await pool.query(
      "SELECT count(*) AS count FROM supplier_sync_runs WHERE supplier_id=$1",
      [tooniesId],
    )).rows[0].count);
    assert.equal(afterAcceptedConcurrent, beforeConcurrent + 1);

    setTooniesClient(new TooniesClient({
      app_key: "fixture-key", app_secret: "fixture-secret",
      transport: async () => { throw new Error("private fixture transport failure"); },
    }));
    await assert.rejects(() => syncTooniesSearch({ keyword: `${marker}-unexpected`, pageSize: 20 }));
    const finalizedUnexpected = (await pool.query(
      `SELECT status,error_code AS "errorCode",error_message AS "errorMessage",completed_at AS "completedAt"
         FROM supplier_sync_runs WHERE supplier_id=$1 AND keyword=$2 ORDER BY created_at DESC LIMIT 1`,
      [tooniesId, `${marker}-unexpected`],
    )).rows[0] as any;
    assert.equal(finalizedUnexpected.status, "failed");
    assert.equal(finalizedUnexpected.errorCode, "SYNC_FAILED");
    assert.equal(finalizedUnexpected.errorMessage, "Filtered catalogue synchronization failed before completion.");
    assert.ok(finalizedUnexpected.completedAt);

    let providerRateCalls = 0;
    setTooniesClient(new TooniesClient({
      app_key: "fixture-key", app_secret: "fixture-secret",
      transport: async () => {
        providerRateCalls += 1;
        return { envelope: { status: false, code: 42901, msg: "private upstream quota detail", data: null } };
      },
    }));
    await assert.rejects(
      () => syncTooniesSearch({ keyword: `${marker}-rate-limited`, pageSize: 20 }),
      (error: any) => error?.statusCode === 503
        && error?.code === "TOONIES_RATE_LIMITED"
        && !error?.message.includes("private upstream"),
    );
    assert.equal(providerRateCalls, 1);
    const finalizedRateLimited = (await pool.query(
      `SELECT status,error_code AS "errorCode",error_message AS "errorMessage"
         FROM supplier_sync_runs WHERE supplier_id=$1 AND keyword=$2 ORDER BY created_at DESC LIMIT 1`,
      [tooniesId, `${marker}-rate-limited`],
    )).rows[0] as any;
    assert.equal(finalizedRateLimited.status, "failed");
    assert.equal(finalizedRateLimited.errorCode, "TOONIES_RATE_LIMITED");
    assert.equal(finalizedRateLimited.errorMessage, "Toonies rate limited authoritative product detail retrieval.");

    let replicaACalls = 0;
    let replicaBCalls = 0;
    const replicaA = new TooniesClient({
      app_key: "fixture-key", app_secret: "fixture-secret",
      rateLimitCooldownMs: 1_000,
      transport: async () => {
        replicaACalls += 1;
        return { envelope: { status: false, code: 42901, msg: "rate", data: null } };
      },
    });
    const replicaB = new TooniesClient({
      app_key: "fixture-key", app_secret: "fixture-secret",
      transport: async () => {
        replicaBCalls += 1;
        return { envelope: { status: true, code: 200, msg: "ok", data: { product_code: "replica-b" } } };
      },
    });
    const replicaARequest = testDistributedTooniesDetailGate("replica-a", replicaA, { intervalMs: 20, cooldownMs: 150 }).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const replicaBRequest = testDistributedTooniesDetailGate("replica-b", replicaB, { intervalMs: 20, cooldownMs: 150 });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(replicaACalls, 1);
    assert.equal(replicaBCalls, 0);
    assert.ok(await replicaARequest instanceof TooniesError);
    await replicaBRequest;
    assert.equal(replicaBCalls, 1);

    let staleCleanupProviderCalls = 0;
    setTooniesClient(new TooniesClient({
      app_key: "fixture-key", app_secret: "fixture-secret",
      transport: async () => {
        staleCleanupProviderCalls += 1;
        throw new Error("stale cleanup must not contact the provider");
      },
    }));
    const staleRun = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_sync_runs(supplier_id,operation,keyword,page_size,next_page,status,updated_at)
       VALUES($1,'catalogue',$2,20,1,'running',now()-interval '20 minutes') RETURNING id`,
      [tooniesId, `${marker}-stale`],
    )).rows[0]!.id;
    const freshRun = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_sync_runs(supplier_id,operation,keyword,page_size,next_page,status,updated_at)
       VALUES($1,'catalogue',$2,20,1,'running',now()) RETURNING id`,
      [tooniesId, `${marker}-fresh`],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO supplier_fx_normalization_runs(supplier_id,supplier_sync_run_id,status,updated_at)
       VALUES($1,$2,'running',now()-interval '20 minutes'),($1,$3,'running',now())`,
      [tooniesId, staleRun, freshRun],
    );
    const staleResult = await reconcileStaleTooniesSyncRuns();
    assert.ok(staleResult.runsAbandoned >= 1);
    assert.equal(staleCleanupProviderCalls, 0);
    const reconciledRuns = await pool.query(
      `SELECT id,status,error_code AS "errorCode",completed_at AS "completedAt"
         FROM supplier_sync_runs WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[staleRun, freshRun]],
    );
    const staleRow = reconciledRuns.rows.find((row) => row.id === staleRun)!;
    const freshRow = reconciledRuns.rows.find((row) => row.id === freshRun)!;
    assert.equal(staleRow.status, "failed");
    assert.equal(staleRow.errorCode, "STALE_SYNC_ABANDONED");
    assert.ok(staleRow.completedAt);
    assert.equal(freshRow.status, "running");
    assert.equal(freshRow.errorCode, null);

    setTooniesClient(new TooniesClient({
      app_key: "fixture-key", app_secret: "fixture-secret", transport: syncTransport,
      now: () => 1_700_000_000, nonce: () => `${marker}-sync-nonce`.slice(0, 32),
    }));
    await assert.rejects(
      () => syncTooniesSearch({ keyword: `${marker}-oversized`, pageSize: 21 }),
      (error: any) => error?.statusCode === 400 && error?.code === "VALIDATION_ERROR",
    );
    const partialRun = await syncTooniesSearch({ keyword: `${marker}-bounded`, pageSize: 1 }) as any;
    assert.equal(partialRun.status, "partial");
    assert.equal(partialRun.nextPage, 6);
    assert.equal(partialRun.providerEndAuthoritative, false);
    assert.ok(partialRun.pageCount <= 5);
    const leaseGuard = await pool.connect();
    try {
      await leaseGuard.query(
        "SELECT pg_advisory_lock(hashtext('toonies:sync-run'),hashtext($1))",
        [partialRun.id],
      );
      await assert.rejects(
        () => resumeTooniesSync(partialRun.id, { keyword: `${marker}-bounded`, pageSize: 1 }),
        (error: any) => error?.statusCode === 409 && error?.code === "SUPPLIER_SYNC_ALREADY_RUNNING",
      );
    } finally {
      await leaseGuard.query(
        "SELECT pg_advisory_unlock(hashtext('toonies:sync-run'),hashtext($1))",
        [partialRun.id],
      );
      leaseGuard.release();
    }
    const afterLeaseRejection = (await pool.query(
      `SELECT status,next_page AS "nextPage" FROM supplier_sync_runs WHERE id=$1`,
      [partialRun.id],
    )).rows[0] as any;
    assert.equal(afterLeaseRejection.status, "partial");
    assert.equal(afterLeaseRejection.nextPage, 6);
    assert.equal(Number((await pool.query(
      "SELECT count(*) AS count FROM supplier_catalogue_items WHERE supplier_id=$1 AND external_product_id LIKE $2",
      [tooniesId, `${marker}-sync-%`],
    )).rows[0]!.count), 5);
    await assert.rejects(
      () => resumeTooniesSync(partialRun.id, { keyword: `${marker}-bounded`, pageSize: 2 }),
      (error: any) => error?.statusCode === 409 && error?.code === "SUPPLIER_SYNC_PARAMETERS_IMMUTABLE",
    );
    await assert.rejects(
      () => resumeTooniesSync(partialRun.id, { keyword: `${marker}-bounded`, pageSize: 1 }),
      (error: any) => error?.statusCode === 502 && error?.code === "TOONIES_40040",
    );
    const failedRun = (await pool.query(
      `SELECT status,next_page AS "nextPage" FROM supplier_sync_runs WHERE id=$1`,
      [partialRun.id],
    )).rows[0] as any;
    assert.equal(failedRun.status, "failed");
    assert.equal(failedRun.nextPage, 6);
    const completedRun = await resumeTooniesSync(partialRun.id, { keyword: `${marker}-bounded`, pageSize: 1 }) as any;
    assert.equal(completedRun.status, "completed");
    assert.equal(completedRun.providerEndAuthoritative, true);
    assert.equal(completedRun.nextPage, 7);
    assert.equal(completedRun.expectedPages, 6);
    assert.equal(syncRequests.filter((request) => request.startsWith("/v1/product/search")).length, 7);

    // Repeating the same authoritative page through a new run exercises the
    // catalogue upserts; product and SKU identities must remain unique.
    await syncTooniesSearch({ keyword: `${marker}-bounded`, pageSize: 1 });
    assert.equal(Number((await pool.query(
      "SELECT count(*) AS count FROM supplier_catalogue_items WHERE supplier_id=$1 AND external_product_id LIKE $2",
      [tooniesId, `${marker}-sync-%`],
    )).rows[0]!.count), syncCodes.length);
    assert.equal(Number((await pool.query(
      "SELECT count(*) AS count FROM supplier_catalogue_variants WHERE supplier_id=$1 AND external_variant_id LIKE $2",
      [tooniesId, `${marker}-sync-%`],
    )).rows[0]!.count), syncCodes.length);
    setTooniesClient(toonies);

    const collisionProduct = (await pool.query<{ id: string }>("INSERT INTO products(name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status) VALUES($1,$2,$3,$4,$5,1,2,0,0,'draft') RETURNING id", [`${marker} collision`, `${marker}-collision`, `TOONIES-${marker}-collision`, category, `${marker} collision`])).rows[0]!.id;
    productIds.push(collisionProduct);
    const collisionCatalogue = (await pool.query<{ id: string }>("INSERT INTO supplier_catalogue_items(supplier_id,external_product_id,title,original_amount,original_currency,normalized_eur,stock) VALUES($1,$2,$2,1,'CNY',2,1) RETURNING id", [tooniesSupplier.id, `${marker}-collision`])).rows[0]!.id;
    catalogueIds.push(collisionCatalogue);
    const collisionCategory = `${marker}-collision-category`;
     const collisionMapping = (await pool.query<{ id: string }>("INSERT INTO supplier_category_mappings(supplier_id,external_category_id,external_category_name,status,root_category_id) VALUES($1,$2,$2,'mapped',$3) RETURNING id", [tooniesSupplier.id, collisionCategory, category])).rows[0]!.id;
     mappingIds.push(collisionMapping);
    await pool.query("UPDATE supplier_catalogue_items SET external_category_id=$1 WHERE id=$2", [collisionCategory, collisionCatalogue]);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/catalogue/import", { method: "POST", body: JSON.stringify({ ids: [collisionCatalogue] }) })).response.status, 409);

    // Cost-band boundaries and rounding are exact; a manual selling override
    // survives authoritative supplier cost reconciliation.
    const bands = await pool.query<{ minCostEur: string; maxCostEur: string | null; value: string }>("SELECT min_cost_eur AS \"minCostEur\",max_cost_eur AS \"maxCostEur\",value FROM supplier_pricing_rules WHERE supplier_id=$1 ORDER BY min_cost_eur", [tooniesSupplier.id]);
    assert.deepEqual(bands.rows.map((row) => [Number(row.minCostEur), row.maxCostEur === null ? null : Number(row.maxCostEur), Number(row.value)]), [[0, 5, 100], [5, 15, 70], [15, 30, 50], [30, 75, 35], [75, null, 25]]);
    for (const [cost, expected] of [[4.99, 9.98], [5, 8.5], [15, 22.5], [30, 40.5], [75, 93.75]] as const) {
      const result = await adminClient.request("/admin/suppliers/toonies/pricing/preview", { method: "POST", body: JSON.stringify({ cost, ruleType: "markup_percent", value: expected / cost * 100 - 100 }) });
      assert.equal(result.response.status, 200);
    }
    const round = await adminClient.request("/admin/suppliers/toonies/pricing/preview", { method: "POST", body: JSON.stringify({ cost: 2, ruleType: "markup_fixed", value: 0, roundingMode: "99" }) });
    assert.equal(round.body.data.price, 2.99);
    await reconcileLinkedCatalogueItem(catalogue.id);
    assert.equal(Number((await pool.query("SELECT base_price FROM product_variants WHERE id=$1", [createdVariant.id])).rows[0].base_price), override);
    const siblingProduct = (await pool.query<{ id: string }>("INSERT INTO products(name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status) VALUES($1,$2,$3,$4,$5,2,4,0,0,'draft') RETURNING id", [`${marker} sibling`, `${marker}-sibling`, `TOONIES-${marker}-sibling`, category, `${marker} sibling`])).rows[0]!.id;
    productIds.push(siblingProduct);
    const siblingCatalogueVariant = (await pool.query<{ id: string }>("INSERT INTO supplier_catalogue_variants(supplier_id,catalogue_item_id,external_variant_id,sku_code,title,original_amount,original_currency,normalized_eur,normalized_currency,fx_rate_snapshot_id,fx_rate_used,fx_source,fx_observed_at,fx_fetched_at,stock,state,needs_review) VALUES($1,$2,$3,$3,$3,2,'CNY',2.2,'EUR',$4,8,'ECB','2024-01-04T00:00:00Z','2024-01-05T12:00:00Z',2,'Synced',false) RETURNING id", [tooniesSupplier.id, catalogue.id, `${marker}-sibling`, catalogue.fxSnapshotId])).rows[0]!.id;
    variantIds.push(siblingCatalogueVariant);
    const siblingProductVariant = (await pool.query<{ id: string }>("INSERT INTO product_variants(product_id,sku,title,cost_price,base_price,weight,active) VALUES($1,$2,$2,2,4,0.2,true) RETURNING id", [siblingProduct, `TOONIES-${marker}-sibling`])).rows[0]!.id;
    await pool.query("INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id) VALUES($1,$2,$3,$4,$5)", [tooniesSupplier.id, catalogue.id, siblingCatalogueVariant, siblingProduct, siblingProductVariant]);
    await pool.query("UPDATE supplier_catalogue_variants SET stock=0,normalized_eur=10 WHERE id=$1", [variant.id]);
    await reconcileLinkedCatalogueItem(catalogue.id);
    assert.equal((await pool.query("SELECT active FROM product_variants WHERE id=$1", [createdVariant.id])).rows[0].active, false);
    assert.equal((await pool.query("SELECT active,base_price FROM product_variants WHERE id=$1", [siblingProductVariant])).rows[0].active, false);
    assert.equal((await pool.query("SELECT needs_review FROM supplier_catalogue_variants WHERE id=$1", [siblingCatalogueVariant])).rows[0].needs_review, false);
    assert.equal(Number((await pool.query("SELECT base_price FROM product_variants WHERE id=$1", [siblingProductVariant])).rows[0].base_price), 4.4);
    assert.ok(Number((await pool.query("SELECT count(*) AS count FROM supplier_cost_price_history WHERE catalogue_item_id=$1 AND reason='significant_increase_review'", [catalogue.id])).rows[0].count) >= 1);
    const linkProposal = (await pool.query<any>(`SELECT id,status,formula_price_eur AS "formulaPrice",manual_override_eur AS "manualPrice",
      manual_override_source AS "manualSource",proposed_price_eur AS "effectivePrice",pricing_rule_type AS "ruleType",
      pricing_rule_value AS "ruleValue",pricing_rounding_mode AS "roundingMode",pricing_min_cost_eur AS "minCost",pricing_max_cost_eur AS "maxCost"
      FROM supplier_price_change_reviews WHERE catalogue_variant_id=$1 ORDER BY detected_at DESC,id DESC LIMIT 1`, [variant.id])).rows[0];
    assert.equal(Number(linkProposal.formulaPrice), 17);
    assert.equal(Number(linkProposal.manualPrice), 77);
    assert.equal(linkProposal.manualSource, "link");
    assert.equal(Number(linkProposal.effectivePrice), 77);
    assert.deepEqual([linkProposal.ruleType, Number(linkProposal.ruleValue), linkProposal.roundingMode, Number(linkProposal.minCost), Number(linkProposal.maxCost)], ["markup_percent", 70, "none", 5, 15]);

    // Link and catalogue-variant values can be synchronized copies of one Admin
    // operation. Even at the same numeric price, changing the effective source
    // is material provenance and must supersede the prior proposal.
    await pool.query("UPDATE supplier_product_links SET manual_selling_price_eur=NULL WHERE catalogue_variant_id=$1", [variant.id]);
    await reconcileLinkedCatalogueItem(catalogue.id);
    const variantProposal = (await pool.query<any>("SELECT id,manual_override_source AS \"manualSource\",formula_price_eur AS \"formulaPrice\" FROM supplier_price_change_reviews WHERE catalogue_variant_id=$1 AND status='pending' ORDER BY detected_at DESC,id DESC LIMIT 1", [variant.id])).rows[0];
    assert.equal(variantProposal.manualSource, "variant");
    assert.equal(Number(variantProposal.formulaPrice), 17);
    assert.equal((await pool.query("SELECT status FROM supplier_price_change_reviews WHERE id=$1", [linkProposal.id])).rows[0].status, "superseded");

    // Legacy/incomplete historical snapshots are never repaired during Accept.
    await pool.query("UPDATE supplier_price_change_reviews SET formula_price_eur=NULL WHERE id=$1", [variantProposal.id]);
    const legacyAccept = await adminClient.request(`/admin/suppliers/toonies/pricing/reviews/${variantProposal.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "accept" }) });
    assert.equal(legacyAccept.response.status, 409);
    assert.equal(legacyAccept.body.error.code, "PRICE_CHANGE_REVIEW_STALE");

    await pool.query("UPDATE supplier_product_links SET manual_selling_price_eur=77 WHERE catalogue_variant_id=$1", [variant.id]);
    await reconcileLinkedCatalogueItem(catalogue.id);
    const replacement = (await pool.query<any>("SELECT id,formula_price_eur AS \"formulaPrice\",manual_override_source AS \"manualSource\" FROM supplier_price_change_reviews WHERE catalogue_variant_id=$1 AND status='pending' ORDER BY detected_at DESC,id DESC LIMIT 1", [variant.id])).rows[0];
    assert.equal(Number(replacement.formulaPrice), 17);
    assert.equal(replacement.manualSource, "link");
    const accepted = await adminClient.request(`/admin/suppliers/toonies/pricing/reviews/${replacement.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "accept" }) });
    assert.equal(accepted.response.status, 200);
    const acceptedCommerce = (await pool.query("SELECT cost_price,base_price FROM product_variants WHERE id=$1", [createdVariant.id])).rows[0];
    assert.equal(Number(acceptedCommerce.cost_price), 10);
    assert.equal(Number(acceptedCommerce.base_price), 77);

    assert.equal((await adminClient.request("/admin/suppliers/toonies/precheck", { method: "POST", body: "{}" })).response.status, 404);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/task", { method: "POST", body: "{}" })).response.status, 404);
     const shippingCreate = await adminClient.request("/admin/suppliers/toonies/shipping", { method: "POST", body: JSON.stringify({ countryCode: "DE", minWeightKg: 0, maxWeightKg: 1, amountEur: 4, minDeliveryDays: 5, maxDeliveryDays: 9, temporary: true }) });
     assert.equal(shippingCreate.response.status, 201);
     assert.equal(typeof (shippingCreate.body as any)?.data, "string", "fixture shipping response must expose its owned ID");
     shippingRuleIds.push((shippingCreate.body as any).data);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/shipping/quote", { method: "POST", body: JSON.stringify({ countryCode: "DE", weightKg: 0.5 }) })).response.status, 200);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/shipping", { method: "POST", body: JSON.stringify({ countryCode: "DE", minWeightKg: 0.5, maxWeightKg: 1, amountEur: 5, temporary: true }) })).response.status, 409);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/shipping", { method: "POST", body: JSON.stringify({ countryCode: "DE", minWeightKg: 1, amountEur: 5, temporary: false }) })).response.status, 400);
     const expiredShipping = await adminClient.request("/admin/suppliers/toonies/shipping", { method: "POST", body: JSON.stringify({ countryCode: "FR", minWeightKg: 0, amountEur: 3, temporary: true, active: false, expiresAt: new Date(Date.now() - 1000).toISOString() }) });
     assert.equal(expiredShipping.response.status, 201);
     assert.equal(typeof (expiredShipping.body as any)?.data, "string", "fixture shipping response must expose its owned ID");
     shippingRuleIds.push((expiredShipping.body as any).data);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/shipping/quote", { method: "POST", body: JSON.stringify({ countryCode: "FR", weightKg: 0.2 }) })).body.data, null);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/catalogue/import", { method: "POST", body: JSON.stringify({ ids: [catalogue.id] }), headers: { "x-csrf-token": "invalid" } }, false)).response.status, 403);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/order/create", { method: "POST", body: "{}" })).response.status, 404);

    let approvalCalls = 0;
    const approvalClient = new TooniesClient({ app_key: "key", app_secret: "secret", transport: async () => { approvalCalls += 1; return { envelope: { status: false, code: 40006, msg: "pending", data: null } }; } });
    await assert.rejects(() => approvalClient.search({ keyword: "x" }), (error: unknown) => error instanceof TooniesError && error.code === 40006);
    await assert.rejects(() => approvalClient.search({ keyword: "x" }), (error: unknown) => error instanceof TooniesError && error.code === 40006);
    assert.equal(approvalCalls, 1);
    let retryCalls = 0;
    const retryClient = new TooniesClient({ app_key: "key", app_secret: "secret", transport: async () => { retryCalls += 1; return { envelope: { status: false, code: 42901, msg: "rate", data: null } }; } });
    await assert.rejects(() => retryClient.search({ keyword: "x" }), (error: unknown) => error instanceof TooniesError && error.code === 42901);
    await assert.rejects(() => retryClient.search({ keyword: "x" }), (error: unknown) => error instanceof TooniesError && error.code === 42901);
    assert.equal(retryCalls, 1);
    let timeoutCalls = 0;
    const timeoutClient = new TooniesClient({ app_key: "key", app_secret: "secret", timeoutMs: 100, transport: async () => { timeoutCalls += 1; const error = new Error("timeout"); error.name = "AbortError"; throw error; } });
    await assert.rejects(() => timeoutClient.search({ keyword: "x" }));
    assert.equal(timeoutCalls, 3);
    const failedPrecheck = new TooniesClient({ app_key: "key", app_secret: "secret", transport: async () => ({ envelope: { status: false, code: 40040, msg: "not ready", data: null } }) });
    await assert.rejects(() => failedPrecheck.precheck({
      client_task_no: `${marker}-failed`,
      items: [{ product_code: `${marker}-product`, sku_code: `${marker}-sku`, num: 1 }],
    }), (error: unknown) => error instanceof TooniesError && error.code === 40040);
  } finally {
    setFxProvider(undefined);
    setFxClock(undefined);
    setTooniesClient(undefined);
    const runningServer = server;
    if (runningServer) await new Promise<void>((resolve) => runningServer.close(() => resolve()));
     // Delete only records owned by this run. Never use a timestamp boundary
     // against the real Toonies supplier: concurrent business writes are not
     // test fixtures, even when they happen during this process.
    const cleanup = await pool.connect();
    try {
      await cleanup.query("BEGIN");
       const ownedCatalogue = "(catalogue_item_id=ANY($1::uuid[]) OR catalogue_item_id IN (SELECT id FROM supplier_catalogue_items WHERE supplier_id=$2 AND external_product_id LIKE $3))";
       await cleanup.query(`DELETE FROM audit_logs WHERE actor_admin_id=ANY($4::uuid[]) OR actor_user_id=ANY($4::uuid[])
         OR entity_id=ANY($5::uuid[]) OR entity_id IN (SELECT id FROM supplier_price_change_reviews WHERE ${ownedCatalogue})`,
       [catalogueIds, tooniesId, `${marker}%`, userIds, [...productIds, ...catalogueIds, ...shippingRuleIds]]);
       await cleanup.query("DELETE FROM supplier_shipping_rules WHERE id=ANY($1::uuid[])", [shippingRuleIds]);
       await cleanup.query("DELETE FROM supplier_precheck_snapshots WHERE supplier_id=$1 AND (task_id=$2 OR client_task_no LIKE $3)", [tooniesId, taskId, `${marker}%`]);
       await cleanup.query(`DELETE FROM supplier_price_change_reviews WHERE ${ownedCatalogue}`, [catalogueIds, tooniesId, `${marker}%`]);
       await cleanup.query(`DELETE FROM supplier_cost_price_history WHERE ${ownedCatalogue}`, [catalogueIds, tooniesId, `${marker}%`]);
       await cleanup.query(`DELETE FROM supplier_sync_history WHERE ${ownedCatalogue}`, [catalogueIds, tooniesId, `${marker}%`]);
       const ownedSyncRunIds = (await cleanup.query<{ id: string }>(`SELECT id FROM supplier_sync_runs WHERE supplier_id=$1 AND (
         keyword LIKE $2 OR id IN (
           SELECT n.supplier_sync_run_id
           FROM supplier_fx_normalization_runs n
           JOIN fx_rate_snapshots f ON f.id=n.fx_rate_snapshot_id
           WHERE n.supplier_id=$1 AND f.provider=$3 AND n.supplier_sync_run_id IS NOT NULL
         )
       )`, [tooniesId, `${marker}%`, fixtureFxProvider])).rows.map((row) => row.id);
       const ownedNormalizationRunIds = (await cleanup.query<{ id: string }>(`SELECT id FROM supplier_fx_normalization_runs WHERE supplier_id=$1 AND (
         fx_rate_snapshot_id IN (SELECT id FROM fx_rate_snapshots WHERE provider=$2)
         OR supplier_sync_run_id=ANY($3::uuid[])
       )`, [tooniesId, fixtureFxProvider, ownedSyncRunIds])).rows.map((row) => row.id);
       await cleanup.query("DELETE FROM supplier_fx_normalization_runs WHERE id=ANY($1::uuid[])", [ownedNormalizationRunIds]);
       await cleanup.query("DELETE FROM supplier_sync_runs WHERE id=ANY($1::uuid[])", [ownedSyncRunIds]);
       await cleanup.query(`DELETE FROM supplier_product_links WHERE ${ownedCatalogue}`, [catalogueIds, tooniesId, `${marker}%`]);
       await cleanup.query(`DELETE FROM supplier_import_records WHERE ${ownedCatalogue}`, [catalogueIds, tooniesId, `${marker}%`]);
       await cleanup.query("DELETE FROM supplier_catalogue_variants WHERE supplier_id=$1 AND (id=ANY($2::uuid[]) OR catalogue_item_id=ANY($3::uuid[]) OR catalogue_item_id IN (SELECT id FROM supplier_catalogue_items WHERE supplier_id=$1 AND external_product_id LIKE $4))", [tooniesId, variantIds, catalogueIds, `${marker}%`]);
       await cleanup.query("DELETE FROM supplier_catalogue_items WHERE supplier_id=$1 AND (id=ANY($2::uuid[]) OR external_product_id LIKE $3)", [tooniesId, catalogueIds, `${marker}%`]);
       await cleanup.query("DELETE FROM supplier_category_mappings WHERE id=ANY($1::uuid[]) OR (supplier_id=$2 AND external_category_id LIKE $3)", [mappingIds, tooniesId, `${marker}%`]);
      await cleanup.query("DELETE FROM supplier_pricing_rules WHERE supplier_id=ANY($1::uuid[])", [supplierIds.filter((id) => id !== tooniesId)]);
      await cleanup.query("DELETE FROM suppliers WHERE id=ANY($1::uuid[])", [supplierIds.filter((id) => id !== tooniesId)]);
      await cleanup.query("DELETE FROM admin_user_roles WHERE user_id=ANY($1::uuid[])", [userIds]);
      await cleanup.query("DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])", [userIds]);
      await cleanup.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
      await cleanup.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [roleIds]);
       await cleanup.query("DELETE FROM product_variants WHERE product_id=ANY($1::uuid[]) OR product_id IN (SELECT id FROM products WHERE parent_sku LIKE $2)", [productIds, `TOONIES-${marker}%`]);
       await cleanup.query("DELETE FROM products WHERE id=ANY($1::uuid[]) OR parent_sku LIKE $2", [productIds, `TOONIES-${marker}%`]);
       await cleanup.query("DELETE FROM fx_rate_snapshots WHERE provider=$1", [fixtureFxProvider]);
      await cleanup.query("DELETE FROM categories WHERE id=ANY($1::uuid[])", [categoryIds]);
       assert.equal((await cleanup.query("SELECT count(*)::int AS count FROM products WHERE id=$1", [businessSentinelId])).rows[0].count, 1, "legitimate business sentinel must survive fixture cleanup");
      const residue = await cleanup.query("SELECT count(*)::int AS count FROM products WHERE name LIKE $1 OR parent_sku LIKE $1", [`%${marker}%`]);
      assert.equal(residue.rows[0].count, 0, "Toonies integration fixtures must leave no product residue");
      const residueChecks = [
        await cleanup.query("SELECT count(*)::int AS count FROM users WHERE email LIKE $1", [`%${marker}%`]),
        await cleanup.query("SELECT count(*)::int AS count FROM admin_roles WHERE name LIKE $1", [`%${marker}%`]),
        await cleanup.query("SELECT count(*)::int AS count FROM suppliers WHERE slug LIKE $1", [`%${marker}%`]),
        await cleanup.query("SELECT count(*)::int AS count FROM supplier_catalogue_items WHERE external_product_id LIKE $1", [`%${marker}%`]),
         await cleanup.query("SELECT count(*)::int AS count FROM supplier_sync_runs WHERE id=ANY($1::uuid[])", [ownedSyncRunIds]),
         await cleanup.query("SELECT count(*)::int AS count FROM supplier_fx_normalization_runs WHERE id=ANY($1::uuid[])", [ownedNormalizationRunIds]),
      ];
      assert.ok(residueChecks.every((result) => result.rows[0].count === 0), "Toonies integration fixtures must leave no residue");
       await cleanup.query("DELETE FROM products WHERE id=$1", [businessSentinelId]);
       await cleanup.query("COMMIT");
    } catch (error) {
      await cleanup.query("ROLLBACK");
      if (businessSentinelId) await cleanup.query("DELETE FROM products WHERE id=$1", [businessSentinelId]);
      throw error;
    } finally {
      cleanup.release();
      await closeDatabase();
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});