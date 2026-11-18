import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { replaceTiers } from "../pricing/service.js";
import { homepageProducts, homepageProductsSql } from "./service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `homepage-merch-${suffix}`;
const fixtureOrderNumber = `HM-${suffix.slice(-32)}`;

async function request(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/v1/storefront/homepage-products`);
  return { response, body: await response.json() };
}

async function run() {
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let categoryId = "";
  let warehouseId = "";
  const db: any = pool;
  const originalQuery = db.query.bind(pool);
  try {
    categoryId = (await pool.query(
      "INSERT INTO categories (name,slug,description) VALUES ($1,$2,'Homepage test category') RETURNING id",
      [`${marker} category`, `${marker}-category`],
    )).rows[0].id;
    warehouseId = (await pool.query(
      "INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id",
      [`${marker} warehouse`, suffix.slice(-32)],
    )).rows[0].id;

    // The merchandise fixtures are deliberately small and named; the large
    // catalog below is inserted separately with generate_series.
    await pool.query(
      `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at,featured)
       SELECT $1 || n, $2 || '-best-' || n, $3 || '-best-' || n, $4, 'Public', 10, 100, 19, 1, 'active', now(), true
         FROM generate_series(1,6) n`,
      [`${marker} best `, marker, marker, categoryId],
    );
    await pool.query(
      `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at,homepage_wholesale)
       SELECT $1 || n, $2 || '-wholesale-' || n, $3 || '-wholesale-' || n, $4, 'Public', 10, 100, 19, 1, 'active', now(), true
         FROM generate_series(1,4) n`,
      [`${marker} wholesale `, marker, marker, categoryId],
    );
    // Explicitly selected but ineligible records prove publication/status and
    // stock eligibility is enforced by the candidate SQL, not the client.
    await pool.query(
      `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at,featured,homepage_wholesale)
       VALUES
        ($1,$2,$3,$4,'Hidden',1,10,19,1,'inactive',now(),true,true),
        ($5,$6,$7,$4,'Unpublished',1,10,19,1,'active',NULL,true,true),
        ($8,$9,$10,$4,'Zero stock',1,10,19,1,'active',now(),true,true)`,
      [`${marker} inactive`, `${marker}-inactive`, `${marker}-inactive-sku`, categoryId,
        `${marker} unpublished`, `${marker}-unpublished`, `${marker}-unpublished-sku`,
        `${marker} zero`, `${marker}-zero`, `${marker}-zero-sku`],
    );
    await pool.query(
      `INSERT INTO inventory (warehouse_id,product_id,quantity_on_hand)
       SELECT $1, id, CASE WHEN slug=$2 THEN 2 ELSE 20 END
         FROM products
        WHERE category_id=$3 AND slug LIKE $4
          AND slug NOT IN ($5, $6, $7)`,
      [warehouseId, `${marker}-best-1`, categoryId, `${marker}-%`, `${marker}-wholesale-2`, `${marker}-zero`, `${marker}-unpublished`],
    );
    const variantId = (await pool.query(
      `INSERT INTO product_variants (product_id,sku,title,base_price,active)
       SELECT id,$1,'Live variant',NULL,true FROM products WHERE slug=$2 RETURNING id`,
      [`${marker}-variant-offer`, `${marker}-wholesale-2`],
    )).rows[0].id;
    await pool.query("INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand) VALUES ($1,$2,9)", [warehouseId, variantId]);
    await pool.query(
      `INSERT INTO price_tiers (product_id,min_quantity,max_quantity,unit_price,active)
       SELECT id,10,NULL,80,true FROM products WHERE slug LIKE $1 AND slug <> $2`,
      [`${marker}-wholesale-%`, `${marker}-wholesale-2`],
    );
    await pool.query(
      "INSERT INTO price_tiers (product_id,min_quantity,max_quantity,unit_price,active) SELECT id,1,9,91,true FROM products WHERE slug=$1",
      [`${marker}-best-1`],
    );
    await pool.query("INSERT INTO price_tiers (variant_id,min_quantity,max_quantity,unit_price,active) VALUES ($1,5,NULL,70,true)", [variantId]);
    // Two active campaigns force evaluatePromotions through its grouped usage
    // lookup; the anonymous request must still be one homepage query plus the
    // campaign and grouped-usage queries, never one usage query per campaign.
    await pool.query(
      `WITH campaigns AS (
         INSERT INTO promotion_campaigns (name,start_at,promotion_type,discount_type,discount_value,automatic,active)
         VALUES ($1,now()-interval '1 minute','order','percentage',1,true,true),
                ($2,now()-interval '1 minute','order','percentage',2,true,true)
         RETURNING id
       ), fixture_order AS (
         INSERT INTO orders (order_number,guest_email,subtotal,grand_total,billing_address_snapshot,shipping_address_snapshot)
         VALUES ($3,$4,1,1,'{}'::jsonb,'{}'::jsonb) RETURNING id
       )
       INSERT INTO promotion_usages (campaign_id,order_id,guest_session_id,discount_amount)
       SELECT campaigns.id,fixture_order.id,$5,0 FROM campaigns CROSS JOIN fixture_order`,
      [`${marker} campaign one`, `${marker} campaign two`, fixtureOrderNumber, `${marker}@example.test`, `${marker}-guest`],
    );

    // homepageProducts is the data-access boundary: it must remain one query.
    let queryCount = 0;
    db.query = (...args: any[]) => { queryCount += 1; return originalQuery(...args); };
    const direct = await homepageProducts();
    assert.equal(queryCount, 1);
    assert.equal(direct.bestSellers.length, 6);
    assert.equal(direct.liveWholesalePricing.length, 4);
    assert.equal(direct.bestSellers.find((item) => item.slug === `${marker}-best-1`)?.price, 91);
    assert.equal(direct.bestSellers.find((item) => item.slug === `${marker}-best-1`)?.availability, "low_stock");
    assert.deepEqual(direct.liveWholesalePricing.find((item) => item.slug === `${marker}-wholesale-1`)?.homepageWholesaleOffer, { minQuantity: 10, unitPrice: 80, additionalQuantity: 9 });
    assert.deepEqual(direct.liveWholesalePricing.find((item) => item.slug === `${marker}-wholesale-2`)?.homepageWholesaleOffer, { minQuantity: 5, unitPrice: 70, additionalQuantity: 4 });
    const wholesaleOneId = (await originalQuery("SELECT id FROM products WHERE slug=$1", [`${marker}-wholesale-1`])).rows[0]!.id as string;
    await replaceTiers(wholesaleOneId, null, []);
    const withoutTiers = await homepageProducts();
    assert.equal(withoutTiers.liveWholesalePricing.some((item) => item.id === wholesaleOneId), false, "removing all tiers must remove the product from the wholesale rail");
    await replaceTiers(wholesaleOneId, null, [{ minQuantity: 10, maxQuantity: null, unitPrice: 80, active: true }]);

    const measuredRequest = async () => {
      queryCount = 0;
      const result = await request(baseUrl);
      return { result, queries: queryCount };
    };
    const before = await measuredRequest();
    assert.equal(before.result.response.status, 200);
    assert.equal(before.result.body.data.bestSellers.length, 6);
    assert.equal(before.result.body.data.liveWholesalePricing.length, 4);
    assert.equal("costPrice" in before.result.body.data.bestSellers[0], false);
    assert.equal("margin" in before.result.body.data.bestSellers[0], false);
    assert.equal("warehouseId" in before.result.body.data.bestSellers[0], false);
    const visible = JSON.stringify(before.result.body.data);
    assert.equal(visible.includes(`${marker}-inactive`), false);
    assert.equal(visible.includes(`${marker}-unpublished`), false);
    assert.equal(visible.includes(`${marker}-zero`), false);

    // One set-based insert creates a realistically large explicitly
    // merchandised but stock-ineligible catalog; no fixture loop can hide
    // pre-limit eligibility fanout here.
    await originalQuery(
      `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at,featured,homepage_wholesale)
       SELECT $1 || n, $2 || '-bulk-' || n, $3 || '-bulk-' || n, $4, 'Bulk', 1, 10, 19, 1, 'active', now(), true, true
         FROM generate_series(1,5000) n`,
      [`${marker} bulk `, marker, marker, categoryId],
    );
    const after = await measuredRequest();
    assert.equal(after.result.response.status, 200);
    assert.equal(after.result.body.data.bestSellers.length, 6);
    assert.equal(after.result.body.data.liveWholesalePricing.length, 4);
    assert.equal(before.queries, 3, `anonymous endpoint must use homepage, campaign, and grouped-usage queries only; received ${before.queries}`);
    assert.equal(after.queries, before.queries, "HTTP endpoint query count must not grow with catalog size");
    const explain = await originalQuery(`EXPLAIN (FORMAT JSON) ${homepageProductsSql}`);
    const planRoot = explain.rows[0]?.["QUERY PLAN"] ?? explain.rows[0];
    const plan = JSON.stringify(planRoot);
    const nonCteSubplans: string[] = [];
    const inspectPlan = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(inspectPlan);
        return;
      }
      const node = value as Record<string, unknown>;
      const subplanName = node["Subplan Name"];
      if (typeof subplanName === "string" && !subplanName.startsWith("CTE ")) nonCteSubplans.push(subplanName);
      Object.values(node).forEach(inspectPlan);
    };
    inspectPlan(planRoot);
    assert.deepEqual(nonCteSubplans, [], "candidate query must not execute correlated non-CTE SubPlans");
    console.log(`Homepage candidate plan partial-index mention: ${/products_(featured|homepage_wholesale)_public_homepage_idx/.test(plan)}`);
    console.log(`Homepage merchandising performance integration passed (${before.queries} endpoint queries).`);
  } finally {
    db.query = originalQuery;
    await pool.query("DELETE FROM promotion_campaigns WHERE name LIKE $1", [`${marker}%`]).catch(() => undefined);
    await pool.query("DELETE FROM orders WHERE order_number=$1", [fixtureOrderNumber]).catch(() => undefined);
    await pool.query("DELETE FROM products WHERE category_id=$1", [categoryId]).catch(() => undefined);
    await pool.query("DELETE FROM warehouses WHERE id=$1", [warehouseId]).catch(() => undefined);
    await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});