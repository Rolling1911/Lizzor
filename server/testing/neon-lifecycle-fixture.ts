import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withDisposableNeonBranch } from "./neon-branch-harness.js";

type Db = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> };

const marker = `neon-lifecycle-${randomUUID().replaceAll("-", "")}`;
const address = {
  firstName: "Neon", lastName: "Fixture", addressLine1: "1 Test Street",
  province: "Leinster", city: "Dublin", postalCode: "D01", countryCode: "IE",
  phone: "+3531000000",
};

/**
 * Creates an order through the public cart, checkout, payment and webhook
 * services, then drives the real procurement worker to READY/confirmed.
 *
 * Keeping this in one helper is important for the race fixtures: every race
 * starts from an authentic paid order and procurement command rather than
 * manufacturing financial or settlement state in SQL.
 */
export async function createPaidReadyOrder(
  pool: Db,
  productId: string,
  variantId: string,
  suffix: string,
  options: { outcome?: "ready" | { reasonCode: string }; supplierProductCode?: string; supplierSkuCode?: string } = {},
): Promise<{ orderId: string; paymentId: string; attemptId: string; transport: any }> {
  const diagnostic = (message: string) => {
    if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") console.info(`Lifecycle fixture ${suffix}: ${message}`);
  };
  const { addItem } = await import("../cart/service.js");
  const session = `${marker}-${suffix}-session`;
  await addItem({ guestSessionId: session }, { productId, variantId, quantity: 1 });
  diagnostic("cart created");
  const { createOrder } = await import("../orders/service.js");
  const created = await createOrder({ guestSessionId: session }, {
    email: `${marker}-${suffix}@example.test`, billingAddress: address, shippingAddress: address,
    idempotencyKey: `${marker}-${suffix}-checkout`,
  });
  diagnostic("order created");
  const orderId = created.order.id;
  const { createPayment, handleWebhook } = await import("../payments/service.js");
  const payment = await createPayment(orderId, { guestSessionId: session, guestAccessToken: created.guestAccessToken }, `${marker}-${suffix}-payment`);
  diagnostic("payment created");
  const event = Buffer.from(JSON.stringify({
    id: `${marker}-${suffix}-payment-event`, type: "payment_intent.succeeded",
    data: { object: { id: payment.payment.providerPaymentId, status: "succeeded", amount_received: Math.round(payment.payment.amount * 100), currency: "eur", metadata: { order_id: orderId } } },
  }));
  await handleWebhook(event, "test-signature");
  diagnostic("webhook finalized");
  if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") {
    const stats = pool as any;
    console.info(`Lifecycle fixture ${suffix}: pool total=${stats.totalCount ?? "?"} idle=${stats.idleCount ?? "?"} waiting=${stats.waitingCount ?? "?"}`);
  }
  assert.ok((await pool.query("SELECT id FROM toonies_procurement_commands WHERE order_id=$1", [orderId])).rows[0], "payment finalization did not create procurement command");

  const { TooniesClient, TooniesFixtureTransport } = await import("../suppliers/toonies.js");
  const { setTooniesClient } = await import("../suppliers/toonies-service.js");
  const taskId = `task-${randomUUID().slice(0, 12)}`;
  const outcome = options.outcome ?? "ready";
  const failed = typeof outcome === "object";
  const supplierFailure = failed
    ? { definitive: true, reasonCode: outcome.reasonCode }
    : undefined;
  const transport = new TooniesFixtureTransport({
    "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: taskId, status: "pending", item_count: 1 } },
    "/v1/order/task": { status: true, code: 200, msg: failed ? "supplier rejected basket" : "ok", data: {
      task_id: taskId, status: failed ? "failed" : "ready", item_count: 1, ok_count: failed ? 0 : 1,
      date_expire: Math.floor(Date.now() / 1000) + 900,
      ...(supplierFailure ? { supplierFailure } : {}),
       items: [{ product_code: options.supplierProductCode ?? `${marker}-item`, sku_code: options.supplierSkuCode ?? `${marker}-sku`, num: 1, ok: !failed, fail_code: failed ? 40010 : undefined, moq: 1, stock: failed ? 0 : 20, charge: "7.8", subtotal: "7.8", weight: ".2" }],
    } },
  });
  const fixtureRequest = async (input: Parameters<typeof transport.request>[0]) => {
    if (input.path !== "/v1/order/create") return transport.request(input);
    transport.requests.push({ path: input.path, body: Buffer.from(input.body), headers: { ...input.headers } });
    const request = JSON.parse(input.body.toString("utf8")) as { api_order_sn: string };
    return { envelope: { status: true, code: 200, msg: "created", data: {
      order_sn: `${marker}-${suffix}-supplier-order`, api_order_sn: request.api_order_sn,
      currency: "CNY", product_sum: "7.8", shipping_fee: "0", sum: "7.8",
      status: "paid", pay_status: "paid",
       items: [{ product_code: options.supplierProductCode ?? `${marker}-item`, sku_code: options.supplierSkuCode ?? `${marker}-sku`, num: 1 }],
    } } };
  };
  setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: fixtureRequest, nonce: () => "fixture", now: () => 1700000000 }));
  const { runTooniesProcurementPollingCycle, getTooniesProcurementAttempt } = await import("../suppliers/toonies-procurement-service.js");
  await runTooniesProcurementPollingCycle(20, { skipSettlementPhase: failed });
  diagnostic("first procurement cycle complete");
  const attemptId = (await pool.query("SELECT id FROM toonies_procurement_attempts WHERE order_id=$1", [orderId])).rows[0]?.id;
  assert.ok(attemptId, "procurement worker did not create an attempt");
  await runTooniesProcurementPollingCycle(20, { skipSettlementPhase: failed });
  diagnostic("second procurement cycle complete");
  const procurementResult = await getTooniesProcurementAttempt(attemptId);
  assert.equal(procurementResult.state, failed ? "failed" : "ready");
  if (!failed) {
    assert.equal((await pool.query("SELECT state FROM toonies_settlements WHERE attempt_id=$1", [attemptId])).rows[0]?.state, "confirmed");
  }
  return { orderId, paymentId: payment.payment.id, attemptId, transport };
}

