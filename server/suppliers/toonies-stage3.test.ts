/**
 * Stage 3 DB-backed, fixture-only integration suite.
 *
 * This deliberately owns every row it creates and refuses production/deployment
 * databases. No provider or Stripe network is reachable from this test.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";
import {
  getTooniesSettlementGateStatus,
  resolveTooniesProcurementGateStatus,
  validTooniesSettlementPartialPredicate,
} from "./toonies-procurement-gate.js";
import { TooniesClient, TooniesError, TooniesFixtureTransport } from "./toonies.js";
import { setTooniesClient } from "./toonies-service.js";
import { loadTooniesSupplierSnapshotFingerprint } from "./toonies-snapshot.js";
import { createRefund, recoverInvalidatedPayment } from "../payments/service.js";
import {
  getFakePaymentCancelCountForTest,
  getFakePaymentLookupCountForTest,
  getFakePaymentRefundCountForTest,
  getFakePaymentRefundTotalForTest,
} from "../payments/provider.js";
import { setFinancialOperationTestPause } from "../financial/operation-reservation.js";
import {
  reconcileTooniesSettlement,
  recoverExpiredTooniesSubmittingSettlements,
  replayTooniesSettlement,
  settleTooniesProcurementAttempt,
  setTooniesSettlementTestPauseAfterResponse,
} from "./toonies-settlement-service.js";

assertMutableIntegrationTestDatabase("Toonies Stage 3 settlement integration");
const pool = getDatabasePool();
const marker = `stage3-${Date.now()}-${randomUUID().slice(0, 8)}`;
const identity = `lz_${randomUUID().replaceAll("-", "")}_g1`;
const request = {
  task_id: `${marker}-task`.slice(0, 32), api_order_sn: identity,
  consignee: "Stage Three Fixture", phone: "+3531000000", country_code: "IE",
  province: "Leinster", city: "Dublin", address: "1 Fixture Street",
  postcode: "D01", email: `${marker}@example.test`,
};
const digest = (value: unknown) => {
  const normalize = (input: any): any => Array.isArray(input) ? input.map(normalize)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : input;
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
};
let cleanup: (() => Promise<void>) | undefined;
const extraOrders: string[] = [];

async function run(): Promise<void> {
  const supplier = (await pool.query<{ id: string }>("SELECT id FROM suppliers WHERE slug='toonies' LIMIT 1")).rows[0];
  assert.ok(supplier, "the development database must contain the Toonies supplier");
  const order = (await pool.query<{ id: string }>(
    `INSERT INTO orders(order_number,guest_email,status,payment_status,fulfillment_status,fulfillment_stage,currency,subtotal,discount_total,shipping_total,tax_total,grand_total,total_fingerprint,billing_address_snapshot,shipping_address_snapshot)
     VALUES($1,$2,'confirmed','paid','unfulfilled','unfulfilled','EUR',3,0,0,0,3,$3,$4::jsonb,$4::jsonb) RETURNING id`,
    [`${marker}-order`, request.email, "a".repeat(64), JSON.stringify({ ...request, firstName: "Stage", lastName: "Three" })],
  )).rows[0]!;
  const command = (await pool.query<{ id: string }>(
    `INSERT INTO toonies_procurement_commands(order_id,order_total_fingerprint,supplier_snapshot_fingerprint,state)
     VALUES($1,$2,$3,'completed') RETURNING id`, [order.id, "a".repeat(64), "b".repeat(64)],
  )).rows[0]!;
  const attempt = (await pool.query<{ id: string }>(
    `INSERT INTO toonies_procurement_attempts(order_id,supplier_id,client_task_no,generation,task_id,state,request_fingerprint,snapshot_expires_at)
     VALUES($1,$2,$3,1,$4,'ready',$5,now()+interval '1 hour') RETURNING id`,
    [order.id, supplier.id, `${marker}-client`.slice(0, 64), request.task_id, (marker + "c".repeat(64)).slice(0, 64)],
  )).rows[0]!;
  const linked = (await pool.query<any>(
    `SELECT l.id AS "linkId",l.product_id AS "productId",l.variant_id AS "variantId",
            l.catalogue_item_id AS "catalogueItemId",l.catalogue_variant_id AS "catalogueVariantId",
            ci.external_product_id AS "productCode",cv.sku_code AS "skuCode"
       FROM supplier_product_links l
       JOIN supplier_catalogue_items ci ON ci.id=l.catalogue_item_id
       LEFT JOIN supplier_catalogue_variants cv ON cv.id=l.catalogue_variant_id
      WHERE l.supplier_id=$1 AND l.variant_id IS NOT NULL AND l.catalogue_variant_id IS NOT NULL
      ORDER BY l.id LIMIT 1`, [supplier.id],
  )).rows[0];
  assert.ok(linked, "a linked Toonies catalogue fixture is required");
  await pool.query(
    `INSERT INTO order_items(order_id,product_id,variant_id,sku_snapshot,product_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total,
       supplier_product_link_id,supplier_id,supplier_catalogue_item_id,supplier_catalogue_variant_id,supplier_product_code,supplier_sku_code,
       supplier_cost_eur,supplier_cost_cny,supplier_cost_provenance,supplier_cost_threshold_percent)
     VALUES($1,$2,$3,'fixture','Stage Three Fixture',1,3,1,0,3,$4,$5,$6,$7,$8,$9,.49,.49,$10,0)`,
    [order.id, linked.productId, linked.variantId, linked.linkId, supplier.id, linked.catalogueItemId, linked.catalogueVariantId, "P1", "S1", JSON.stringify({ source: "stage3-fixture" })],
  );
  await pool.query(
    `INSERT INTO payments(order_id,provider,amount,currency,status,order_total_fingerprint,provider_payment_id)
     VALUES($1,'fixture',3,'EUR','paid',$2,$3)`,
    [order.id, "a".repeat(64), `${marker}-payment`],
  );
  await pool.query(
    `INSERT INTO toonies_procurement_lines(attempt_id,product_id,variant_id,catalogue_item_id,catalogue_variant_id,product_code,sku_code,
       requested_quantity,returned_quantity,returned_moq,returned_stock,returned_charge_cny,returned_subtotal_cny,
       expected_unit_cost_cny,expected_subtotal_cny,cost_threshold_percent,returned_cost_variance_cny,orderable)
     VALUES($1,$2,$3,$4,$5,'P1','S1',1,1,1,10,3,3,NULL,NULL,NULL,NULL,true)`,
    [attempt.id, linked.productId, linked.variantId, linked.catalogueItemId, linked.catalogueVariantId],
  );
  const supplierSnapshotFingerprint = await loadTooniesSupplierSnapshotFingerprint(pool, order.id);
  assert.ok(supplierSnapshotFingerprint);
  await pool.query("UPDATE toonies_procurement_commands SET supplier_snapshot_fingerprint=$1 WHERE id=$2", [supplierSnapshotFingerprint, command.id]);
  const baseCanonicalBasket = [{
    productCode: "P1", skuCode: "S1", quantity: 1, charge: "3", subtotal: "3",
    productId: linked.productId, variantId: linked.variantId, linkId: linked.linkId,
    catalogueItemId: linked.catalogueItemId, catalogueVariantId: linked.catalogueVariantId,
    moq: 1, stock: 10,
  }];
  const settlement = (await pool.query<{ id: string }>(
    `INSERT INTO toonies_settlements(order_id,command_id,attempt_id,supplier_id,generation,task_id,api_order_sn,canonical_request,canonical_basket,expected_product_sum,expected_shipping_fee,expected_total_sum,request_hash,basket_fingerprint,destination_fingerprint,order_total_fingerprint,supplier_snapshot_fingerprint)
     VALUES($1,$2,$3,$4,1,$5,$6,$7::jsonb,$8::jsonb,'3.000000','0.000000','3.000000',$9,$10,$11,$12,$13) RETURNING id`,
       [order.id, command.id, attempt.id, supplier.id, request.task_id, identity, JSON.stringify(request), JSON.stringify(baseCanonicalBasket),
       digest(request), digest(baseCanonicalBasket), digest({ consignee: request.consignee, phone: request.phone, country_code: request.country_code, province: request.province, city: request.city, address: request.address, postcode: request.postcode, email: request.email }), "a".repeat(64), supplierSnapshotFingerprint],
  )).rows[0]!;
  cleanup = async () => {
    const cleanupDb = await pool.connect();
    const ownedOrderIds = [order.id, ...extraOrders];
    try {
      await cleanupDb.query("BEGIN");
      // Evidence is intentionally append-only in application sessions. This
      // test-only owner cleanup runs in a transaction with triggers disabled,
      // then verifies every owned row is gone before committing.
      await cleanupDb.query("SET LOCAL session_replication_role='replica'");
      await cleanupDb.query(
        "DELETE FROM toonies_settlement_evidence WHERE settlement_id IN (SELECT id FROM toonies_settlements WHERE order_id=ANY($1::uuid[]))",
        [ownedOrderIds],
      );
      await cleanupDb.query("SET LOCAL session_replication_role='origin'");
      await cleanupDb.query("DELETE FROM toonies_settlements WHERE order_id=ANY($1::uuid[])", [ownedOrderIds]);
      await cleanupDb.query("DELETE FROM financial_operation_reservations WHERE order_id=ANY($1::uuid[])", [ownedOrderIds]);
      await cleanupDb.query("DELETE FROM payment_recovery_jobs WHERE order_id=ANY($1::uuid[])", [ownedOrderIds]);
      await cleanupDb.query("DELETE FROM refunds WHERE order_id=ANY($1::uuid[])", [ownedOrderIds]);
      await cleanupDb.query("DELETE FROM toonies_procurement_attempts WHERE order_id=ANY($1::uuid[])", [ownedOrderIds]);
      await cleanupDb.query("DELETE FROM toonies_procurement_commands WHERE order_id=ANY($1::uuid[])", [ownedOrderIds]);
      await cleanupDb.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [ownedOrderIds]);
      await cleanupDb.query("COMMIT");
    } catch (error) {
      await cleanupDb.query("ROLLBACK");
      throw error;
    } finally {
      cleanupDb.release();
    }
    const leftovers = await pool.query(
      `SELECT
         (SELECT count(*) FROM orders WHERE order_number LIKE $1) AS orders,
          (SELECT count(*) FROM payments WHERE order_id=ANY($2::uuid[])) AS payments,
          (SELECT count(*) FROM toonies_procurement_commands WHERE order_id=ANY($2::uuid[])) AS commands,
          (SELECT count(*) FROM toonies_procurement_attempts WHERE order_id=ANY($2::uuid[])) AS attempts,
          (SELECT count(*) FROM toonies_settlements WHERE order_id=ANY($2::uuid[])) AS settlements,
          (SELECT count(*) FROM toonies_settlement_evidence e
             JOIN toonies_settlements s ON s.id=e.settlement_id
            WHERE s.order_id=ANY($2::uuid[])) AS evidence,
          (SELECT count(*) FROM financial_operation_reservations WHERE order_id=ANY($2::uuid[])) AS reservations`,
      [`${marker}%`, ownedOrderIds],
    );
    assert.deepEqual(Object.values(leftovers.rows[0]).map(Number), [0, 0, 0, 0, 0, 0, 0], "owned Stage-3 fixture rows leaked");
  };

  async function makeServiceFixture(name: string) {
    const fixtureEmail = `${marker}-${name}@example.test`;
    const extra = (await pool.query<any>(
      `INSERT INTO orders(order_number,guest_email,status,payment_status,fulfillment_status,fulfillment_stage,currency,subtotal,discount_total,shipping_total,tax_total,grand_total,total_fingerprint,billing_address_snapshot,shipping_address_snapshot)
       VALUES($1,$2,'confirmed','paid','unfulfilled','unfulfilled','EUR',3,0,0,0,3,$3,$4::jsonb,$4::jsonb) RETURNING id`,
      [`${marker.slice(0, 20)}-${randomUUID().slice(0, 12)}`, fixtureEmail, "a".repeat(64), JSON.stringify({ ...request, email: fixtureEmail })],
    )).rows[0];
    extraOrders.push(extra.id);
    await pool.query(
      `INSERT INTO order_items(order_id,product_id,variant_id,sku_snapshot,product_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total,
         supplier_product_link_id,supplier_id,supplier_catalogue_item_id,supplier_catalogue_variant_id,supplier_product_code,supplier_sku_code,
         supplier_cost_eur,supplier_cost_cny,supplier_cost_provenance,supplier_cost_threshold_percent)
       VALUES($1,$2,$3,'fixture','Stage Three Fixture',1,3,1,0,3,$4,$5,$6,$7,'P1','S1',.49,.49,$8,0)`,
      [extra.id, linked.productId, linked.variantId, linked.linkId, supplier.id, linked.catalogueItemId, linked.catalogueVariantId, JSON.stringify({ source: "stage3-fixture" })],
    );
    await pool.query("INSERT INTO payments(order_id,provider,amount,currency,status,order_total_fingerprint,provider_payment_id) VALUES($1,'fixture',3,'EUR','paid',$2,$3)", [extra.id, "a".repeat(64), `fake_pi_${marker}-${name}-payment`]);
    const extraSnapshotFingerprint = await loadTooniesSupplierSnapshotFingerprint(pool, extra.id);
    assert.ok(extraSnapshotFingerprint);
    await pool.query(
      "INSERT INTO toonies_procurement_commands(order_id,order_total_fingerprint,supplier_snapshot_fingerprint,state) VALUES($1,$2,$3,'completed')",
      [extra.id, "a".repeat(64), extraSnapshotFingerprint],
    );
    const unique = randomUUID().slice(0, 8);
    const taskId = `${name.slice(0, 20)}-${unique}`;
    const attemptRow = (await pool.query<any>(
      `INSERT INTO toonies_procurement_attempts(order_id,supplier_id,client_task_no,generation,task_id,state,request_fingerprint,snapshot_expires_at)
       VALUES($1,$2,$3,1,$4,'ready',$5,now()+interval '1 hour') RETURNING id`,
      [extra.id, supplier.id, `${name}-${unique}-client`.slice(0, 64), taskId, `${name}-${unique}-fingerprint`.slice(0, 64)],
    )).rows[0];
    await pool.query(
      `INSERT INTO toonies_procurement_lines(attempt_id,product_id,variant_id,catalogue_item_id,catalogue_variant_id,product_code,sku_code,requested_quantity,returned_quantity,returned_moq,returned_stock,returned_charge_cny,returned_subtotal_cny,orderable)
       VALUES($1,$2,$3,$4,$5,'P1','S1',1,1,1,10,3,3,true)`,
      [attemptRow.id, linked.productId, linked.variantId, linked.catalogueItemId, linked.catalogueVariantId],
    );
    const apiOrderSn = `lz_${extra.id.replaceAll("-", "")}_g1`;
    const canonicalRequest = { ...request, task_id: taskId, api_order_sn: apiOrderSn, email: `${marker}-${name}@example.test` };
    const canonicalBasket = baseCanonicalBasket.map((line) => ({ ...line }));
    const destinationFingerprint = digest({
      consignee: canonicalRequest.consignee, phone: canonicalRequest.phone, country_code: canonicalRequest.country_code,
      province: canonicalRequest.province, city: canonicalRequest.city, address: canonicalRequest.address,
      postcode: canonicalRequest.postcode, email: canonicalRequest.email,
    });
    const commandRow = (await pool.query<any>("SELECT id,supplier_snapshot_fingerprint AS \"supplierSnapshotFingerprint\" FROM toonies_procurement_commands WHERE order_id=$1", [extra.id])).rows[0];
    assert.ok(commandRow);
    const settlementRow = (await pool.query<any>(
      `INSERT INTO toonies_settlements(order_id,command_id,attempt_id,supplier_id,generation,task_id,api_order_sn,canonical_request,canonical_basket,expected_product_sum,expected_shipping_fee,expected_total_sum,request_hash,basket_fingerprint,destination_fingerprint,order_total_fingerprint,supplier_snapshot_fingerprint)
       VALUES($1,$2,$3,$4,1,$5,$6,$7::jsonb,$8::jsonb,3,0,3,$9,$10,$11,$12,$13) RETURNING id`,
      [extra.id, commandRow.id, attemptRow.id, supplier.id, taskId, apiOrderSn, JSON.stringify(canonicalRequest), JSON.stringify(canonicalBasket), digest(canonicalRequest), digest(canonicalBasket), destinationFingerprint, "a".repeat(64), commandRow.supplierSnapshotFingerprint],
    )).rows[0];
    return { orderId: extra.id, attemptId: attemptRow.id, settlementId: settlementRow.id, request: canonicalRequest, basket: canonicalBasket };
  }

  // Persistence and database invariants: one unresolved/confirmed settlement,
  // immutable identity/authority, append-only evidence, and CAS ownership.
  await pool.query("INSERT INTO toonies_settlement_evidence(settlement_id,event_type,details) VALUES($1,'fixture_authorized',$2)", [settlement.id, { marker }]);
  await assert.rejects(() => pool.query(
    "INSERT INTO toonies_settlements(order_id,command_id,attempt_id,supplier_id,generation,task_id,api_order_sn,canonical_request,canonical_basket,expected_product_sum,expected_shipping_fee,expected_total_sum,request_hash,basket_fingerprint,destination_fingerprint,order_total_fingerprint,supplier_snapshot_fingerprint) VALUES($1,$2,$3,$4,2,$5,$6,$7,$8,3,0,3,$9,$10,$11,$12,$13)",
    [order.id, command.id, attempt.id, supplier.id, request.task_id, `${identity}-2`, request, baseCanonicalBasket, "1".repeat(64), "2".repeat(64), "3".repeat(64), "a".repeat(64), "b".repeat(64)],
  ), "partial order uniqueness must reject a second unresolved settlement");
  await assert.rejects(() => pool.query("UPDATE toonies_settlements SET task_id='changed' WHERE id=$1", [settlement.id]), /immutable/);
  await assert.rejects(() => pool.query("DELETE FROM toonies_settlement_evidence WHERE settlement_id=$1", [settlement.id]), /append-only/);

  // Client fixture matrix: original/duplicate, exact replay bytes, bounded list
  // pages, malformed identity/status/facts, documented errors, and no live
  // transport. Every create response is deliberately non-retried.
  const fixture = new TooniesFixtureTransport({
    "/v1/order/create": [
      { status: true, code: 200, msg: "created", data: { order_sn: "supplier-1", api_order_sn: identity, currency: "CNY", product_sum: "3.000000", shipping_fee: "0.000000", sum: "3.000000", status: "paid", pay_status: "paid", items: [{ product_code: "P1", sku_code: "S1", num: 1 }] } },
      { status: true, code: 200, msg: "duplicate", data: { order_sn: "supplier-1", api_order_sn: identity, duplicated: true, currency: "CNY", product_sum: "3.000000", shipping_fee: "0.000000", sum: "3.000000", status: "paid", pay_status: "paid", items: [{ product_code: "P1", sku_code: "S1", num: 1 }] } },
    ],
    "/v1/order/get": { status: true, code: 200, msg: "ok", data: { order_sn: "supplier-1", api_order_sn: identity, currency: "CNY", product_sum: "3.000000", shipping_fee: "0.000000", sum: "3.000000", status: "paid", pay_status: "paid", items: [{ product_code: "P1", sku_code: "S1", num: 1 }] } },
    "/v1/order/list": Array.from({ length: 10 }, (_, index) => ({ status: true, code: 200, msg: "ok", data: { items: Array.from({ length: index === 9 ? 1 : 50 }, () => ({ api_order_sn: "other" })) } })),
    "/v1/order/bad": { status: false, code: 40031, msg: "used", data: null },
    "/v1/order/expired": { status: false, code: 40042, msg: "expired", data: null },
  });
  const client = new TooniesClient({ appKey: "fixture", appSecret: "fixture", transport: fixture.request, now: () => 1_700_000_000, nonce: () => `${marker}-nonce`.slice(0, 32) });
  setTooniesClient(client);
  const settled = await settleTooniesProcurementAttempt(attempt.id);
  assert.equal(settled.state, "confirmed", "the real settlement service must persist an original successful settlement");
  assert.equal(fixture.requests.filter((entry) => entry.path === "/v1/order/create").length, 1, "original settlement must transmit exactly once");
  assert.equal((await pool.query("SELECT state,confirmation_kind FROM toonies_settlements WHERE id=$1", [settlement.id])).rows[0].state, "confirmed");

  const duplicateFixture = await makeServiceFixture("duplicate");
  const duplicateTransport = new TooniesFixtureTransport({
    "/v1/order/create": {
      status: true, code: 200, msg: "duplicate",
      data: { order_sn: "supplier-duplicate", api_order_sn: duplicateFixture.request.api_order_sn, duplicated: true,
        currency: "CNY", product_sum: "3", shipping_fee: "0", sum: "3", status: "paid", pay_status: "paid",
        items: [{ product_code: "P1", sku_code: "S1", num: 1 }] },
    },
    "/v1/order/get": {
      status: true, code: 200, msg: "ok",
      data: { order_sn: "supplier-duplicate", api_order_sn: duplicateFixture.request.api_order_sn,
        currency: "CNY", product_sum: "3", shipping_fee: "0", sum: "3", status: "paid", pay_status: "paid",
        items: [{ product_code: "P1", sku_code: "S1", num: 1 }] },
    },
  });
  setTooniesClient(new TooniesClient({ appKey: "fixture", appSecret: "fixture", transport: duplicateTransport.request, now: () => 1_700_000_000, nonce: () => `${marker}-duplicate`.slice(0, 32) }));
  const duplicateSettled = await settleTooniesProcurementAttempt(duplicateFixture.attemptId);
  assert.equal(duplicateSettled.state, "confirmed");
  assert.equal(duplicateTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, 1);
  assert.equal(duplicateTransport.requests.filter((entry) => entry.path === "/v1/order/get").length, 1, "duplicate confirmation must use exactly one authoritative GET");

  const matchFixture = await makeServiceFixture("reconcile-match");
  const matchData = {
    order_sn: "supplier-reconcile-match", api_order_sn: matchFixture.request.api_order_sn,
    currency: "CNY", product_sum: "3", shipping_fee: "0", sum: "3", status: "paid", pay_status: "paid",
    items: [{ product_code: "P1", sku_code: "S1", num: 1 }],
  };
  const matchTransport = new TooniesFixtureTransport({
    "/v1/order/create": { status: false, code: 50001, msg: "timeout", data: null },
    "/v1/order/list": { status: true, code: 200, msg: "ok", data: { items: [matchData] } },
    "/v1/order/get": { status: true, code: 200, msg: "ok", data: matchData },
  });
  setTooniesClient(new TooniesClient({ appKey: "fixture", appSecret: "fixture", transport: matchTransport.request, now: () => 1_700_000_000, nonce: () => `${marker}-match`.slice(0, 32) }));
  await assert.rejects(() => settleTooniesProcurementAttempt(matchFixture.attemptId), /timeout|failed|50001|Toonies/i);
  const matchCreateCount = matchTransport.requests.filter((entry) => entry.path === "/v1/order/create").length;
  const matched = await reconcileTooniesSettlement(matchFixture.settlementId);
  assert.equal(matched.state, "confirmed");
  assert.equal(matchTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, matchCreateCount);
  assert.equal(matchTransport.requests.filter((entry) => entry.path === "/v1/order/get").length, 1);

  const multipleFixture = await makeServiceFixture("reconcile-multiple");
  const multipleData = { ...matchData, api_order_sn: multipleFixture.request.api_order_sn };
  const multipleTransport = new TooniesFixtureTransport({
    "/v1/order/create": { status: false, code: 50001, msg: "timeout", data: null },
    "/v1/order/list": { status: true, code: 200, msg: "ok", data: { items: [multipleData, { ...multipleData, order_sn: "supplier-reconcile-multiple-2" }] } },
  });
  setTooniesClient(new TooniesClient({ appKey: "fixture", appSecret: "fixture", transport: multipleTransport.request, now: () => 1_700_000_000, nonce: () => `${marker}-multiple`.slice(0, 32) }));
  await assert.rejects(() => settleTooniesProcurementAttempt(multipleFixture.attemptId), /timeout|failed|50001|Toonies/i);
  const multipleCreateCount = multipleTransport.requests.filter((entry) => entry.path === "/v1/order/create").length;
  await assert.rejects(() => reconcileTooniesSettlement(multipleFixture.settlementId), /MULTIPLE|multiple|manual_review/i);
  assert.equal(multipleTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, multipleCreateCount);
  assert.equal((await pool.query("SELECT state FROM toonies_settlements WHERE id=$1", [multipleFixture.settlementId])).rows[0].state, "manual_review");

  const contradictionFixture = await makeServiceFixture("reconcile-contradiction");
  const contradictionData = { ...matchData, api_order_sn: contradictionFixture.request.api_order_sn };
  const contradictionTransport = new TooniesFixtureTransport({
    "/v1/order/create": { status: false, code: 50001, msg: "timeout", data: null },
    "/v1/order/list": { status: true, code: 200, msg: "ok", data: { items: [contradictionData] } },
    "/v1/order/get": { status: true, code: 200, msg: "ok", data: { ...contradictionData, currency: "USD" } },
  });
  setTooniesClient(new TooniesClient({ appKey: "fixture", appSecret: "fixture", transport: contradictionTransport.request, now: () => 1_700_000_000, nonce: () => `${marker}-contradiction`.slice(0, 32) }));
  await assert.rejects(() => settleTooniesProcurementAttempt(contradictionFixture.attemptId), /timeout|failed|50001|Toonies/i);
  const contradictionCreateCount = contradictionTransport.requests.filter((entry) => entry.path === "/v1/order/create").length;
  await assert.rejects(() => reconcileTooniesSettlement(contradictionFixture.settlementId), /MISMATCH|match|contradict|manual_review/i);
  assert.equal(contradictionTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, contradictionCreateCount);
  assert.equal((await pool.query("SELECT state FROM toonies_settlements WHERE id=$1", [contradictionFixture.settlementId])).rows[0].state, "manual_review");

  const timeoutFixture = await makeServiceFixture("timeout");
  const timeoutSuccess = {
    status: true, code: 200, msg: "created",
    data: { order_sn: "supplier-timeout-replay", api_order_sn: timeoutFixture.request.api_order_sn,
      currency: "CNY", product_sum: "3", shipping_fee: "0", sum: "3", status: "paid", pay_status: "paid",
      items: [{ product_code: "P1", sku_code: "S1", num: 1 }] },
  };
  const timeoutTransport = new TooniesFixtureTransport({
    "/v1/order/create": [{ status: false, code: 50001, msg: "timeout", data: null }, timeoutSuccess],
    "/v1/order/list": { status: true, code: 200, msg: "ok", data: { items: [{ api_order_sn: "other" }] } },
  });
  setTooniesClient(new TooniesClient({ appKey: "fixture", appSecret: "fixture", transport: timeoutTransport.request, now: () => 1_700_000_000, nonce: () => `${marker}-timeout`.slice(0, 32) }));
  await assert.rejects(() => settleTooniesProcurementAttempt(timeoutFixture.attemptId), /timeout|failed|50001|Toonies/i);
  assert.equal(timeoutTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, 1);
  const timeoutReconciled = await reconcileTooniesSettlement(timeoutFixture.settlementId);
  assert.equal(timeoutReconciled.found, false, "an exhaustive zero-match reconciliation remains unknown");
  assert.equal(timeoutTransport.requests.filter((entry) => entry.path === "/v1/order/list").length, 1);
  const replayed = await replayTooniesSettlement(timeoutFixture.settlementId);
  assert.equal(replayed.state, "confirmed", "ambiguous timeout replay must confirm through the same durable identity");
  const createBodies = timeoutTransport.requests.filter((entry) => entry.path === "/v1/order/create").map((entry) => entry.body.toString());
  assert.equal(createBodies.length, 2);
  assert.equal(createBodies[0], createBodies[1], "same-task replay must send byte-identical request bytes");
  const replayRequest = JSON.parse(createBodies[1]!);
  assert.equal(replayRequest.task_id, timeoutFixture.request.task_id);
  assert.equal(replayRequest.api_order_sn, timeoutFixture.request.api_order_sn);

  const raceFixture = await makeServiceFixture("race");
  const raceTransport = new TooniesFixtureTransport({
    "/v1/order/create": {
      status: true, code: 200, msg: "created",
      data: { order_sn: "supplier-race", api_order_sn: raceFixture.request.api_order_sn,
        currency: "CNY", product_sum: "3", shipping_fee: "0", sum: "3", status: "paid", pay_status: "paid",
        items: [{ product_code: "P1", sku_code: "S1", num: 1 }] },
    },
  });
  setTooniesClient(new TooniesClient({ appKey: "fixture", appSecret: "fixture", transport: raceTransport.request, now: () => 1_700_000_000, nonce: () => `${marker}-race`.slice(0, 32) }));
  const raceResults = await Promise.allSettled([
    settleTooniesProcurementAttempt(raceFixture.attemptId),
    settleTooniesProcurementAttempt(raceFixture.attemptId),
  ]);
  assert.equal(raceTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, 1, "concurrent settlement workers must issue exactly one create");
  assert.ok(raceResults.some((result) => result.status === "fulfilled"), "one worker must complete the settlement");
  assert.equal(
    (await pool.query("SELECT state FROM toonies_settlements WHERE attempt_id=$1", [raceFixture.attemptId])).rows[0]?.state,
    "confirmed",
    "the winning worker must persist the durable confirmed result",
  );

  // A real worker can return successfully from Toonies after recovery has
  // taken ownership. Pause after response validation (before authoritative
  // persistence), recover the expired lease through the production recovery
  // service, then prove the stale worker cannot confirm or release authority.
  const staleFixture = await makeServiceFixture("stale-worker");
  const staleResponse = {
    status: true, code: 200, msg: "created",
    data: {
      order_sn: "supplier-stale-worker", api_order_sn: staleFixture.request.api_order_sn,
      currency: "CNY", product_sum: "3", shipping_fee: "0", sum: "3",
      status: "paid", pay_status: "paid",
      items: [{ product_code: "P1", sku_code: "S1", num: 1 }],
    },
  };
  const staleTransport = new TooniesFixtureTransport({ "/v1/order/create": staleResponse });
  setTooniesClient(new TooniesClient({
    appKey: "fixture", appSecret: "fixture", transport: staleTransport.request,
    now: () => 1_700_000_000, nonce: () => `${marker}-stale-worker`.slice(0, 32),
  }));
  let releaseStaleWorker!: () => void;
  let staleWorkerPaused!: () => void;
  const stalePauseEntered = new Promise<void>((resolve) => { staleWorkerPaused = resolve; });
  const stalePauseReleased = new Promise<void>((resolve) => { releaseStaleWorker = resolve; });
  setTooniesSettlementTestPauseAfterResponse(async () => {
    staleWorkerPaused();
    await stalePauseReleased;
  });
  const staleWorker = settleTooniesProcurementAttempt(staleFixture.attemptId);
  await stalePauseEntered;
  const staleBeforeRecovery = (await pool.query<any>(
    "SELECT state,version,lease_token,order_sn,product_sum,shipping_fee,total_sum,expected_product_sum,expected_shipping_fee,expected_total_sum,api_order_sn FROM toonies_settlements WHERE id=$1",
    [staleFixture.settlementId],
  )).rows[0];
  assert.equal(staleBeforeRecovery.state, "submitting");
  assert.equal(staleBeforeRecovery.order_sn, null);
  await pool.query("UPDATE toonies_settlements SET lease_until=now()-interval '1 second' WHERE id=$1", [staleFixture.settlementId]);
  assert.equal(await recoverExpiredTooniesSubmittingSettlements(), 1, "recovery must obtain the newer settlement version");
  const staleAfterRecovery = (await pool.query<any>(
    "SELECT state,version,lease_token,order_sn,product_sum,total_sum FROM toonies_settlements WHERE id=$1",
    [staleFixture.settlementId],
  )).rows[0];
  assert.equal(staleAfterRecovery.state, "transmitted_unknown");
  assert.equal(staleAfterRecovery.version > staleBeforeRecovery.version, true);
  const staleEvidenceAfterRecovery = (await pool.query<any>(
    "SELECT event_type,response_hash,details FROM toonies_settlement_evidence WHERE settlement_id=$1 ORDER BY created_at,id",
    [staleFixture.settlementId],
  )).rows;
  assert.equal(staleEvidenceAfterRecovery.at(-1)?.event_type, "expired_submission_recovered");
  releaseStaleWorker();
  await assert.rejects(staleWorker, /lease|owned|lost/i);
  setTooniesSettlementTestPauseAfterResponse(undefined);
  const staleAfterLateWrite = (await pool.query<any>(
    "SELECT state,version,confirmation_kind,lease_token,order_sn,trade_order_sn,product_sum,shipping_fee,total_sum,expected_product_sum,expected_shipping_fee,expected_total_sum,api_order_sn FROM toonies_settlements WHERE id=$1",
    [staleFixture.settlementId],
  )).rows[0];
  assert.equal(staleAfterLateWrite.state, "transmitted_unknown");
  assert.equal(staleAfterLateWrite.confirmation_kind, null);
  assert.equal(staleAfterLateWrite.lease_token, null);
  assert.equal(staleAfterLateWrite.order_sn, null);
  assert.equal(staleAfterLateWrite.trade_order_sn, null);
  assert.equal(staleAfterLateWrite.product_sum, null);
  assert.equal(staleAfterLateWrite.shipping_fee, null);
  assert.equal(staleAfterLateWrite.total_sum, null);
  assert.equal(staleAfterLateWrite.expected_product_sum, staleBeforeRecovery.expected_product_sum);
  assert.equal(staleAfterLateWrite.expected_shipping_fee, staleBeforeRecovery.expected_shipping_fee);
  assert.equal(staleAfterLateWrite.expected_total_sum, staleBeforeRecovery.expected_total_sum);
  assert.equal(staleAfterLateWrite.api_order_sn, staleBeforeRecovery.api_order_sn);
  assert.equal(staleTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, 1, "stale worker must not authorize another transmission");
  assert.deepEqual(
    (await pool.query<any>(
      "SELECT event_type,response_hash,details FROM toonies_settlement_evidence WHERE settlement_id=$1 ORDER BY created_at,id",
      [staleFixture.settlementId],
    )).rows,
    staleEvidenceAfterRecovery,
    "stale worker must not overwrite or append newer recovery evidence",
  );
  const staleReservation = (await pool.query<any>(
    "SELECT state,phase,transmission_started_at,completed_at FROM financial_operation_reservations WHERE order_id=$1 AND operation_type='supplier_settlement'",
    [staleFixture.orderId],
  )).rows[0];
  assert.equal(staleReservation.state, "active", "stale worker must not complete or release financial authority");
  assert.equal(staleReservation.phase, "transmitting");
  assert.ok(staleReservation.transmission_started_at);
  assert.equal(staleReservation.completed_at, null);

  // Scenario 2: invalidated-payment recovery and supplier settlement must
  // have one financial authority, regardless of acquisition order.
  const recoveryFirst = await makeServiceFixture("recovery-first");
  const recoveryFirstPayment = (await pool.query<any>(
    "SELECT id,provider_payment_id AS \"providerPaymentId\" FROM payments WHERE order_id=$1", [recoveryFirst.orderId],
  )).rows[0];
  const recoveryFirstProviderId = `fake_pi_succeeded_300_EUR_${recoveryFirst.orderId}`;
  await pool.query("UPDATE payments SET provider_payment_id=$1 WHERE id=$2", [recoveryFirstProviderId, recoveryFirstPayment.id]);
  const recoveryFirstRefundsBefore = getFakePaymentRefundTotalForTest();
  const recoveryFirstTransport = new TooniesFixtureTransport({});
  setTooniesClient(new TooniesClient({
    appKey: "fixture", appSecret: "fixture", transport: recoveryFirstTransport.request,
    now: () => 1_700_000_000, nonce: () => `${marker}-recovery-first`.slice(0, 32),
  }));
  let releaseRecoveryFirst!: () => void;
  let recoveryFirstPaused!: () => void;
  const recoveryFirstPauseEntered = new Promise<void>((resolve) => { recoveryFirstPaused = resolve; });
  const recoveryFirstPauseReleased = new Promise<void>((resolve) => { releaseRecoveryFirst = resolve; });
  setFinancialOperationTestPause(async () => {
    recoveryFirstPaused();
    await recoveryFirstPauseReleased;
  });
  const recoveryFirstRun = recoverInvalidatedPayment(recoveryFirstPayment.id);
  await recoveryFirstPauseEntered;
  const recoveryFirstSettlement = await Promise.allSettled([
    settleTooniesProcurementAttempt(recoveryFirst.attemptId),
  ]);
  assert.equal(recoveryFirstSettlement[0]?.status, "rejected", "settlement must lose to the durable invalidation reservation");
  assert.equal(recoveryFirstTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, 0);
  assert.equal(recoveryFirstTransport.requests.filter((entry) => entry.path === "/v1/order/get").length, 0);
  assert.equal(recoveryFirstTransport.requests.filter((entry) => entry.path === "/v1/order/list").length, 0);
  releaseRecoveryFirst();
  await recoveryFirstRun;
  setFinancialOperationTestPause(undefined);
  assert.equal(getFakePaymentLookupCountForTest(recoveryFirstProviderId), 1, "recovery-first must use one provider lookup");
  assert.equal(getFakePaymentCancelCountForTest(recoveryFirstProviderId), 0);
  assert.equal(getFakePaymentRefundTotalForTest() - recoveryFirstRefundsBefore, 1, "recovery-first must perform one provider refund");
  const recoveryFirstAuthorities = (await pool.query<any>(
    "SELECT operation_type,state FROM financial_operation_reservations WHERE order_id=$1",
    [recoveryFirst.orderId],
  )).rows;
  assert.deepEqual(recoveryFirstAuthorities.map((row) => `${row.operation_type}:${row.state}`), ["payment_invalidation:released"]);

  const settlementFirst = await makeServiceFixture("settlement-first");
  const settlementFirstPayment = (await pool.query<any>(
    "SELECT id FROM payments WHERE order_id=$1", [settlementFirst.orderId],
  )).rows[0];
  const settlementFirstProviderId = `fake_pi_succeeded_300_EUR_${settlementFirst.orderId}`;
  await pool.query("UPDATE payments SET provider_payment_id=$1 WHERE id=$2", [settlementFirstProviderId, settlementFirstPayment.id]);
  const settlementFirstTransport = new TooniesFixtureTransport({
    "/v1/order/create": {
      status: true, code: 200, msg: "created",
      data: {
        order_sn: "supplier-settlement-first", api_order_sn: settlementFirst.request.api_order_sn,
        currency: "CNY", product_sum: "3", shipping_fee: "0", sum: "3",
        status: "paid", pay_status: "paid",
        items: [{ product_code: "P1", sku_code: "S1", num: 1 }],
      },
    },
  });
  setTooniesClient(new TooniesClient({
    appKey: "fixture", appSecret: "fixture", transport: settlementFirstTransport.request,
    now: () => 1_700_000_000, nonce: () => `${marker}-settlement-first`.slice(0, 32),
  }));
  let releaseSettlementFirst!: () => void;
  let settlementFirstPaused!: () => void;
  const settlementFirstPauseEntered = new Promise<void>((resolve) => { settlementFirstPaused = resolve; });
  const settlementFirstPauseReleased = new Promise<void>((resolve) => { releaseSettlementFirst = resolve; });
  setFinancialOperationTestPause(async () => {
    settlementFirstPaused();
    await settlementFirstPauseReleased;
  });
  const settlementFirstRun = settleTooniesProcurementAttempt(settlementFirst.attemptId);
  await settlementFirstPauseEntered;
  const refundsBeforeSettlementFirstRecovery = getFakePaymentRefundTotalForTest();
  const lookupBeforeSettlementFirstRecovery = getFakePaymentLookupCountForTest(settlementFirstProviderId);
  const settlementFirstRecovery = await Promise.allSettled([
    recoverInvalidatedPayment(settlementFirstPayment.id),
  ]);
  assert.equal(settlementFirstRecovery[0]?.status, "rejected", "invalidation must lose to the durable settlement reservation");
  assert.equal(getFakePaymentRefundTotalForTest() - refundsBeforeSettlementFirstRecovery, 0);
  assert.equal(getFakePaymentLookupCountForTest(settlementFirstProviderId) - lookupBeforeSettlementFirstRecovery, 0);
  assert.equal(getFakePaymentCancelCountForTest(settlementFirstProviderId), 0);
  const settlementFirstAuthorities = (await pool.query<any>(
    "SELECT operation_type,state,phase FROM financial_operation_reservations WHERE order_id=$1",
    [settlementFirst.orderId],
  )).rows;
  assert.deepEqual(settlementFirstAuthorities.map((row) => `${row.operation_type}:${row.state}:${row.phase}`), ["supplier_settlement:active:transmitting"]);
  releaseSettlementFirst();
  await settlementFirstRun;
  setFinancialOperationTestPause(undefined);
  assert.equal(settlementFirstTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, 1);
  console.log("Scenario 2 external call counts", JSON.stringify({
    recoveryFirst: {
      tooniesCreate: recoveryFirstTransport.requests.filter((entry) => entry.path === "/v1/order/create").length,
      tooniesGet: recoveryFirstTransport.requests.filter((entry) => entry.path === "/v1/order/get").length,
      tooniesList: recoveryFirstTransport.requests.filter((entry) => entry.path === "/v1/order/list").length,
      providerLookup: getFakePaymentLookupCountForTest(recoveryFirstProviderId),
      providerRefund: getFakePaymentRefundCountForTest(`hold-race-refund:${recoveryFirstPayment.id}`),
      providerCancel: getFakePaymentCancelCountForTest(recoveryFirstProviderId),
    },
    settlementFirst: {
      tooniesCreate: settlementFirstTransport.requests.filter((entry) => entry.path === "/v1/order/create").length,
      tooniesGet: settlementFirstTransport.requests.filter((entry) => entry.path === "/v1/order/get").length,
      tooniesList: settlementFirstTransport.requests.filter((entry) => entry.path === "/v1/order/list").length,
      providerLookup: getFakePaymentLookupCountForTest(settlementFirstProviderId),
      providerRefund: getFakePaymentRefundTotalForTest() - refundsBeforeSettlementFirstRecovery,
      providerCancel: getFakePaymentCancelCountForTest(settlementFirstProviderId),
    },
  }));

  const reservationRaceFixture = await makeServiceFixture("reservation-race");
  const reservationRacePayment = (await pool.query<any>("SELECT id FROM payments WHERE order_id=$1", [reservationRaceFixture.orderId])).rows[0];
  const reservationRaceTransport = new TooniesFixtureTransport({
    "/v1/order/create": {
      status: true, code: 200, msg: "created",
      data: { order_sn: "supplier-reservation-race", api_order_sn: reservationRaceFixture.request.api_order_sn,
        currency: "CNY", product_sum: "3", shipping_fee: "0", sum: "3", status: "paid", pay_status: "paid",
        items: [{ product_code: "P1", sku_code: "S1", num: 1 }] },
    },
  });
  setTooniesClient(new TooniesClient({ appKey: "fixture", appSecret: "fixture", transport: reservationRaceTransport.request, now: () => 1_700_000_000, nonce: () => `${marker}-reservation-race`.slice(0, 32) }));
  const refundsBefore = getFakePaymentRefundTotalForTest();
  const reservationRaceResults = await Promise.allSettled([
    settleTooniesProcurementAttempt(reservationRaceFixture.attemptId),
    createRefund(reservationRacePayment.id, 3, `${marker}-reservation-race-refund`),
  ]);
  const reservationCreateCalls = reservationRaceTransport.requests.filter((entry) => entry.path === "/v1/order/create").length;
  const reservationRefundCalls = getFakePaymentRefundTotalForTest() - refundsBefore;
  assert.ok((reservationCreateCalls === 1 && reservationRefundCalls === 0) || (reservationCreateCalls === 0 && reservationRefundCalls === 1), "exactly one side may perform external financial I/O");
  assert.ok(reservationRaceResults.some((result) => result.status === "fulfilled") || reservationCreateCalls + reservationRefundCalls === 1, "a reservation winner must be observable even when the loser is rejected");

  const refundFirstFixture = await makeServiceFixture("refund-first");
  const refundFirstPayment = (await pool.query<any>("SELECT id FROM payments WHERE order_id=$1", [refundFirstFixture.orderId])).rows[0];
  const refundFirstTransport = new TooniesFixtureTransport({
    "/v1/order/create": {
      status: true, code: 200, msg: "created",
      data: { order_sn: "supplier-refund-first", api_order_sn: refundFirstFixture.request.api_order_sn,
        currency: "CNY", product_sum: "3", shipping_fee: "0", sum: "3", status: "paid", pay_status: "paid",
        items: [{ product_code: "P1", sku_code: "S1", num: 1 }] },
    },
  });
  setTooniesClient(new TooniesClient({ appKey: "fixture", appSecret: "fixture", transport: refundFirstTransport.request, now: () => 1_700_000_000, nonce: () => `${marker}-refund-first`.slice(0, 32) }));
  const refundFirstBefore = getFakePaymentRefundTotalForTest();
  const refundFirstResult = await createRefund(refundFirstPayment.id, 3, `${marker}-refund-first-key`);
  assert.equal((await pool.query("SELECT status FROM refunds WHERE payment_id=$1", [refundFirstPayment.id])).rows[0].status, "completed");
  const refundFirstSettlement = await Promise.allSettled([settleTooniesProcurementAttempt(refundFirstFixture.attemptId)]);
  assert.equal(refundFirstTransport.requests.filter((entry) => entry.path === "/v1/order/create").length, 0, "refund-first reservation blocks Toonies before create");
  assert.equal(getFakePaymentRefundTotalForTest() - refundFirstBefore, 1);
  assert.equal(refundFirstSettlement[0].status, "rejected");
  const original = await client.create(request) as any;
  assert.equal(original.api_order_sn, identity);
  const duplicate = await client.create(request) as any;
  assert.equal(duplicate.duplicated, true);
  assert.equal(fixture.requests[0]!.body.toString(), fixture.requests[1]!.body.toString(), "duplicate/replay keeps exact bytes");
  const fetched = await client.getOrder({ order_sn: "supplier-1" }) as any;
  assert.equal(fetched.api_order_sn, identity);
  assert.equal(fetched.currency, "CNY");
  assert.equal(fetched.product_sum, "3.000000");
  assert.equal(fetched.shipping_fee, "0.000000");
  assert.equal(fetched.sum, "3.000000");
  assert.equal(fetched.status, "paid");
  assert.equal(fetched.pay_status, "paid");
  assert.deepEqual(fetched.items, [{ product_code: "P1", sku_code: "S1", num: 1 }]);
  for (let index = 1; index <= 10; index += 1) await client.listOrders({ page: index, page_size: 50, date_start: 1, date_end: 2 });
  assert.equal(fixture.requests.filter((entry) => entry.path === "/v1/order/list").length, 10);
  assert.equal(fixture.requests.some((entry) => entry.path === "/v1/order/list"), true);
  await assert.rejects(() => (client as any).call("/v1/order/bad", {}, false), (error: unknown) => error instanceof TooniesError && error.code === 40031);
  await assert.rejects(() => (client as any).call("/v1/order/expired", {}, false), (error: unknown) => error instanceof TooniesError && error.code === 40042);
  const noLive = new TooniesClient({ appKey: "fixture", appSecret: "fixture" });
  await assert.rejects(() => noLive.search({ keyword: `${marker}-must-not-use-network` }), (error: unknown) => error instanceof TooniesError && error.code === 50001);

  // Pure semantic regressions cover wrong identity/status/pay status/currency,
  // product sum, non-zero shipping, duplicate/missing/skipped basket; these
  // are exercised by the persisted exact-facts and fixture response variants.
  assert.equal(validTooniesSettlementPartialPredicate("(state = ANY (ARRAY['confirmed'::toonies_settlement_state]::toonies_settlement_state[]))"), false);
  const gate = await getTooniesSettlementGateStatus({ forceRefresh: true });
  assert.equal(gate.configured, "enabled");
  assert.equal(gate.effective, "enabled", `development migration attestation failed: ${gate.reason}`);
  // Fail-closed gate matrix: disabled configuration and either attestation
  // failure (including the financial-interlock attestation path) cannot
  // authorize a transport call. These resolver checks intentionally run
  // without touching a provider.
  const gateTransportCreateCount = fixture.requests.filter((entry) => entry.path === "/v1/order/create").length;
  for (const disabled of [
    resolveTooniesProcurementGateStatus(false, false),
    resolveTooniesProcurementGateStatus(true, false),
  ]) {
    assert.equal(disabled.effective, "disabled");
    assert.equal(fixture.requests.filter((entry) => entry.path === "/v1/order/create").length, gateTransportCreateCount);
  }
  await assert.rejects(() => reconcileTooniesSettlement(settlement.id), /confirmed|unresolved|not found|state/i);
  await assert.rejects(() => replayTooniesSettlement(settlement.id), /confirmed|unresolved|not found|state/i);

  console.log("Toonies Stage 3 DB-backed fixture integration passed.");
}

try {
  await run();
} finally {
  await cleanup?.();
  await closeDatabase();
}