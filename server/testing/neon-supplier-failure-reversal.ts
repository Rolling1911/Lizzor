import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withDisposableNeonBranch } from "./neon-branch-harness.js";

const marker = `neon-reversal-${randomUUID().replaceAll("-", "")}`;
const address = { firstName: "Proof", lastName: "Fixture", addressLine1: "1 Test Street", province: "Leinster", city: "Dublin", postalCode: "D01", countryCode: "IE", phone: "+3531000000" };

async function run(): Promise<void> {
  await withDisposableNeonBranch({ sourceVerifiedEmpty: true }, async (_branch, closePools) => {
    const { runMigrations } = await import("../db/migrate.js");
    await runMigrations();
    const { getDatabasePool, closeDatabase } = await import("../db/client.js");
    const pool = getDatabasePool();
    try {
      const supplier = (await pool.query<any>(`INSERT INTO suppliers(name,slug,active,publication_enabled,compliance_excluded) VALUES('Toonies','toonies',true,true,false) ON CONFLICT(slug) DO UPDATE SET active=true,publication_enabled=true,compliance_excluded=false RETURNING id`)).rows[0];
      await pool.query(`INSERT INTO supplier_shipping_rules(supplier_id,country_code,min_weight_kg,max_weight_kg,amount_eur,min_delivery_days,max_delivery_days,temporary,active) VALUES($1,'IE',0,100,2,3,7,true,true)`, [supplier.id]);
      const category = (await pool.query<any>("INSERT INTO categories(name,slug,description,active) VALUES($1,$2,'proof',true) RETURNING id", [`${marker} category`, `${marker}-category`])).rows[0];
      await pool.query(
        `INSERT INTO supplier_category_mappings
          (supplier_id,external_category_id,external_category_name,root_category_id,status,publication_enabled,compliance_excluded)
         VALUES($1,$2,'Proof Category',$3,'mapped',true,false)`,
        [supplier.id, `${marker}-external`, category.id],
      );
      const fx = (await pool.query<any>(`INSERT INTO fx_rate_snapshots(provider,source,series,base_currency,quote_currency,rate,observed_at,fetched_at,expires_at,fetch_cache_expires_at,max_age_hours) VALUES('fixture','proof',$1,'EUR','CNY',7.8,now(),now(),now()+interval '24 hours',now()+interval '24 hours',24) RETURNING id`, [`${marker}-fx`])).rows[0];
      const item = (await pool.query<any>(`INSERT INTO supplier_catalogue_items(supplier_id,external_product_id,external_category_id,title,original_amount,original_currency,normalized_eur,normalized_currency,minimum_order_quantity,stock,state,needs_review,fx_rate_snapshot_id) VALUES($1,$2,$3,'Proof Item',7.8,'CNY',1,'EUR',1,20,'Synced',false,$4) RETURNING id`, [supplier.id, `${marker}-item`, `${marker}-external`, fx.id])).rows[0];
      const cv = (await pool.query<any>(`INSERT INTO supplier_catalogue_variants(supplier_id,catalogue_item_id,external_variant_id,sku_code,title,attributes,original_amount,original_currency,normalized_eur,normalized_currency,minimum_order_quantity,weight_kg,stock,state,needs_review,fx_rate_snapshot_id) VALUES($1,$2,$3,$4,'Proof Variant','{}',7.8,'CNY',1,'EUR',1,.2,20,'Synced',false,$5) RETURNING id`, [supplier.id, item.id, `${marker}-variant`, `${marker}-sku`, fx.id])).rows[0];
      const { saveProduct } = await import("../catalog/service.js");
      const productId = await saveProduct({ name: `${marker} Product`, slug: `${marker}-product`, parentSku: `${marker}-parent`, barcode: null, brandId: null, categoryId: category.id, shortDescription: "proof", description: "proof", status: "draft", costPrice: 1, basePrice: 10, vatRate: 0, taxMode: "exclusive", weight: .2, minimumOrderQuantity: 1, width: null, height: null, length: null, featured: false, newArrival: false, homepageWholesale: false, seoTitle: null, seoDescription: null, options: [{ name: "Color", values: ["Proof"] }], variants: [{ sku: `TOONIES-${marker}-sku`, barcode: null, title: "Proof", costPrice: 1, basePrice: 10, weight: .2, minimumOrderQuantity: 1, active: true, optionValues: [{ attribute: "Color", value: "Proof" }] }] });
      const variantId = (await pool.query<any>("SELECT id FROM product_variants WHERE product_id=$1", [productId])).rows[0].id;
      await pool.query("INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id) VALUES($1,$2,$3,$4,$5)", [supplier.id, item.id, cv.id, productId, variantId]);
      await pool.query("INSERT INTO product_media(product_id,type,url,alt_text,is_primary,sort_order) VALUES($1,'image','/catalog-media/neon-reversal-proof.png','proof',true,0)", [productId]);
      await saveProduct({ name: `${marker} Product`, slug: `${marker}-product`, parentSku: `${marker}-parent`, barcode: null, brandId: null, categoryId: category.id, shortDescription: "proof", description: "proof", status: "active", costPrice: 1, basePrice: 10, vatRate: 0, taxMode: "exclusive", weight: .2, minimumOrderQuantity: 1, width: null, height: null, length: null, featured: false, newArrival: false, homepageWholesale: false, seoTitle: null, seoDescription: null, options: [{ name: "Color", values: ["Proof"] }], variants: [{ id: variantId, sku: `TOONIES-${marker}-sku`, barcode: null, title: "Proof", costPrice: 1, basePrice: 10, weight: .2, minimumOrderQuantity: 1, active: true, optionValues: [{ attribute: "Color", value: "Proof" }] }] }, productId);

      const { createPaidReadyOrder } = await import("./neon-lifecycle-fixture.js");
      const { createSupplierFailureReversal, reserveSupplierFailureReversal, transmitSupplierFailureReversal, reclaimExpiredSupplierFailureReversal } = await import("../suppliers/supplier-failure-reversal-service.js");
      const { getPaymentProvider, getFakePaymentRefundTotalForTest, getFakePaymentRefundCountForTest, setFakePaymentRefundFailureAfterCallForTest } = await import("../payments/provider.js");
      const matrix: Array<Record<string, unknown>> = [];
      const fixtureIdentity = { supplierProductCode: `${marker}-item`, supplierSkuCode: `${marker}-sku` };
      const guarded = async <T>(label: string, operation: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000); })]);
        } finally { if (timer) clearTimeout(timer); }
      };
      const counts = (transport: any, key?: string) => ({
        tooniesCreate: transport.requests.filter((entry: any) => entry.path === "/v1/order/create").length,
        tooniesTask: transport.requests.filter((entry: any) => entry.path === "/v1/order/task").length,
        providerRefunds: key ? getFakePaymentRefundCountForTest(key) : getFakePaymentRefundTotalForTest(),
      });
      const failed = await createPaidReadyOrder(pool, productId, variantId, "reversal", { ...fixtureIdentity, outcome: { reasonCode: "STOCK_REJECTED" } });
      let reversal = (await pool.query<any>("SELECT * FROM supplier_failure_reversals WHERE order_id=$1", [failed.orderId])).rows[0];
      assert.ok(reversal, "eligible reversal was not created from terminal evidence");
      reversal = await reserveSupplierFailureReversal(pool, reversal.id);
      const beforeReversalRefunds = getFakePaymentRefundTotalForTest();
      await guarded("reversal transmission", transmitSupplierFailureReversal(pool, reversal.id));
      assert.equal((await pool.query<any>("SELECT state FROM supplier_failure_reversals WHERE id=$1", [reversal.id])).rows[0].state, "completed");
      assert.equal(getFakePaymentRefundTotalForTest() - beforeReversalRefunds, 1);
      assert.equal(counts(failed.transport).tooniesCreate, 0);
      matrix.push({ case: "reversal-wins", result: "PASS", ...counts(failed.transport) });

      const crash = await createPaidReadyOrder(pool, productId, variantId, "crash", { ...fixtureIdentity, outcome: { reasonCode: "INVALID_PRODUCT" } });
      let crashSaga = (await pool.query<any>("SELECT * FROM supplier_failure_reversals WHERE order_id=$1", [crash.orderId])).rows[0];
      crashSaga = await reserveSupplierFailureReversal(pool, crashSaga.id);
      setFakePaymentRefundFailureAfterCallForTest(crashSaga.provider_refund_identity);
      await assert.rejects(() => guarded("lost refund response", transmitSupplierFailureReversal(pool, crashSaga.id)));
      assert.equal(await reclaimExpiredSupplierFailureReversal(pool, crashSaga.id), false);
      const crashBeforeLookup = getFakePaymentRefundTotalForTest();
      await guarded("refund lookup recovery", transmitSupplierFailureReversal(pool, crashSaga.id));
      assert.equal(getFakePaymentRefundTotalForTest(), crashBeforeLookup);
      matrix.push({ case: "post-refund-crash-lookup", result: "PASS", ...counts(crash.transport) });

      const reclaimOrder = await createPaidReadyOrder(pool, productId, variantId, "reclaim", { ...fixtureIdentity, outcome: { reasonCode: "MOQ_REJECTED" } });
      let reclaimSaga = (await pool.query<any>("SELECT * FROM supplier_failure_reversals WHERE order_id=$1", [reclaimOrder.orderId])).rows[0];
      reclaimSaga = await reserveSupplierFailureReversal(pool, reclaimSaga.id);
      await pool.query("UPDATE supplier_failure_reversals SET lease_until=now()-interval '1 second' WHERE id=$1", [reclaimSaga.id]);
      assert.equal(await reclaimExpiredSupplierFailureReversal(pool, reclaimSaga.id), true);
      assert.equal((await pool.query<any>("SELECT state FROM supplier_failure_reversals WHERE id=$1", [reclaimSaga.id])).rows[0].state, "eligible");
      matrix.push({ case: "reserved-never-transmitted-expiry-reclaim", result: "PASS", ...counts(reclaimOrder.transport) });

      const staleOrder = await createPaidReadyOrder(pool, productId, variantId, "stale-cas", { ...fixtureIdentity, outcome: { reasonCode: "INVALID_SKU" } });
      let staleSaga = (await pool.query<any>("SELECT * FROM supplier_failure_reversals WHERE order_id=$1", [staleOrder.orderId])).rows[0];
      staleSaga = await reserveSupplierFailureReversal(pool, staleSaga.id);
      const staleBefore = getFakePaymentRefundTotalForTest();
      const staleResults = await Promise.allSettled([
        guarded("stale worker one", transmitSupplierFailureReversal(pool, staleSaga.id)),
        guarded("stale worker two", transmitSupplierFailureReversal(pool, staleSaga.id)),
      ]);
      assert.equal(getFakePaymentRefundTotalForTest() - staleBefore, 1);
      assert.equal((await pool.query<any>("SELECT state FROM supplier_failure_reversals WHERE id=$1", [staleSaga.id])).rows[0].state, "completed");
      assert.ok(staleResults.some((entry) => entry.status === "fulfilled"));
      matrix.push({ case: "stale-worker-cas", result: "PASS", ...counts(staleOrder.transport) });

      const transmittingOrder = await createPaidReadyOrder(pool, productId, variantId, "transmitting", { ...fixtureIdentity, outcome: { reasonCode: "STOCK_REJECTED" } });
      let transmittingSaga = (await pool.query<any>("SELECT * FROM supplier_failure_reversals WHERE order_id=$1", [transmittingOrder.orderId])).rows[0];
      transmittingSaga = await reserveSupplierFailureReversal(pool, transmittingSaga.id);
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const releasePromise = new Promise<void>((resolve) => { release = resolve; });
      const baseProvider = getPaymentProvider();
      const pausedProvider = { ...baseProvider, createRefund: async (input: any) => { entered(); await releasePromise; return baseProvider.createRefund(input); } };
      const transmittingRun = transmitSupplierFailureReversal(pool, transmittingSaga.id, pausedProvider);
      await guarded("transmitting acquisition", enteredPromise);
      await pool.query("UPDATE supplier_failure_reversals SET lease_until=now()-interval '1 second' WHERE id=$1", [transmittingSaga.id]);
      assert.equal(await reclaimExpiredSupplierFailureReversal(pool, transmittingSaga.id), false);
      release();
      await guarded("transmitting completion", transmittingRun);
      matrix.push({ case: "transmitting-and-expired-after-transmission-block", result: "PASS", ...counts(transmittingOrder.transport) });

      const completedOrder = await createPaidReadyOrder(pool, productId, variantId, "completed-block", { ...fixtureIdentity, outcome: { reasonCode: "INVALID_PRODUCT" } });
      let completedSaga = (await pool.query<any>("SELECT * FROM supplier_failure_reversals WHERE order_id=$1", [completedOrder.orderId])).rows[0];
      completedSaga = await reserveSupplierFailureReversal(pool, completedSaga.id);
      await guarded("completed transmission", transmitSupplierFailureReversal(pool, completedSaga.id));
      const completedBefore = getFakePaymentRefundTotalForTest();
      await guarded("completed replay", transmitSupplierFailureReversal(pool, completedSaga.id));
      assert.equal(getFakePaymentRefundTotalForTest(), completedBefore);
      matrix.push({ case: "completed-block", result: "PASS", ...counts(completedOrder.transport) });

      const protectedOrder = await createPaidReadyOrder(pool, productId, variantId, "protected", fixtureIdentity);
      const protectedAttempt = (await pool.query<any>("SELECT id FROM toonies_procurement_attempts WHERE order_id=$1", [protectedOrder.orderId])).rows[0];
      await assert.rejects(() => createSupplierFailureReversal(pool, { orderId: protectedOrder.orderId, attemptId: protectedAttempt.id, reasonCode: "STOCK_REJECTED" }));
      assert.equal(counts(protectedOrder.transport).tooniesCreate, 1);
      matrix.push({ case: "stage3-wins-protected-settlement", result: "PASS", ...counts(protectedOrder.transport) });
    } finally {
      await closeDatabase();
      await closePools(async () => undefined);
    }
  });
}

run().catch((error) => { console.error("Supplier-failure reversal proof failed:", error); process.exitCode = 1; });