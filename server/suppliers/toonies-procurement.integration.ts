import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";
import {
  createTooniesProcurementAttempt,
  getTooniesProcurementAttempt,
  pollTooniesProcurementAttempt,
  runTooniesProcurementPollingCycle,
} from "./toonies-procurement-service.js";
import { setTooniesClient } from "./toonies-service.js";
import { loadTooniesSupplierSnapshotFingerprint } from "./toonies-snapshot.js";
import { TooniesClient, TooniesFixtureTransport, type TooniesTransport } from "./toonies.js";
import { env } from "../config/env.js";
import { resetTooniesProcurementGateCacheForTests } from "./toonies-procurement-gate.js";

const marker = `procurement-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = "ProcurementIntegration1";

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
    return { response, body: response.status === 204 ? null : await response.json() };
  }
}

async function run(): Promise<void> {
  assertMutableIntegrationTestDatabase("Toonies procurement");
  const pool = getDatabasePool();
  const owned = { users: [] as string[], roles: [] as string[], products: [] as string[], variants: [] as string[], catalogue: [] as string[], catalogueVariants: [] as string[], links: [] as string[], attempts: [] as string[], orders: [] as string[], payments: [] as string[] };
  let taskCounter = 0;
  const nextTask = () => `f-${Date.now()}-${taskCounter++}`;
  let server: Server | undefined;
  try {
    const supplier = (await pool.query<{ id: string }>("SELECT id FROM suppliers WHERE slug='toonies' AND active=true")).rows[0];
    const category = (await pool.query<{ id: string }>("SELECT id FROM categories WHERE parent_id IS NULL AND active=true ORDER BY id LIMIT 1")).rows[0];
    assert.ok(supplier && category, "canonical Toonies supplier/category are required");
    const warehouse = (await pool.query<{ id: string }>("SELECT id FROM warehouses ORDER BY id LIMIT 1")).rows[0];

    const startupFixture = new TooniesFixtureTransport({});
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: startupFixture.request }));
    const startupCycle = await runTooniesProcurementPollingCycle(20);
    assert.equal(startupCycle.claimed, 0, "startup with no eligible attempts must claim no supplier work");
    assert.equal(startupFixture.requests.length, 0, "startup with no eligible attempts must issue no supplier requests");

    const productData: Array<{ product: string; variant: string; code: string; sku: string }> = [];
    for (const [index, title] of ["Multi Product A", "Multi Product B"].entries()) {
      const catalogue = (await pool.query<{ id: string }>(
        `INSERT INTO supplier_catalogue_items
          (supplier_id,external_product_id,external_category_id,title,original_amount,original_currency,normalized_eur,normalized_currency,minimum_order_quantity,stock,state,needs_review)
         VALUES($1,$2,$3,$4,.49,'CNY',.49,'EUR',1,100,'Synced',false) RETURNING id`,
        [supplier.id, `${marker}-product-${index}`, `${marker}-category-${index}`, `${marker} ${title}`],
      )).rows[0]!.id;
      owned.catalogue.push(catalogue);
      const sku = `${marker}-external-${index}`;
      const catalogueVariant = (await pool.query<{ id: string }>(
        `INSERT INTO supplier_catalogue_variants
          (supplier_id,catalogue_item_id,external_variant_id,sku_code,title,attributes,original_amount,original_currency,normalized_eur,normalized_currency,minimum_order_quantity,weight_kg,stock,state,needs_review)
         VALUES($1,$2,$3,$3,$4,'[]'::jsonb,.49,'CNY',.49,'EUR',1,.2,100,'Synced',false) RETURNING id`,
        [supplier.id, catalogue, `${marker}-external-${index}`, `${marker} ${title}`],
      )).rows[0]!.id;
      owned.catalogueVariants.push(catalogueVariant);
      const product = (await pool.query<{ id: string }>(
        `INSERT INTO products(name,slug,parent_sku,category_id,description,status,cost_price,base_price,vat_rate,weight,published_at)
         VALUES($1::text,$2,$3,$4,$1::text,'active',.49,.98,0,.2,NULL) RETURNING id`,
        [`${marker} ${title}`, `${marker}-product-${index}`, `${marker}-parent-${index}`, category.id],
      )).rows[0]!.id;
      owned.products.push(product);
      const variant = (await pool.query<{ id: string }>(
        `INSERT INTO product_variants(product_id,sku,title,cost_price,base_price,weight,minimum_order_quantity,active)
         VALUES($1,$2,$3,.49,.98,.2,1,true) RETURNING id`,
        [product, `${marker}-local-${index}`, title],
      )).rows[0]!.id;
      owned.variants.push(variant);
      const link = (await pool.query<{ id: string }>(
        `INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [supplier.id, catalogue, catalogueVariant, product, variant],
      )).rows[0]!.id;
      owned.links.push(link);
      if (warehouse) await pool.query("INSERT INTO inventory(warehouse_id,variant_id,quantity_on_hand,quantity_reserved,active) VALUES($1,$2,10,0,true)", [warehouse.id, variant]);
      productData.push({ product, variant, code: `${marker}-product-${index}`, sku });
    }

    const actor = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,'Procurement','Admin','active',now()) RETURNING id",
      [`${marker}@example.test`, await hashPassword(password)],
    )).rows[0]!.id;
    owned.users.push(actor);
    const role = (await pool.query<{ id: string }>("INSERT INTO admin_roles(name) VALUES($1) RETURNING id", [`${marker} role`])).rows[0]!.id;
    owned.roles.push(role);
    await pool.query("INSERT INTO admin_user_roles(user_id,role_id) VALUES($1,$2)", [actor, role]);
    await pool.query("INSERT INTO admin_role_permissions(role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key=ANY($2::text[])", [role, ["supplier_integrations.view", "supplier_integrations.sync"]]);

    const before = await pool.query(
      `SELECT (SELECT count(*) FROM payments) payments,(SELECT count(*) FROM inventory_movements) movements,
              (SELECT count(*) FROM shipments) shipments,(SELECT count(*) FROM supplier_catalogue_items) catalogue,
              (SELECT count(*) FROM supplier_price_change_reviews) reviews`,
    );

    const taskId = `task-${Date.now()}`;
    const fixture = new TooniesFixtureTransport({
      "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: taskId, client_task_no: "ignored", status: "pending", item_count: 2 } },
      "/v1/order/task": [
        { status: false, code: 40040, msg: "not ready", data: null },
        { status: true, code: 200, msg: "ok", data: {
          task_id: taskId, status: "ready", expired: false, item_count: 2, ok_count: 2,
          date_expire: Math.floor(Date.now() / 1000) + 900,
          items: productData.map((line) => ({ product_code: line.code, sku_code: line.sku, num: 1, ok: true, moq: 1, stock: 100, charge: 2.5, subtotal: 2.5, weight: .2 })),
        } },
      ],
    });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: fixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));

    const input = { lines: productData.map((line) => ({ productId: line.product, variantId: line.variant, quantity: 1 })) };
    const created = await createTooniesProcurementAttempt(input, actor) as any;
    owned.attempts.push(created.id);
    assert.equal(created.state, "task_pending");
    const pending = await pollTooniesProcurementAttempt(created.id, 1);
    assert.equal(pending.state, "task_pending");
    const ready = await pollTooniesProcurementAttempt(created.id, 1);
    assert.equal(ready.state, "ready");
    assert.deepEqual(
      ready.lines.map((line: any) => [line.productCode, line.skuCode, line.requestedQuantity, line.returnedQuantity, line.returnedMoq, line.returnedStock]).sort(),
      productData.map((line) => [line.code, line.sku, 1, 1, 1, 100]).sort(),
    );
    assert.ok(fixture.requests.every((request) => request.path === "/v1/order/precheck" || request.path === "/v1/order/task"));
    assert.equal(fixture.requests.some((request) => request.path === "/v1/order/create"), false);

    const replay = await createTooniesProcurementAttempt(input, actor) as any;
    assert.equal(replay.id, created.id);
    assert.equal(fixture.requests.filter((request) => request.path === "/v1/order/precheck").length, 1);
    const concurrent = await Promise.all([createTooniesProcurementAttempt(input, actor), createTooniesProcurementAttempt(input, actor)]);
    assert.equal(new Set(concurrent.map((attempt: any) => attempt.id)).size, 1);
    assert.equal(fixture.requests.filter((request) => request.path === "/v1/order/precheck").length, 1);

    const generationInput = { lines: [{ productId: productData[0]!.product, variantId: productData[0]!.variant, quantity: 8 }] };
    const generationOneTask = nextTask();
    const generationOneFixture = new TooniesFixtureTransport({
      "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: generationOneTask, status: "pending", item_count: 1 } },
      "/v1/order/task": { status: true, code: 200, msg: "ok", data: {
        task_id: generationOneTask, status: "ready", item_count: 1, ok_count: 1, date_expire: Math.floor(Date.now() / 1000) + 900,
        items: [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 8, ok: true, moq: 1, stock: 100, charge: 20 }],
      } },
    });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: generationOneFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    const generationOne = await createTooniesProcurementAttempt(generationInput, actor) as any;
    owned.attempts.push(generationOne.id);
    assert.equal((await pollTooniesProcurementAttempt(generationOne.id, 1)).state, "ready");
    await pool.query("UPDATE toonies_procurement_attempts SET snapshot_expires_at=now()-interval '1 second' WHERE id=$1", [generationOne.id]);
    assert.equal((await getTooniesProcurementAttempt(generationOne.id)).state, "expired");
    const generationTwoTask = nextTask();
    const generationTwoFixture = new TooniesFixtureTransport({
      "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: generationTwoTask, status: "pending", item_count: 1 } },
    });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: generationTwoFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    const generationTwo = await createTooniesProcurementAttempt(generationInput, actor) as any;
    owned.attempts.push(generationTwo.id);
    assert.notEqual(generationTwo.id, generationOne.id);
    assert.notEqual(generationTwo.clientTaskNo, generationOne.clientTaskNo);
    assert.equal(generationTwo.generation, 2);

    let releaseTask!: () => void;
    let taskStarted!: () => void;
    const delayed = new Promise<void>((resolve) => { releaseTask = resolve; });
    const started = new Promise<void>((resolve) => { taskStarted = resolve; });
    const staleTask = nextTask();
    const staleTransport: TooniesTransport = async (request) => {
      if (request.path === "/v1/order/precheck") {
        return { envelope: { status: true, code: 200, msg: "ok", data: { task_id: staleTask, status: "pending", item_count: 1 } } };
      }
      taskStarted();
      await delayed;
      return { envelope: { status: true, code: 200, msg: "ok", data: {
        task_id: staleTask, status: "ready", item_count: 1, ok_count: 1, date_expire: Math.floor(Date.now() / 1000) + 900,
        items: [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 9, ok: true, moq: 1, stock: 100, charge: 22.5 }],
      } } };
    };
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: staleTransport, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    const staleAttempt = await createTooniesProcurementAttempt({ lines: [{ productId: productData[0]!.product, variantId: productData[0]!.variant, quantity: 9 }] }, actor) as any;
    owned.attempts.push(staleAttempt.id);
    const stalePoll = pollTooniesProcurementAttempt(staleAttempt.id, 1);
    await started;
    await pool.query("UPDATE toonies_procurement_attempts SET lease_token='replacement-owner',lease_until=now()+interval '60 seconds' WHERE id=$1", [staleAttempt.id]);
    releaseTask();
    const staleResult = await stalePoll;
    assert.equal(staleResult.state, "task_pending");
    assert.equal(staleResult.lines[0].orderable, null);
    await pool.query("UPDATE toonies_procurement_attempts SET lease_token=NULL,lease_until=NULL WHERE id=$1", [staleAttempt.id]);

    const after = await pool.query(
      `SELECT (SELECT count(*) FROM payments) payments,(SELECT count(*) FROM inventory_movements) movements,
              (SELECT count(*) FROM shipments) shipments,(SELECT count(*) FROM supplier_catalogue_items) catalogue,
              (SELECT count(*) FROM supplier_price_change_reviews) reviews`,
    );
    assert.deepEqual(after.rows[0], before.rows[0]);

    const orderFingerprint = "a".repeat(64);
    await pool.query("INSERT INTO supplier_pricing_rules(supplier_id,name,rule_type,min_cost_eur,max_cost_eur,value,rounding_mode,priority,active,significant_cost_increase_percent) VALUES($1,$2,'markup_percent',0,100,1,'none',-100,true,20)", [supplier.id, `${marker} order band`]);
    const order = (await pool.query<{ id: string }>(
      `INSERT INTO orders(order_number,guest_email,status,payment_status,fulfillment_status,fulfillment_stage,currency,subtotal,discount_total,shipping_total,tax_total,grand_total,total_fingerprint,billing_address_snapshot,shipping_address_snapshot)
       VALUES($1,$2,'confirmed','paid','unfulfilled','unfulfilled','EUR',3.00,0,.50,0,3.50,$3,'{}'::jsonb,'{}'::jsonb) RETURNING id`,
      [`ord-${Date.now()}`, `${marker}@example.test`, orderFingerprint],
    )).rows[0]!.id;
    owned.orders.push(order);
    await pool.query(
      `INSERT INTO order_items(order_id,product_id,variant_id,sku_snapshot,product_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total,supplier_product_link_id,supplier_id,supplier_catalogue_item_id,supplier_catalogue_variant_id,supplier_product_code,supplier_sku_code,supplier_cost_eur,supplier_cost_cny,supplier_cost_provenance,supplier_cost_threshold_percent)
       VALUES($1,$2,$3,'snapshot','snapshot',2,1.00,.49,0,2.00,$4,$5,$6,$7,$8,$9,'0.49','0.49',$10,'20')`,
      [order, productData[0]!.product, productData[0]!.variant, owned.links[0], supplier.id, owned.catalogue[0], owned.catalogueVariants[0], productData[0]!.code, productData[0]!.sku, JSON.stringify({ source: "fixture", fxRateSnapshotId: null })],
    );
    await pool.query(
      `INSERT INTO order_items(order_id,product_id,variant_id,sku_snapshot,product_name_snapshot,quantity,unit_price,cost_price_snapshot,tax_rate_snapshot,line_total)
       VALUES($1,$2,$3,'snapshot','snapshot',1,1.00,.49,0,1.00)`,
      [order, productData[1]!.product, productData[1]!.variant],
    );
    const payment = (await pool.query<{ id: string }>(
      `INSERT INTO payments(order_id,provider,amount,currency,status,order_total_fingerprint,provider_payment_id)
       VALUES($1,'fixture',3.50,'EUR','paid',$2,$3) RETURNING id`, [order, orderFingerprint, `${marker}-payment`],
    )).rows[0]!.id;
    owned.payments.push(payment);
    const supplierSnapshotFingerprint = await loadTooniesSupplierSnapshotFingerprint(pool, order);
    await pool.query(
      "UPDATE toonies_procurement_attempts SET next_poll_at=now()+interval '1 hour' WHERE state IN ('precheck_pending','task_pending','retry_wait')",
    );
    const mismatchedFingerprintFixture = new TooniesFixtureTransport({});
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: mismatchedFingerprintFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    await pool.query(
      "INSERT INTO toonies_procurement_commands(order_id,order_total_fingerprint,supplier_snapshot_fingerprint) VALUES($1,$2,$3)",
      [order, orderFingerprint, "f".repeat(64)],
    );
    await runTooniesProcurementPollingCycle(20);
    const rejectedFingerprintCommand = (await pool.query("SELECT state,last_error AS \"lastError\" FROM toonies_procurement_commands WHERE order_id=$1", [order])).rows[0];
    assert.equal(rejectedFingerprintCommand.state, "failed");
    assert.match(rejectedFingerprintCommand.lastError, /snapshot fingerprint mismatch/i);
    assert.equal(mismatchedFingerprintFixture.requests.length, 0);
    await pool.query("DELETE FROM toonies_procurement_commands WHERE order_id=$1", [order]);
    await pool.query("INSERT INTO toonies_procurement_commands(order_id,order_total_fingerprint,supplier_snapshot_fingerprint) VALUES($1,$2,$3)", [order, orderFingerprint, supplierSnapshotFingerprint]);
    const orderTask = nextTask();
    const orderFixture = new TooniesFixtureTransport({
      "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: orderTask, status: "pending", item_count: 1 } },
      "/v1/order/task": { status: true, code: 200, msg: "ok", data: { task_id: orderTask, status: "ready", item_count: 1, ok_count: 1, date_expire: Math.floor(Date.now() / 1000) + 900, items: [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 2, ok: true, moq: 1, stock: 10, charge: "0.49", subtotal: "0.98", weight: "0.2" }] } },
    });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: orderFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    const orderBefore = (await pool.query("SELECT grand_total,shipping_total,payment_status,fulfillment_status FROM orders WHERE id=$1", [order])).rows[0];
    const orderCycle = await runTooniesProcurementPollingCycle(20);
    assert.ok(orderCycle.claimed >= 1);
    const orderAttempt = (await pool.query("SELECT id,order_id AS \"orderId\",state FROM toonies_procurement_attempts WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1", [order])).rows[0] as any;
    owned.attempts.push(orderAttempt.id);
    assert.equal(orderAttempt.orderId, order);
    await runTooniesProcurementPollingCycle(20);
    const orderReady = await getTooniesProcurementAttempt(orderAttempt.id);
    assert.equal(orderReady.state, "ready");
    assert.equal(orderFixture.requests[0]?.path, "/v1/order/precheck");
    assert.deepEqual(JSON.parse(orderFixture.requests[0]!.body.toString()).items, [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 2 }]);
    assert.deepEqual((await pool.query("SELECT grand_total,shipping_total,payment_status,fulfillment_status FROM orders WHERE id=$1", [order])).rows[0], orderBefore);
    const requestsBeforeDirectOrderCall = orderFixture.requests.length;
    await assert.rejects(() => createTooniesProcurementAttempt({ orderId: order }, actor), (error: any) => error.code === "ORDER_PROCUREMENT_WORKER_ONLY");
    assert.equal(orderFixture.requests.length, requestsBeforeDirectOrderCall);
    assert.equal((await pool.query("SELECT state FROM toonies_procurement_commands WHERE order_id=$1", [order])).rows[0].state, "completed");
    await pool.query("DELETE FROM toonies_procurement_events WHERE attempt_id=$1", [orderAttempt.id]);
    await pool.query("DELETE FROM toonies_procurement_lines WHERE attempt_id=$1", [orderAttempt.id]);
    await pool.query("DELETE FROM toonies_procurement_attempts WHERE id=$1", [orderAttempt.id]);
    await assert.rejects(
      () => pool.query("UPDATE order_items SET supplier_cost_threshold_percent='0' WHERE order_id=$1 AND supplier_id=$2", [order, supplier.id]),
      (error: any) => error.code === "23514",
    );
    await pool.query("DELETE FROM toonies_procurement_commands WHERE order_id=$1", [order]);
    await pool.query("INSERT INTO toonies_procurement_commands(order_id,order_total_fingerprint,supplier_snapshot_fingerprint) VALUES($1,$2,$3)", [order, orderFingerprint, await loadTooniesSupplierSnapshotFingerprint(pool, order)]);
    const holdTask = nextTask();
    const holdFixture = new TooniesFixtureTransport({
      "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: holdTask, status: "pending", item_count: 1 } },
      "/v1/order/task": { status: true, code: 200, msg: "ok", data: { task_id: holdTask, status: "ready", item_count: 1, ok_count: 1, date_expire: Math.floor(Date.now() / 1000) + 900, items: [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 2, ok: true, moq: 1, stock: 10, charge: "0.60", subtotal: "1.20", weight: "0.2" }] } },
    });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: holdFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    await runTooniesProcurementPollingCycle(20);
    const holdAttempt = (await pool.query("SELECT id FROM toonies_procurement_attempts WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1", [order])).rows[0].id;
    owned.attempts.push(holdAttempt);
    await runTooniesProcurementPollingCycle(20);
    const held = await getTooniesProcurementAttempt(holdAttempt);
    assert.equal(held.state, "cost_hold");
    assert.equal(String(held.lines[0].returnedCostVarianceCny).replace(/0+$/, "").replace(/\.$/, ""), "0.22");

    await pool.query("DELETE FROM toonies_procurement_commands WHERE order_id=$1", [order]);
    const exhaustedFixture = new TooniesFixtureTransport({});
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: exhaustedFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    await pool.query(
      `INSERT INTO toonies_procurement_commands(order_id,order_total_fingerprint,supplier_snapshot_fingerprint,state,attempts,max_attempts,lease_token,lease_until)
       VALUES($1,$2,$3,'processing',5,5,'expired-owner',now()-interval '1 second')`,
      [order, orderFingerprint, supplierSnapshotFingerprint],
    );
    await runTooniesProcurementPollingCycle(20);
    const exhaustedCommand = (await pool.query("SELECT state,attempts,lease_token AS \"leaseToken\" FROM toonies_procurement_commands WHERE order_id=$1", [order])).rows[0];
    assert.deepEqual(exhaustedCommand, { state: "failed", attempts: 5, leaseToken: null });
    assert.equal(exhaustedFixture.requests.length, 0);

    await pool.query("DELETE FROM toonies_procurement_commands WHERE order_id=$1", [order]);
    const arithmeticTask = nextTask();
    const arithmeticFixture = new TooniesFixtureTransport({
      "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: arithmeticTask, status: "pending", item_count: 1 } },
      "/v1/order/task": { status: true, code: 200, msg: "ok", data: { task_id: arithmeticTask, status: "ready", item_count: 1, ok_count: 1, date_expire: Math.floor(Date.now() / 1000) + 900, items: [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 2, ok: true, moq: 1, stock: 10, charge: "0.49", subtotal: "0.97", weight: "0.2" }] } },
    });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: arithmeticFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    await pool.query("INSERT INTO toonies_procurement_commands(order_id,order_total_fingerprint,supplier_snapshot_fingerprint) VALUES($1,$2,$3)", [order, orderFingerprint, supplierSnapshotFingerprint]);
    await runTooniesProcurementPollingCycle(20);
    const arithmeticAttempt = (await pool.query("SELECT id FROM toonies_procurement_attempts WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1", [order])).rows[0].id;
    owned.attempts.push(arithmeticAttempt);
    await runTooniesProcurementPollingCycle(20);
    const arithmeticFailed = await getTooniesProcurementAttempt(arithmeticAttempt);
    assert.equal(arithmeticFailed.state, "failed");
    assert.equal(arithmeticFailed.failureCode, 40001);
    assert.match(arithmeticFailed.failureMessage, /inconsistent CNY subtotal/i);

    const runTaskFailure = async (data: unknown, quantity: number, expectedCode: string | number) => {
      const task = nextTask();
      const localFixture = new TooniesFixtureTransport({
        "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: task, status: "pending", item_count: 1 } },
        "/v1/order/task": { status: true, code: 200, msg: "ok", data },
      });
      setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: localFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
      const attempt = await createTooniesProcurementAttempt({ lines: [{ productId: productData[0]!.product, variantId: productData[0]!.variant, quantity }] }, actor) as any;
      owned.attempts.push(attempt.id);
      const result = await pollTooniesProcurementAttempt(attempt.id, 1);
      assert.equal(result.state, expectedCode === "expired" ? "expired" : "failed");
      return { result, requests: localFixture.requests };
    };
    await runTaskFailure({
      task_id: nextTask(), status: "ready", item_count: 1, ok_count: 1, date_expire: Math.floor(Date.now() / 1000) + 900,
      items: [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 1, ok: false, fail_code: 40022, fail_msg: "MOQ" }],
    }, 1, 40022);
    const partial = await runTaskFailure({
      task_id: nextTask(), status: "ready", item_count: 1, ok_count: 0, date_expire: Math.floor(Date.now() / 1000) + 900,
      items: [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 1, ok: false, fail_code: 40021, fail_msg: "stock" }],
    }, 1, 40021);
    assert.equal(partial.result.failureCode, 40021);
    const partialTask = nextTask();
    const partialFixture = new TooniesFixtureTransport({
      "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: partialTask, status: "pending", item_count: 2 } },
      "/v1/order/task": { status: true, code: 200, msg: "ok", data: {
        task_id: partialTask, status: "ready", item_count: 2, ok_count: 1, date_expire: Math.floor(Date.now() / 1000) + 900,
        items: [
          { product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 1, ok: true, moq: 1, stock: 2, charge: 1 },
          { product_code: productData[1]!.code, sku_code: productData[1]!.sku, num: 2, ok: false, fail_code: 40021, fail_msg: "stock" },
        ],
      } },
    });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: partialFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    const partialAttempt = await createTooniesProcurementAttempt({ lines: productData.map((line, index) => ({ productId: line.product, variantId: line.variant, quantity: index ? 2 : 1 })) }, actor) as any;
    owned.attempts.push(partialAttempt.id);
    const partialResult = await pollTooniesProcurementAttempt(partialAttempt.id, 1);
    assert.equal(partialResult.state, "failed");
    assert.equal(partialResult.failureCode, 40021);
    await runTaskFailure({
      task_id: nextTask(), status: "ready", item_count: 1, ok_count: 1, date_expire: Math.floor(Date.now() / 1000) - 1,
      items: [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 1, ok: true, moq: 1, stock: 2, charge: 1 }],
    }, 1, "expired");
    for (const malformed of [
      [{ product_code: "unknown", sku_code: "unknown", num: 1, ok: true, moq: 1, stock: 1, charge: 1 }],
      [{ product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 2, ok: true, moq: 1, stock: 1, charge: 1 }],
      [
        { product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 1, ok: true, moq: 1, stock: 1, charge: 1 },
        { product_code: productData[0]!.code, sku_code: productData[0]!.sku, num: 1, ok: true, moq: 1, stock: 1, charge: 1 },
      ],
    ]) {
      await runTaskFailure({ task_id: nextTask(), status: "ready", item_count: malformed.length, ok_count: malformed.length, date_expire: Math.floor(Date.now() / 1000) + 900, items: malformed }, 1, 40042);
    }
    const boundedTask = nextTask();
    const boundedFixture = new TooniesFixtureTransport({
      "/v1/order/precheck": { status: true, code: 200, msg: "ok", data: { task_id: boundedTask, status: "pending", item_count: 1 } },
      "/v1/order/task": { status: false, code: 40040, msg: "not ready", data: null },
    });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: boundedFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    const boundedAttempt = await createTooniesProcurementAttempt({ lines: [{ productId: productData[0]!.product, variantId: productData[0]!.variant, quantity: 6 }] }, actor) as any;
    owned.attempts.push(boundedAttempt.id);
    await pool.query("UPDATE toonies_procurement_attempts SET max_polls=1 WHERE id=$1", [boundedAttempt.id]);
    assert.equal((await pollTooniesProcurementAttempt(boundedAttempt.id, 1)).state, "failed");

    const rateFixture = new TooniesFixtureTransport({ "/v1/order/precheck": { status: false, code: 42901, msg: "rate", data: null } });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: rateFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    await assert.rejects(() => createTooniesProcurementAttempt({ lines: [{ productId: productData[0]!.product, variantId: productData[0]!.variant, quantity: 4 }] }, actor), (error: any) => error.code === "TOONIES_42901");
    const rateAttempt = await pool.query<{ state: string }>("SELECT state FROM toonies_procurement_attempts WHERE supplier_id=$1 ORDER BY created_at DESC LIMIT 1", [supplier.id]);
    assert.equal(rateAttempt.rows[0]!.state, "retry_wait");
    const timeoutTransport = async () => { throw new Error("network"); };
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: timeoutTransport, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    await assert.rejects(() => createTooniesProcurementAttempt({ lines: [{ productId: productData[0]!.product, variantId: productData[0]!.variant, quantity: 5 }] }, actor), (error: any) => error.code === "TOONIES_50001");
    const timeoutAttempt = await pool.query<{ state: string }>("SELECT state FROM toonies_procurement_attempts WHERE supplier_id=$1 ORDER BY created_at DESC LIMIT 1", [supplier.id]);
    assert.equal(timeoutAttempt.rows[0]!.state, "retry_wait");

    const badFixture = new TooniesFixtureTransport({
      "/v1/order/precheck": { status: false, code: 40021, msg: "stock", data: null },
    });
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: badFixture.request, nonce: () => "fixture-nonce", now: () => 1_700_000_000 }));
    await assert.rejects(() => createTooniesProcurementAttempt({ ...input, lines: [{ ...input.lines[0], quantity: 2 }] }, actor), (error: any) => error.code === "TOONIES_40021");
    assert.ok(badFixture.requests.every((request) => request.path === "/v1/order/precheck" || request.path === "/v1/order/task"));

    const invalid = await assert.rejects(() => createTooniesProcurementAttempt({ ...input, lines: [{ productId: productData[0]!.product, variantId: productData[1]!.variant, quantity: 1 }] }, actor));
    assert.equal(invalid, undefined);

    server = await startServer();
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new Client(`http://127.0.0.1:${address.port}`);
    await client.request("/auth/me");
    await client.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `${marker}@example.test`, password }) });
    const list = await client.request("/admin/suppliers/toonies/procurement");
    assert.equal(list.response.status, 200);
    const detail = await client.request(`/admin/suppliers/toonies/procurement/${created.id}`);
    assert.equal(detail.response.status, 200);
    assert.equal(JSON.stringify(detail.body).includes("fixture-secret"), false);
    const mixedInput = await client.request("/admin/suppliers/toonies/procurement/precheck", { method: "POST", body: JSON.stringify({ orderId: created.orderId ?? "00000000-0000-0000-0000-000000000001", lines: input.lines }) });
    assert.equal(mixedInput.response.status, 400);
    const legacyPrecheck = await client.request("/admin/suppliers/toonies/precheck", { method: "POST", body: JSON.stringify({ client_task_no: "browser", items: [{ product_code: "browser", sku_code: "browser", num: 1 }] }) });
    assert.equal(legacyPrecheck.response.status, 404);
    const legacyTask = await client.request("/admin/suppliers/toonies/task", { method: "POST", body: JSON.stringify({ task_id: "browser" }) });
    assert.equal(legacyTask.response.status, 404);
    assert.equal(badFixture.requests.some((request) => request.path.includes("/order/create")), false);
    const csrf = await client.request(`/admin/suppliers/toonies/procurement/${created.id}/poll`, { method: "POST", body: JSON.stringify({ maxPolls: 1 }) }, false);
    assert.equal(csrf.response.status, 403);

    const viewer = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,first_name,last_name,status,email_verified_at) VALUES($1,$2,'Procurement','Viewer','active',now()) RETURNING id",
      [`${marker}-viewer@example.test`, await hashPassword(password)],
    )).rows[0]!.id;
    owned.users.push(viewer);
    const viewerRole = (await pool.query<{ id: string }>("INSERT INTO admin_roles(name) VALUES($1) RETURNING id", [`${marker} viewer role`])).rows[0]!.id;
    owned.roles.push(viewerRole);
    await pool.query("INSERT INTO admin_user_roles(user_id,role_id) VALUES($1,$2)", [viewer, viewerRole]);
    await pool.query("INSERT INTO admin_role_permissions(role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key='supplier_integrations.view'", [viewerRole]);
    const viewerClient = new Client(`http://127.0.0.1:${address.port}`);
    await viewerClient.request("/auth/me");
    await viewerClient.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `${marker}-viewer@example.test`, password }) });
    assert.equal((await viewerClient.request("/admin/suppliers/toonies/procurement")).response.status, 200);
    assert.equal((await viewerClient.request(`/admin/suppliers/toonies/procurement/${created.id}/poll`, { method: "POST", body: JSON.stringify({ maxPolls: 1 }) })).response.status, 403);
    assert.equal((await viewerClient.request("/admin/suppliers/toonies/procurement/precheck", { method: "POST", body: JSON.stringify(input) })).response.status, 403);

    const disabledFixture = new TooniesFixtureTransport({});
    setTooniesClient(new TooniesClient({ app_key: "fixture", app_secret: "fixture", transport: disabledFixture.request }));
    env.TOONIES_ORDER_BOUND_PROCUREMENT_ENABLED = false;
    resetTooniesProcurementGateCacheForTests();
    await pool.query("DELETE FROM toonies_procurement_commands WHERE order_id=$1", [order]);
    await pool.query(
      `INSERT INTO toonies_procurement_commands(order_id,order_total_fingerprint,supplier_snapshot_fingerprint,state)
       VALUES($1,$2,$3,'pending')`,
      [order, orderFingerprint, supplierSnapshotFingerprint],
    );
    assert.deepEqual(await runTooniesProcurementPollingCycle(20), { claimed: 0, failed: 0 });
    assert.equal((await pool.query("SELECT state FROM toonies_procurement_commands WHERE order_id=$1", [order])).rows[0].state, "pending");
    await pool.query("UPDATE toonies_procurement_commands SET state='processing',attempts=1,lease_token='maintenance-owner',lease_until=now()+interval '1 minute' WHERE order_id=$1", [order]);
    assert.deepEqual(await runTooniesProcurementPollingCycle(20), { claimed: 0, failed: 0 });
    assert.deepEqual(
      (await pool.query("SELECT state,lease_token AS \"leaseToken\" FROM toonies_procurement_commands WHERE order_id=$1", [order])).rows[0],
      { state: "processing", leaseToken: "maintenance-owner" },
    );
    await assert.rejects(
      () => createTooniesProcurementAttempt(input, actor),
      (error: any) => error.code === "TOONIES_PROCUREMENT_MAINTENANCE" && error.details?.retryable === true,
    );
    await assert.rejects(
      () => pollTooniesProcurementAttempt(created.id, 1),
      (error: any) => error.code === "TOONIES_PROCUREMENT_MAINTENANCE",
    );
    assert.equal((await client.request("/admin/suppliers/toonies/procurement/precheck", { method: "POST", body: JSON.stringify(input) })).response.status, 503);
    assert.equal((await client.request(`/admin/suppliers/toonies/procurement/${created.id}/poll`, { method: "POST", body: JSON.stringify({ maxPolls: 1 }) })).response.status, 503);
    assert.equal(disabledFixture.requests.length, 0);
    env.TOONIES_ORDER_BOUND_PROCUREMENT_ENABLED = true;
    resetTooniesProcurementGateCacheForTests();
  } finally {
    env.TOONIES_ORDER_BOUND_PROCUREMENT_ENABLED = true;
    resetTooniesProcurementGateCacheForTests();
    setTooniesClient(undefined);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    const cleanup = await pool.connect();
    try {
      await cleanup.query("BEGIN");
      const attemptRows = (await cleanup.query<{ id: string }>("SELECT DISTINCT a.id FROM toonies_procurement_attempts a JOIN toonies_procurement_lines l ON l.attempt_id=a.id WHERE l.product_id=ANY($1::uuid[])", [owned.products])).rows;
      if (attemptRows.length) owned.attempts.push(...attemptRows.map((row) => row.id).filter((id) => !owned.attempts.includes(id)));
      await cleanup.query("DELETE FROM toonies_procurement_events WHERE attempt_id=ANY($1::uuid[])", [owned.attempts]);
      await cleanup.query("DELETE FROM toonies_procurement_lines WHERE attempt_id=ANY($1::uuid[])", [owned.attempts]);
      await cleanup.query("DELETE FROM toonies_procurement_attempts WHERE id=ANY($1::uuid[])", [owned.attempts]);
      await cleanup.query("DELETE FROM toonies_procurement_commands WHERE order_id=ANY($1::uuid[])", [owned.orders]);
      await cleanup.query("DELETE FROM payments WHERE id=ANY($1::uuid[])", [owned.payments]);
      await cleanup.query("DELETE FROM order_items WHERE order_id=ANY($1::uuid[])", [owned.orders]);
      await cleanup.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [owned.orders]);
      await cleanup.query("DELETE FROM supplier_pricing_rules WHERE name LIKE $1", [`${marker}%`]);
      await cleanup.query("DELETE FROM admin_user_roles WHERE user_id=ANY($1::uuid[])", [owned.users]);
      await cleanup.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [owned.users]);
      await cleanup.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [owned.roles]);
      await cleanup.query("DELETE FROM supplier_product_links WHERE id=ANY($1::uuid[])", [owned.links]);
      await cleanup.query("DELETE FROM inventory WHERE variant_id=ANY($1::uuid[])", [owned.variants]);
      await cleanup.query("DELETE FROM product_variants WHERE id=ANY($1::uuid[])", [owned.variants]);
      await cleanup.query("DELETE FROM products WHERE id=ANY($1::uuid[])", [owned.products]);
      await cleanup.query("DELETE FROM supplier_catalogue_variants WHERE id=ANY($1::uuid[])", [owned.catalogueVariants]);
      await cleanup.query("DELETE FROM supplier_catalogue_items WHERE id=ANY($1::uuid[])", [owned.catalogue]);
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

async function startServer(): Promise<Server> {
  const app = await createApp({ serveFrontend: false });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return server;
}

run().then(() => console.log("Toonies procurement integration passed.")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});