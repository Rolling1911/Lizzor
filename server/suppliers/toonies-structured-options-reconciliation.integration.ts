import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";
import { reconcileLinkedCatalogueStructuredOptions } from "./toonies-service.js";

const marker = `toonies-options-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = "TooniesOptionsIntegration1";

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
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  }
}

async function run(): Promise<void> {
  assertMutableIntegrationTestDatabase("Toonies structured-option reconciliation");
  const pool = getDatabasePool();
  let server: Server | undefined;
  const owned = {
    users: [] as string[],
    roles: [] as string[],
    suppliers: [] as string[],
    catalogue: [] as string[],
    catalogueVariants: [] as string[],
    products: [] as string[],
  };
  let createdAttributeId: string | null = null;
  let createdValueIds: string[] = [];
  try {
    const toonies = (await pool.query<{ id: string }>("SELECT id FROM suppliers WHERE slug='toonies'")).rows[0]!;
    const warehouse = (await pool.query<{ id: string }>("SELECT id FROM warehouses WHERE code='TOONIES'")).rows[0]!;
    const category = (await pool.query<{ id: string }>("SELECT id FROM categories WHERE parent_id IS NULL AND active=true ORDER BY sort_order,id LIMIT 1")).rows[0]!;
    assert.ok(toonies && warehouse && category, "canonical Toonies references and a category are required");

    const existingAttribute = (await pool.query<{ id: string }>("SELECT id FROM product_attributes WHERE slug='specifications'")).rows[0]?.id ?? null;
    const existingValues = (await pool.query<{ id: string }>(
      `SELECT av.id FROM attribute_values av JOIN product_attributes pa ON pa.id=av.attribute_id
        WHERE pa.slug='specifications' AND av.value=ANY($1::text[])`,
      [["plastic handle", "Stainless steel handle"]],
    )).rows.map((row) => row.id);

    const otherSupplier = (await pool.query<{ id: string }>(
      "INSERT INTO suppliers(name,slug,active) VALUES($1,$2,true) RETURNING id",
      [`${marker} Other`, `${marker}-other`],
    )).rows[0]!.id;
    owned.suppliers.push(otherSupplier);
    const otherCatalogue = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_catalogue_items
        (supplier_id,external_product_id,external_category_id,title,original_amount,original_currency,stock)
       VALUES($1,$2,$3,$4,1,'CNY',1) RETURNING id`,
      [otherSupplier, `${marker}-other`, `${marker}-other-category`, `${marker} Other`],
    )).rows[0]!.id;
    owned.catalogue.push(otherCatalogue);

    const catalogueItem = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_catalogue_items
        (supplier_id,external_product_id,external_category_id,title,original_amount,original_currency,
         normalized_eur,normalized_currency,minimum_order_quantity,stock,state,needs_review)
       VALUES($1,$2,$3,$4,0.49,'CNY',0.49,'EUR',2,73483,'Synced',false)
       RETURNING id`,
      [toonies.id, `${marker}-pepper`, `${marker}-category`, `${marker} Pepper`],
    )).rows[0]!.id;
    owned.catalogue.push(catalogueItem);
    const supplierVariants = (await pool.query<{ id: string; sku: string }>(
      `INSERT INTO supplier_catalogue_variants
        (supplier_id,catalogue_item_id,external_variant_id,sku_code,title,attributes,
         original_amount,original_currency,normalized_eur,normalized_currency,
         minimum_order_quantity,weight_kg,stock,state,needs_review)
       VALUES
        ($1,$2,$3,$3,'Specifications:plastic handle',
         '[{"name":"Specifications","value":"plastic handle"}]'::jsonb,
         0.49,'CNY',0.49,'EUR',2,0.25,73483,'Needs review',true),
        ($1,$2,$4,$4,'Specifications:Stainless steel handle',
         '[{"name":"Specifications","value":"Stainless steel handle"}]'::jsonb,
         0.49,'CNY',0.49,'EUR',2,0.25,0,'Needs review',true)
       RETURNING id,sku_code AS sku`,
      [toonies.id, catalogueItem, `${marker}-plastic`, `${marker}-stainless`],
    )).rows;
    owned.catalogueVariants.push(...supplierVariants.map((row) => row.id));

    const product = (await pool.query<{ id: string }>(
      `INSERT INTO products
        (name,slug,parent_sku,category_id,description,status,cost_price,base_price,vat_rate,
         vat_classified_at,weight,minimum_order_quantity,published_at)
       VALUES($1::text,$2,$3,$4,$1::text,'draft',0.49,0.98,0,NULL,0,2,NULL)
       RETURNING id`,
      [`${marker} Pepper`, `${marker}-pepper`, `TOONIES-${marker}-pepper`, category.id],
    )).rows[0]!.id;
    owned.products.push(product);
    const variants = (await pool.query<{ id: string; sku: string }>(
      `INSERT INTO product_variants
        (product_id,sku,title,cost_price,base_price,weight,minimum_order_quantity,active)
       VALUES
        ($1,$2,'Specifications:plastic handle',0.49,0.98,0.25,2,false),
        ($1,$3,'Specifications:Stainless steel handle',0.49,0.98,0.25,2,false)
       RETURNING id,sku`,
      [product, `TOONIES-${supplierVariants[0]!.sku}`, `TOONIES-${supplierVariants[1]!.sku}`],
    )).rows;
    await pool.query(
      `INSERT INTO inventory(warehouse_id,variant_id,quantity_on_hand,quantity_reserved,active)
       VALUES($1,$2,73483,0,false),($1,$3,0,0,false)`,
      [warehouse.id, variants[0]!.id, variants[1]!.id],
    );
    await pool.query(
      `INSERT INTO supplier_product_links
        (supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id)
       VALUES($1,$2,NULL,$3,NULL),($1,$2,$4,$3,$5),($1,$2,$6,$3,$7)`,
      [toonies.id, catalogueItem, product, supplierVariants[0]!.id, variants[0]!.id, supplierVariants[1]!.id, variants[1]!.id],
    );

    const unrelatedProduct = (await pool.query<{ id: string }>(
      `INSERT INTO products(name,slug,parent_sku,category_id,description,status,cost_price,base_price,vat_rate,weight)
       VALUES($1::text,$2,$3,$4,$1::text,'draft',1,2,0,0) RETURNING id`,
      [`${marker} Unrelated`, `${marker}-unrelated`, `${marker}-unrelated`, category.id],
    )).rows[0]!.id;
    owned.products.push(unrelatedProduct);

    const app = await createApp({ serveFrontend: false });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const role = (await pool.query<{ id: string }>("INSERT INTO admin_roles(name) VALUES($1) RETURNING id", [`${marker} admin`])).rows[0]!.id;
    const viewerRole = (await pool.query<{ id: string }>("INSERT INTO admin_roles(name) VALUES($1) RETURNING id", [`${marker} viewer`])).rows[0]!.id;
    owned.roles.push(role, viewerRole);
    const passwordHash = await hashPassword(password);
    const admin = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,'Option','Admin','active',now()) RETURNING id",
      [`${marker}-admin@example.test`, passwordHash],
    )).rows[0]!.id;
    const viewer = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,'Option','Viewer','active',now()) RETURNING id",
      [`${marker}-viewer@example.test`, passwordHash],
    )).rows[0]!.id;
    owned.users.push(admin, viewer);
    await pool.query("INSERT INTO admin_user_roles(user_id,role_id) VALUES($1,$2),($3,$4)", [admin, role, viewer, viewerRole]);
    await pool.query(
      "INSERT INTO admin_role_permissions(role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key=ANY($2::text[])",
      [role, ["supplier_integrations.view", "supplier_integrations.sync"]],
    );
    await pool.query(
      "INSERT INTO admin_role_permissions(role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key='supplier_integrations.view'",
      [viewerRole],
    );
    const adminClient = new Client(baseUrl);
    const viewerClient = new Client(baseUrl);
    await adminClient.request("/auth/me");
    await viewerClient.request("/auth/me");
    assert.equal((await adminClient.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `${marker}-admin@example.test`, password }) })).response.status, 200);
    assert.equal((await viewerClient.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `${marker}-viewer@example.test`, password }) })).response.status, 200);

    const path = `/admin/suppliers/toonies/catalogue/${catalogueItem}/reconcile-structured-options`;
    const body = JSON.stringify({ productId: product });
    assert.equal((await new Client(baseUrl).request(path, { method: "POST", body })).response.status, 403);
    assert.equal((await viewerClient.request(path, { method: "POST", body })).response.status, 403);
    assert.equal((await adminClient.request("/admin/suppliers/toonies/catalogue/not-a-uuid/reconcile-structured-options", { method: "POST", body })).response.status, 400);
    assert.equal((await adminClient.request(path, { method: "POST", body: JSON.stringify({ productId: "not-a-uuid" }) })).response.status, 400);
    assert.equal((await adminClient.request(path, { method: "POST", body, headers: { "x-csrf-token": "invalid" } }, false)).response.status, 403);
    assert.equal((await adminClient.request(`/admin/suppliers/toonies/catalogue/${otherCatalogue}/reconcile-structured-options`, { method: "POST", body })).response.status, 404);
    assert.equal((await adminClient.request(path, { method: "POST", body: JSON.stringify({ productId: unrelatedProduct }) })).response.status, 404);

    await pool.query("UPDATE product_variants SET sku=$1 WHERE id=$2", [`${marker}-wrong-sku`, variants[0]!.id]);
    const mismatchedIdentity = await adminClient.request(path, { method: "POST", body });
    assert.equal(mismatchedIdentity.response.status, 409);
    assert.equal((mismatchedIdentity.body as any).error.code, "SUPPLIER_VARIANT_IDENTITY_MISMATCH");
    await pool.query("UPDATE product_variants SET sku=$1 WHERE id=$2", [`TOONIES-${supplierVariants[0]!.sku}`, variants[0]!.id]);
    await pool.query(
      "DELETE FROM supplier_product_links WHERE supplier_id=$1 AND catalogue_item_id=$2 AND product_id=$3 AND variant_id IS NULL",
      [toonies.id, catalogueItem, product],
    );
    const missingParentLink = await adminClient.request(path, { method: "POST", body });
    assert.equal(missingParentLink.response.status, 409);
    assert.equal((missingParentLink.body as any).error.code, "SUPPLIER_PARENT_LINK_INVALID");
    await pool.query(
      "INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,product_id) VALUES($1,$2,$3)",
      [toonies.id, catalogueItem, product],
    );

    const concurrent = await Promise.all([
      adminClient.request(path, { method: "POST", body }),
      adminClient.request(path, { method: "POST", body }),
    ]);
    assert.equal(concurrent.every((response) => response.response.status === 200), true);
    assert.deepEqual(concurrent.map((response) => (response.body as any).data.result.relationshipsCreated).sort(), [0, 2]);
    const created = concurrent.find((response) => (response.body as any).data.result.relationshipsCreated === 2)!;
    assert.deepEqual((created.body as any).data.result, {
      variantsReconciled: 2,
      relationshipsBefore: 0,
      relationshipsAfter: 2,
      relationshipsCreated: 2,
      relationshipsReplaced: 0,
      relationshipsUnchanged: 0,
    });
    const repeated = await adminClient.request(path, { method: "POST", body });
    assert.equal(repeated.response.status, 200);
    assert.deepEqual((repeated.body as any).data.result, {
      variantsReconciled: 2,
      relationshipsBefore: 2,
      relationshipsAfter: 2,
      relationshipsCreated: 0,
      relationshipsReplaced: 0,
      relationshipsUnchanged: 2,
    });

    const state = (await pool.query<any>(
      `SELECT p.status,p.published_at,p.vat_classified_at,
        (SELECT count(*)::int FROM product_variants WHERE product_id=p.id) AS variants,
        (SELECT count(*)::int FROM variant_attribute_values vav JOIN product_variants pv ON pv.id=vav.variant_id WHERE pv.product_id=p.id) AS options,
        (SELECT count(DISTINCT pa.id)::int FROM product_attributes pa JOIN variant_attribute_values vav ON vav.attribute_id=pa.id JOIN product_variants pv ON pv.id=vav.variant_id WHERE pv.product_id=p.id AND pa.name='Specifications') AS attributes,
        (SELECT count(DISTINCT av.id)::int FROM attribute_values av JOIN variant_attribute_values vav ON vav.attribute_value_id=av.id JOIN product_variants pv ON pv.id=vav.variant_id WHERE pv.product_id=p.id) AS values,
        (SELECT count(*)::int FROM product_variants WHERE product_id=p.id AND active) AS active_variants,
        (SELECT count(*)::int FROM inventory i JOIN product_variants pv ON pv.id=i.variant_id WHERE pv.product_id=p.id AND i.active) AS active_inventory,
        (SELECT array_agg(pv.base_price::text ORDER BY pv.sku) FROM product_variants pv WHERE pv.product_id=p.id) AS prices,
        (SELECT array_agg(i.quantity_on_hand::text ORDER BY i.quantity_on_hand DESC) FROM inventory i JOIN product_variants pv ON pv.id=i.variant_id WHERE pv.product_id=p.id) AS stocks
       FROM products p WHERE p.id=$1`,
      [product],
    )).rows[0];
    assert.deepEqual(state, {
      status: "draft",
      published_at: null,
      vat_classified_at: null,
      variants: 2,
      options: 2,
      attributes: 1,
      values: 2,
      active_variants: 0,
      active_inventory: 0,
      prices: ["0.98", "0.98"],
      stocks: ["73483", "0"],
    });
    const links = (await pool.query<any>(
      `SELECT pv.sku,scv.sku_code,av.value
         FROM supplier_product_links l
         JOIN product_variants pv ON pv.id=l.variant_id
         JOIN supplier_catalogue_variants scv ON scv.id=l.catalogue_variant_id
         JOIN variant_attribute_values vav ON vav.variant_id=pv.id
         JOIN attribute_values av ON av.id=vav.attribute_value_id
        WHERE l.catalogue_item_id=$1 ORDER BY scv.stock DESC`,
      [catalogueItem],
    )).rows;
    assert.deepEqual(links.map((row: any) => [row.sku, row.sku_code, row.value]), [
      [`TOONIES-${marker}-plastic`, `${marker}-plastic`, "plastic handle"],
      [`TOONIES-${marker}-stainless`, `${marker}-stainless`, "Stainless steel handle"],
    ]);
    const audits = (await pool.query<any>(
      "SELECT actor_admin_id,new_values_json FROM audit_logs WHERE action='supplier.catalogue_structured_options.reconciled' AND entity_id=$1 ORDER BY created_at",
      [catalogueItem],
    )).rows;
    assert.equal(audits.length, 3);
    assert.equal(audits.every((row: any) => row.actor_admin_id === admin), true);
    assert.deepEqual(audits.map((row: any) => row.new_values_json.result.relationshipsCreated).sort(), [0, 0, 2]);
    assert.equal(audits.every((row: any) => row.new_values_json.productId === product), true);
    assert.equal(audits.every((row: any) => row.new_values_json.catalogueItemId === catalogueItem), true);

    await pool.query("DELETE FROM variant_attribute_values WHERE variant_id=ANY($1::uuid[])", [variants.map((variant) => variant.id)]);
    const auditsBeforeRollback = audits.length;
    await assert.rejects(reconcileLinkedCatalogueStructuredOptions({
      catalogueItemId: catalogueItem,
      productId: product,
      actorAdminId: randomUUID(),
    }));
    assert.equal(Number((await pool.query(
      "SELECT count(*) FROM variant_attribute_values WHERE variant_id=ANY($1::uuid[])",
      [variants.map((variant) => variant.id)],
    )).rows[0].count), 0, "audit failure must roll back option changes");
    assert.equal(Number((await pool.query(
      "SELECT count(*) FROM audit_logs WHERE action='supplier.catalogue_structured_options.reconciled' AND entity_id=$1",
      [catalogueItem],
    )).rows[0].count), auditsBeforeRollback, "failed reconciliation must not create an audit row");

    const attribute = (await pool.query<{ id: string }>("SELECT id FROM product_attributes WHERE slug='specifications'")).rows[0]?.id ?? null;
    if (!existingAttribute) createdAttributeId = attribute;
    createdValueIds = (await pool.query<{ id: string }>(
      `SELECT av.id FROM attribute_values av JOIN product_attributes pa ON pa.id=av.attribute_id
        WHERE pa.slug='specifications' AND av.value=ANY($1::text[]) AND NOT (av.id=ANY($2::uuid[]))`,
      [["plastic handle", "Stainless steel handle"], existingValues],
    )).rows.map((row) => row.id);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    const cleanup = await pool.connect();
    try {
      await cleanup.query("BEGIN");
      await cleanup.query("DELETE FROM audit_logs WHERE actor_admin_id=ANY($1::uuid[]) OR entity_id=ANY($2::uuid[])", [owned.users, owned.catalogue]);
      await cleanup.query("DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])", [owned.users]);
      await cleanup.query("DELETE FROM admin_user_roles WHERE user_id=ANY($1::uuid[])", [owned.users]);
      await cleanup.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [owned.users]);
      await cleanup.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [owned.roles]);
      await cleanup.query("DELETE FROM supplier_product_links WHERE catalogue_item_id=ANY($1::uuid[])", [owned.catalogue]);
      await cleanup.query("DELETE FROM inventory WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id=ANY($1::uuid[]))", [owned.products]);
      await cleanup.query("DELETE FROM product_variants WHERE product_id=ANY($1::uuid[])", [owned.products]);
      await cleanup.query("DELETE FROM products WHERE id=ANY($1::uuid[])", [owned.products]);
      await cleanup.query("DELETE FROM supplier_catalogue_variants WHERE id=ANY($1::uuid[])", [owned.catalogueVariants]);
      await cleanup.query("DELETE FROM supplier_catalogue_items WHERE id=ANY($1::uuid[])", [owned.catalogue]);
      await cleanup.query("DELETE FROM suppliers WHERE id=ANY($1::uuid[])", [owned.suppliers]);
      await cleanup.query("DELETE FROM attribute_values WHERE id=ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM variant_attribute_values WHERE attribute_value_id=attribute_values.id)", [createdValueIds]);
      if (createdAttributeId) {
        await cleanup.query("DELETE FROM product_attributes WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM attribute_values WHERE attribute_id=product_attributes.id)", [createdAttributeId]);
      }
      await cleanup.query("COMMIT");
    } catch (error) {
      await cleanup.query("ROLLBACK");
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