async function seedAndRun(): Promise<void> {
  const { getDatabasePool, closeDatabase } = await import("../db/client.js");
  const pool = getDatabasePool();
  let productId = "";
  let variantId = "";
  let orderId = "";
  let attemptId = "";
  let paymentId = "";
  try {
    const supplier = (await pool.query(
      `INSERT INTO suppliers(name,slug,active,publication_enabled,compliance_excluded)
       VALUES('Toonies','toonies',true,true,false)
       ON CONFLICT(slug) DO UPDATE SET active=true,publication_enabled=true,compliance_excluded=false
       RETURNING id`,
    )).rows[0];
    assert.ok(supplier, "canonical Toonies supplier was not available");
    await pool.query(
      `INSERT INTO supplier_shipping_rules(supplier_id,country_code,min_weight_kg,max_weight_kg,amount_eur,min_delivery_days,max_delivery_days,temporary,active)
       VALUES($1,'IE',0,100,2,3,7,true,true)`,
      [supplier.id],
    );
    const category = (await pool.query(
      `INSERT INTO categories(name,slug,description,active) VALUES($1,$2,$3,true) RETURNING id`,
      ["Neon Fixture Category", `${marker}-category`, "Fixture category"],
    )).rows[0];
    const mapping = await pool.query(
      `INSERT INTO supplier_category_mappings
       (supplier_id,external_category_id,external_category_name,root_category_id,status,publication_enabled,compliance_excluded)
       VALUES($1,$2,'Fixture Category',$3,'mapped',true,false) RETURNING id`,
      [supplier.id, `${marker}-external-category`, category.id],
    );
    assert.ok(mapping.rows[0], "supplier category mapping was not created");
    const fx = (await pool.query(
      `INSERT INTO fx_rate_snapshots
       (provider,source,series,base_currency,quote_currency,rate,observed_at,fetched_at,expires_at,fetch_cache_expires_at,max_age_hours)
       VALUES('fixture','neon-test',$1,'EUR','CNY',7.8,now(),now(),now()+interval '24 hours',now()+interval '24 hours',24)
       RETURNING id`,
      [`${marker}-fx`],
    )).rows[0];
    const item = (await pool.query(
      `INSERT INTO supplier_catalogue_items
       (supplier_id,external_product_id,external_category_id,title,original_amount,original_currency,
        normalized_eur,normalized_currency,minimum_order_quantity,stock,state,needs_review,fx_rate_snapshot_id)
       VALUES($1,$2,$3,'Neon Fixture Item',7.80,'CNY',1,'EUR',1,20,'Synced',false,$4) RETURNING id`,
      [supplier.id, `${marker}-item`, `${marker}-external-category`, fx.id],
    )).rows[0];
    const catalogueVariant = (await pool.query(
      `INSERT INTO supplier_catalogue_variants
       (supplier_id,catalogue_item_id,external_variant_id,sku_code,title,attributes,original_amount,original_currency,
        normalized_eur,normalized_currency,minimum_order_quantity,weight_kg,stock,state,needs_review,fx_rate_snapshot_id)
       VALUES($1,$2,$3,$4,'Neon Fixture Variant','{}',7.80,'CNY',1,'EUR',1,.2,20,'Synced',false,$5) RETURNING id`,
      [supplier.id, item.id, `${marker}-variant`, `${marker}-sku`, fx.id],
    )).rows[0];
    assert.ok(catalogueVariant, "catalogue variant was not created");
    const unclassifiedCatalogueVariant = (await pool.query(
      `INSERT INTO supplier_catalogue_variants
       (supplier_id,catalogue_item_id,external_variant_id,sku_code,title,attributes,original_amount,original_currency,
        normalized_eur,normalized_currency,minimum_order_quantity,weight_kg,stock,state,needs_review,fx_rate_snapshot_id)
       VALUES($1,$2,$3,$4,'Unclassified Fixture Variant','{}',7.80,'CNY',1,'EUR',1,.2,20,'Synced',false,$5) RETURNING id`,
      [supplier.id, item.id, `${marker}-unclassified-variant`, `${marker}-unclassified-sku`, fx.id],
    )).rows[0];

    const { saveProduct } = await import("../catalog/service.js");
    const input = {
      name: "Neon Fixture Product", slug: `${marker}-product`, parentSku: `${marker}-parent`,
      barcode: null, brandId: null, categoryId: category.id, shortDescription: "Fixture",
      description: "Disposable Neon lifecycle fixture", status: "draft" as const, costPrice: 1,
      basePrice: 10, vatRate: 0, taxMode: "exclusive" as const, weight: .2,
      minimumOrderQuantity: 1, width: null, height: null, length: null, featured: false,
      newArrival: false, homepageWholesale: false, seoTitle: null, seoDescription: null,
      options: [{ name: "Color", values: ["Fixture"] }],
      variants: [{
        sku: `TOONIES-${marker}-sku`, barcode: null, title: "Fixture", costPrice: 1,
        basePrice: 10, weight: .2, minimumOrderQuantity: 1, active: true,
        optionValues: [{ attribute: "Color", value: "Fixture" }],
      }],
    };
    productId = await saveProduct(input);
    variantId = (await pool.query("SELECT id FROM product_variants WHERE product_id=$1", [productId])).rows[0].id;
    await pool.query(
      `INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id)
       VALUES($1,$2,$3,$4,$5)`,
      [supplier.id, item.id, catalogueVariant.id, productId, variantId],
    );
    await pool.query(
      `INSERT INTO product_media(product_id,type,url,alt_text,is_primary,sort_order)
       VALUES($1,'image','/catalog-media/neon-fixture.png','Fixture',true,0)`,
      [productId],
    );
    await saveProduct({ ...input, status: "active", variants: [{ ...input.variants[0], id: variantId, costPrice: 1, basePrice: 10 }] }, productId);
    const classified = (await pool.query("SELECT vat_classified_at,published_at FROM products WHERE id=$1", [productId])).rows[0];
    assert.ok(classified.vat_classified_at && classified.published_at, "classified product was not published through saveProduct");

    let unclassified: string;
    try {
      unclassified = await saveProduct({
        ...input, name: "Unclassified Fixture", slug: `${marker}-unclassified`, parentSku: `${marker}-unclassified-parent`, status: "inactive",
        options: [],
        variants: [{ ...input.variants[0], sku: `TOONIES-${marker}-unclassified-sku`, optionValues: [] }],
      });
    } catch (error) {
      const detail = error as { code?: string; constraint?: string };
      throw new Error(`unclassified fixture save failed (${detail.code ?? "unknown"}:${detail.constraint ?? "unknown"})`);
    }
    const unclassifiedVariant = (await pool.query("SELECT id FROM product_variants WHERE product_id=$1", [unclassified])).rows[0].id;
    await pool.query("INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id) VALUES($1,$2,$3,$4,$5)", [supplier.id, item.id, unclassifiedCatalogueVariant.id, unclassified, unclassifiedVariant]);
    await assert.rejects(
      () => import("../catalog/service.js").then(({ setProductOperationalStatus }) => setProductOperationalStatus(unclassified, "active")),
      (error: any) => error?.code === "TOONIES_VAT_CLASSIFICATION_REQUIRED",
    );

    const lifecycle = await createPaidReadyOrder(pool, productId, variantId, "primary");
    ({ orderId, paymentId, attemptId } = lifecycle);
    const calls = lifecycle.transport.requests.map((request: { path: string }) => request.path);
    assert.ok(calls.every((path: string) => path.startsWith("/v1/order/")), "unexpected provider fixture call");
    console.info(`Neon lifecycle fixture passed: ${marker}`);
  } finally {
    const audit = await pool.query(
      `SELECT (SELECT count(*) FROM orders WHERE order_number LIKE $1) AS orders,
              (SELECT count(*) FROM products WHERE slug LIKE $1) AS products,
              (SELECT count(*) FROM payments WHERE id=$2) AS payments,
              (SELECT count(*) FROM toonies_procurement_commands WHERE order_id=$3) AS commands`,
      [`${marker}%`, paymentId || null, orderId || null],
    );
    console.info(`Neon fixture audit: ${JSON.stringify(audit.rows[0] ?? {})}`);
    await closeDatabase();
  }
}

async function run(): Promise<void> {
  await withDisposableNeonBranch({ sourceVerifiedEmpty: true }, async (_branch, closePools) => {
    const { runMigrations } = await import("../db/migrate.js");
    await runMigrations();
    try {
      await seedAndRun();
    } finally {
      await closePools(async () => {
        const { closeDatabase } = await import("../db/client.js");
        await closeDatabase();
      });
    }
  });
}

if (process.argv[1]?.endsWith("neon-lifecycle-fixture.ts")) {
  run().catch((error: unknown) => {
    if (error && typeof error === "object" && "details" in error) {
      console.error(JSON.stringify((error as { details?: unknown }).details));
    }
    console.error(error instanceof Error ? error.stack : "Neon lifecycle fixture failed.");
    process.exitCode = 1;
  });
}