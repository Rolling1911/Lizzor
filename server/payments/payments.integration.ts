import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { env } from "../config/env.js";
import { addItem } from "../cart/service.js";
import { cancelOrder, createOrder } from "../orders/service.js";
import { AppError } from "../middleware/error-handler.js";
import { getFakePaymentCancelCountForTest, getFakePaymentCreateCountForTest, getFakePaymentRefundCountForTest, setFakePaymentFactsForTest, setFakePaymentRefundFailureAfterCallForTest, setFakePaymentStatusForTest, setFakePaymentStatusOnCancelForTest } from "./provider.js";
import { createPayment, createRefund, expirePaymentReservations, getAdminPayment, handleWebhook, listPaymentRecovery, queueStuckPaymentRecoveries, retryPaymentRecovery, runPaymentRecovery } from "./service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `phase5b1-${suffix}`;
const address = { firstName: "Payment", lastName: "Tester", addressLine1: "1 Test Street", city: "Nicosia", postalCode: "1000", countryCode: "CY" };

async function makeOrder(quantity: number, sequence: string) {
  const session = `${marker}-${sequence}`;
  await addItem({ guestSessionId: session }, { productId, variantId, quantity });
  const created = await createOrder({ guestSessionId: session }, {
    email: `${session}@example.com`,
    billingAddress: address,
    shippingAddress: address,
    idempotencyKey: `${session}-checkout`,
    expectedGrandTotal: quantity * 10,
  });
  orderIds.push(created.order.id);
  return { session, ...created };
}

async function makeAuthenticatedOrder(quantity: number, sequence: string) {
  await addItem({ userId: customerId }, { productId, variantId, quantity });
  const created = await createOrder({ userId: customerId }, {
    email: customerEmail.toUpperCase(),
    billingAddress: address,
    shippingAddress: address,
    idempotencyKey: `${marker}-${sequence}-checkout`,
    expectedGrandTotal: quantity * 10,
  });
  orderIds.push(created.order.id);
  return created;
}

async function assertRecipientRouting(orderId: string, type: "payment.succeeded" | "payment.failed" | "refund.completed" | "refund.updated", expectedEmail: string, expectedUserId?: string) {
  const deliveries = (await pool.query(
    `SELECT d.channel,d.recipient_email AS email,n.user_id AS "userId"
       FROM notification_deliveries d
       LEFT JOIN notifications n ON n.id=d.notification_id
      WHERE d.event_type=$1 AND COALESCE(d.metadata_json,n.data_json)->>'orderId'=$2
      ORDER BY d.channel,d.created_at`,
    [type, orderId],
  )).rows;
  const emailDeliveries = deliveries.filter((delivery) => delivery.channel === "email");
  assert.ok(emailDeliveries.length > 0, `${type} must create an email delivery for order ${orderId}`);
  assert.ok(emailDeliveries.every((delivery) => delivery.email === expectedEmail), `${type} must route only to the order recipient`);
  if (expectedUserId) {
    assert.ok(deliveries.some((delivery) => delivery.channel === "in_app"), `${type} must create an authenticated in-app delivery`);
    assert.ok(deliveries.every((delivery) => delivery.userId === expectedUserId), `${type} must not leak to another customer or admin`);
  } else {
    assert.ok(deliveries.every((delivery) => delivery.channel === "email" && delivery.userId === null), `${type} guest delivery must not leak to an account or admin`);
  }
}

const pool = getDatabasePool();
let categoryId = "";
let productId = "";
let variantId = "";
let warehouseId = "";
let expiringCouponId = "";
let customerId = "";
let maintenanceSupplierLinkId = "";
let maintenanceCatalogueItemId = "";
let maintenanceCatalogueVariantId = "";
const customerEmail = `${marker}-account@example.com`;
const orderIds: string[] = [];

async function run() {
  try {
    categoryId = (await pool.query("INSERT INTO categories (name,slug,description) VALUES ($1,$2,$3) RETURNING id", [`Payments ${suffix}`, marker, marker])).rows[0].id;
    productId = (await pool.query(`INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at) VALUES ($1,$2,$3,$4,$5,4,10,19,1,'active',now()) RETURNING id`, [`Payment Product ${suffix}`, `${marker}-product`, `${marker}-sku`, categoryId, marker])).rows[0].id;
    variantId = (await pool.query("INSERT INTO product_variants (product_id,sku,title,cost_price,base_price,active) VALUES ($1,$2,'Case',5,10,true) RETURNING id", [productId, `${marker}-variant`])).rows[0].id;
    warehouseId = (await pool.query("INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id", [`Payments ${suffix}`, marker])).rows[0].id;
    await pool.query("INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand,quantity_reserved,low_stock_threshold) VALUES ($1,$2,20,0,2)", [warehouseId, variantId]);
    customerId = (await pool.query(
      "INSERT INTO users (email,first_name,last_name,status,email_verified_at) VALUES ($1,'Payment','Customer','active',now()) RETURNING id",
      [customerEmail],
    )).rows[0].id;

    const cancellationRace = await makeOrder(1, "cancel-payment-race");
    const raceAccess = { guestSessionId: cancellationRace.session, guestAccessToken: cancellationRace.guestAccessToken };
    const lockPool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
    const blocker = await lockPool.connect();
    let cancellation!: ReturnType<typeof cancelOrder>;
    let competingPayment!: Promise<unknown>;
    try {
      await blocker.query("BEGIN");
      const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await blocker.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [cancellationRace.order.id]);
      cancellation = cancelOrder(cancellationRace.order.id, raceAccess);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await blocker.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`,
          [blockerPid],
        );
        if (waiting.rowCount) break;
        if (attempt === 99) throw new Error("Cancellation did not reach the order lock.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      competingPayment = createPayment(cancellationRace.order.id, raceAccess, `${marker}-cancel-payment-race`)
        .then(() => null, (error: unknown) => error);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await lockPool.end();
    }
    const cancelled = await cancellation;
    const paymentError = await competingPayment;
    assert.equal(cancelled.status, "cancelled");
    assert.equal((paymentError as AppError).code, "ORDER_NOT_PAYABLE");
    assert.equal(Number((await pool.query("SELECT count(*) FROM payments WHERE order_id=$1", [cancellationRace.order.id])).rows[0].count), 0);

    const successful = await makeOrder(2, "success");
    const access = { guestSessionId: successful.session, guestAccessToken: successful.guestAccessToken };
    const attempts = await Promise.all([
      createPayment(successful.order.id, access, `${marker}-payment-same`),
      createPayment(successful.order.id, access, `${marker}-payment-same`),
    ]);
    assert.equal(attempts[0].payment.id, attempts[1].payment.id);
    assert.ok(attempts[0].clientSecret);
    assert.equal(attempts[0].clientSecret, attempts[1].clientSecret, "replayed active payment attempts must recover the same client secret");
    const payment = attempts[0].payment;
    assert.equal(payment.amount, 20);
    assert.equal(payment.status, "requires_action");
    assert.ok(payment.providerPaymentId);
    const createCount = getFakePaymentCreateCountForTest(payment.providerPaymentId);
    const browserRetry = await createPayment(successful.order.id, access, `${marker}-payment-new-browser-retry`);
    assert.equal(browserRetry.payment.id, payment.id);
    assert.equal(browserRetry.clientSecret, attempts[0].clientSecret);
    assert.equal(getFakePaymentCreateCountForTest(payment.providerPaymentId), createCount, "active provider PaymentIntents must be retrieved instead of created again");

    const successEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-success`, type: "payment_intent.succeeded", data: { object: { id: payment.providerPaymentId, status: "succeeded", amount_received: 2000, currency: "eur", metadata: { order_id: successful.order.id } } } }));
    const webhookResults = await Promise.all([handleWebhook(successEvent, "test-signature"), handleWebhook(successEvent, "test-signature")]);
    assert.equal(webhookResults.filter((result) => result.processed).length, 1);
    assert.equal(webhookResults.filter((result) => result.duplicate).length, 1);
    const paid = await getAdminPayment(payment.id);
    assert.equal(paid.payment.status, "paid");
    assert.equal((await pool.query("SELECT status,payment_status AS \"paymentStatus\" FROM orders WHERE id=$1", [successful.order.id])).rows[0].paymentStatus, "paid");
    const stockAfterSale = (await pool.query("SELECT quantity_on_hand AS \"onHand\",quantity_reserved AS reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0];
    assert.equal(Number(stockAfterSale.onHand), 18);
    assert.equal(Number(stockAfterSale.reserved), 0);
    assert.equal(Number((await pool.query("SELECT count(*) FROM inventory_movements WHERE reference_id=$1 AND movement_type='sale'", [successful.order.id])).rows[0].count), 1);
    await assertRecipientRouting(successful.order.id, "payment.succeeded", `${successful.session}@example.com`);

    await createRefund(payment.id, 5, `${marker}-refund-partial`);
    assert.equal((await getAdminPayment(payment.id)).payment.status, "partially_refunded");
    const partialRefund = (await pool.query("SELECT id FROM refunds WHERE payment_id=$1 ORDER BY created_at LIMIT 1", [payment.id])).rows[0];
    await assertRecipientRouting(successful.order.id, "refund.completed", `${successful.session}@example.com`);
    await pool.query("UPDATE refunds SET status='processing',provider_reference=NULL WHERE id=$1", [partialRefund.id]);
    await pool.query("UPDATE payments SET status='paid' WHERE id=$1", [payment.id]);
    const refundPendingEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-refund-pending`, type: "refund.updated", data: { object: { id: `${marker}-unknown-ref`, payment_intent: payment.providerPaymentId, status: "pending", amount: 500, currency: "eur", metadata: { refund_id: partialRefund.id } } } }));
    await handleWebhook(refundPendingEvent, "test-signature");
    await assertRecipientRouting(successful.order.id, "refund.updated", `${successful.session}@example.com`);
    const refundEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-refund`, type: "refund.updated", data: { object: { id: `${marker}-unknown-ref`, payment_intent: payment.providerPaymentId, status: "succeeded", amount: 500, currency: "eur", metadata: { refund_id: partialRefund.id } } } }));
    await handleWebhook(refundEvent, "test-signature");
    assert.equal((await getAdminPayment(payment.id)).payment.status, "partially_refunded");
    await createRefund(payment.id, 15, `${marker}-refund-rest`);
    assert.equal((await getAdminPayment(payment.id)).payment.status, "refunded");
    const stockAfterRefund = (await pool.query("SELECT quantity_on_hand AS \"onHand\",quantity_reserved AS reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0];
    assert.equal(Number(stockAfterRefund.onHand), 18);
    assert.equal(Number(stockAfterRefund.reserved), 0);
    await assert.rejects(() => createRefund(payment.id, 1, `${marker}-refund-too-much`), /Only a paid payment/);

    // A mutation-call-then-throw must leave the durable refund reservation
    // protective; recovery may only perform lookup and must not submit again.
    const lookupOnly = await makeOrder(1, "refund-call-then-throw");
    const lookupPayment = (await createPayment(lookupOnly.order.id, { guestSessionId: lookupOnly.session, guestAccessToken: lookupOnly.guestAccessToken }, `${marker}-payment-refund-call-then-throw`)).payment;
    const lookupEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-refund-call-then-throw`, type: "payment_intent.succeeded", data: { object: { id: lookupPayment.providerPaymentId, status: "succeeded", amount_received: 1000, currency: "eur", metadata: { order_id: lookupOnly.order.id } } } }));
    await handleWebhook(lookupEvent, "test-signature");
    const lookupKey = `${marker}-refund-call-then-throw`;
    const lookupHash = createHash("sha256").update(lookupKey).digest("hex");
    setFakePaymentRefundFailureAfterCallForTest(lookupHash);
    await assert.rejects(() => createRefund(lookupPayment.id, 1, lookupKey), /Response lost/i);
    assert.equal(getFakePaymentRefundCountForTest(lookupHash), 1);
    const lookupReservation = (await pool.query("SELECT state,phase FROM financial_operation_reservations WHERE operation_type='payment_refund' AND operation_reference_id=(SELECT id::text FROM refunds WHERE payment_id=$1 ORDER BY created_at DESC LIMIT 1)", [lookupPayment.id])).rows[0];
    assert.equal(lookupReservation.phase, "ambiguous");
    assert.equal((await runPaymentRecovery()).failed, 1);
    await pool.query("UPDATE payment_recovery_jobs SET retryable=false WHERE payment_id=$1 AND operation='refund'", [lookupPayment.id]);

    const failed = await makeOrder(1, "failed");
    const failedPayment = (await createPayment(failed.order.id, { guestSessionId: failed.session, guestAccessToken: failed.guestAccessToken }, `${marker}-payment-failed`)).payment;
    const failedEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-failed`, type: "payment_intent.payment_failed", data: { object: { id: failedPayment.providerPaymentId, last_payment_error: { message: "Test decline" } } } }));
    await handleWebhook(failedEvent, "test-signature");
    const failedOrder = (await pool.query("SELECT status,payment_status AS \"paymentStatus\" FROM orders WHERE id=$1", [failed.order.id])).rows[0];
    assert.equal(failedOrder.status, "pending");
    assert.equal(failedOrder.paymentStatus, "pending");
    assert.equal(Number((await pool.query("SELECT quantity_reserved AS reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].reserved), 1);

    const guestFailure = await makeOrder(1, "notified-failure");
    const guestFailurePayment = (await createPayment(guestFailure.order.id, { guestSessionId: guestFailure.session, guestAccessToken: guestFailure.guestAccessToken }, `${marker}-payment-notified-failure`)).payment;
    const guestFailureEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-notified-failure`, type: "payment_intent.canceled", data: { object: { id: guestFailurePayment.providerPaymentId, cancellation_reason: "Test cancellation" } } }));
    await handleWebhook(guestFailureEvent, "test-signature");
    await assertRecipientRouting(guestFailure.order.id, "payment.failed", `${guestFailure.session}@example.com`);
    const retryableCancelledOrder = (await pool.query("SELECT status,payment_status AS \"paymentStatus\" FROM orders WHERE id=$1", [guestFailure.order.id])).rows[0];
    assert.equal(retryableCancelledOrder.status, "pending");
    assert.equal(retryableCancelledOrder.paymentStatus, "pending");
    assert.equal((await pool.query("SELECT status FROM inventory_reservations WHERE order_id=$1", [guestFailure.order.id])).rows[0].status, "active");
    const retriedCancelledPayment = (await createPayment(guestFailure.order.id, { guestSessionId: guestFailure.session, guestAccessToken: guestFailure.guestAccessToken }, `${marker}-payment-notified-failure-retry`)).payment;
    assert.ok(["pending", "requires_action"].includes(retriedCancelledPayment.status));
    assert.equal(Number((await pool.query("SELECT count(*) FROM payments WHERE order_id=$1 AND status IN ('pending','requires_action','processing','authorized')", [guestFailure.order.id])).rows[0].count), 1);

    const authenticatedSuccess = await makeAuthenticatedOrder(1, "account-success");
    const authenticatedPayment = (await createPayment(authenticatedSuccess.order.id, { userId: customerId }, `${marker}-account-payment-success`)).payment;
    const authenticatedSuccessEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-account-success`, type: "payment_intent.succeeded", data: { object: { id: authenticatedPayment.providerPaymentId, status: "succeeded", amount_received: 1000, currency: "eur", metadata: { order_id: authenticatedSuccess.order.id } } } }));
    await handleWebhook(authenticatedSuccessEvent, "test-signature");
    await assertRecipientRouting(authenticatedSuccess.order.id, "payment.succeeded", customerEmail, customerId);
    await createRefund(authenticatedPayment.id, 1, `${marker}-account-refund`);
    const authenticatedRefund = (await pool.query("SELECT id FROM refunds WHERE payment_id=$1 ORDER BY created_at LIMIT 1", [authenticatedPayment.id])).rows[0];
    await assertRecipientRouting(authenticatedSuccess.order.id, "refund.completed", customerEmail, customerId);
    await pool.query("UPDATE refunds SET status='processing',provider_reference=NULL WHERE id=$1", [authenticatedRefund.id]);
    await pool.query("UPDATE payments SET status='paid' WHERE id=$1", [authenticatedPayment.id]);
    const authenticatedRefundPendingEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-account-refund-pending`, type: "refund.updated", data: { object: { id: `${marker}-account-unknown-ref`, payment_intent: authenticatedPayment.providerPaymentId, status: "pending", amount: 100, currency: "eur", metadata: { refund_id: authenticatedRefund.id } } } }));
    await handleWebhook(authenticatedRefundPendingEvent, "test-signature");
    await assertRecipientRouting(authenticatedSuccess.order.id, "refund.updated", customerEmail, customerId);

    const authenticatedFailure = await makeAuthenticatedOrder(1, "account-failure");
    const authenticatedFailurePayment = (await createPayment(authenticatedFailure.order.id, { userId: customerId }, `${marker}-account-payment-failure`)).payment;
    const authenticatedFailureEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-account-failure`, type: "payment_intent.canceled", data: { object: { id: authenticatedFailurePayment.providerPaymentId, cancellation_reason: "Test cancellation" } } }));
    await handleWebhook(authenticatedFailureEvent, "test-signature");
    await assertRecipientRouting(authenticatedFailure.order.id, "payment.failed", customerEmail, customerId);

    const tampered = await makeOrder(1, "tampered");
    const tamperedPayment = (await createPayment(tampered.order.id, { guestSessionId: tampered.session, guestAccessToken: tampered.guestAccessToken }, `${marker}-payment-tampered`)).payment;
    await pool.query("UPDATE payments SET amount=1 WHERE id=$1", [tamperedPayment.id]);
    const tamperedEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-tampered`, type: "payment_intent.succeeded", data: { object: { id: tamperedPayment.providerPaymentId, amount_received: 1000, currency: "eur", metadata: { order_id: tampered.order.id } } } }));
    await assert.rejects(() => handleWebhook(tamperedEvent, "test-signature"), /signed payment facts do not match/);
    const reviewJob = (await pool.query("SELECT id,status,retryable FROM payment_recovery_jobs WHERE provider_event_id=$1", [`${marker}-event-tampered`])).rows[0];
    assert.equal(reviewJob.status, "failed");
    assert.equal(reviewJob.retryable, false);
    assert.equal((await pool.query("SELECT payment_status AS status FROM orders WHERE id=$1", [tampered.order.id])).rows[0].status, "pending");
    assert.equal((await pool.query("SELECT status FROM inventory_reservations WHERE order_id=$1", [tampered.order.id])).rows[0].status, "active");

    const expiringSession = `${marker}-expiring`;
    const expiringCouponCode = `${marker}-expiry-code`.toUpperCase();
    expiringCouponId = (await pool.query(
      `INSERT INTO promotion_campaigns
        (name,start_at,promotion_type,discount_type,discount_value,automatic,coupon_code,usage_limit,active,priority)
       VALUES ($1,now()-interval '1 minute','order','percentage',10,false,$2,1,true,50)
       RETURNING id`,
      [`${marker} expiry coupon`, expiringCouponCode],
    )).rows[0].id;
    await addItem({ guestSessionId: expiringSession }, { productId, variantId, quantity: 1 });
    await pool.query("UPDATE carts SET applied_coupon_code=$1 WHERE guest_session_id=$2 AND status='active'", [expiringCouponCode, expiringSession]);
    const expiringCreated = await createOrder({ guestSessionId: expiringSession }, {
      email: `${expiringSession}@example.com`,
      billingAddress: address,
      shippingAddress: address,
      idempotencyKey: `${expiringSession}-checkout`,
      expectedGrandTotal: 9,
    });
    orderIds.push(expiringCreated.order.id);
    const expiring = { session: expiringSession, ...expiringCreated };
    assert.equal(Number((await pool.query("SELECT usage_count FROM promotion_campaigns WHERE id=$1", [expiringCouponId])).rows[0].usage_count), 1);
    const expiringPayment = (await createPayment(expiring.order.id, { guestSessionId: expiring.session, guestAccessToken: expiring.guestAccessToken }, `${marker}-payment-expiring`)).payment;
    const expiringCancelledEvent = Buffer.from(JSON.stringify({ id: `${marker}-event-expiring-cancelled`, type: "payment_intent.canceled", data: { object: { id: expiringPayment.providerPaymentId, cancellation_reason: "Customer abandoned checkout" } } }));
    await handleWebhook(expiringCancelledEvent, "test-signature");
    assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [expiring.order.id])).rows[0].status, "pending");
    const reservedBeforeExpiration = Number((await pool.query("SELECT quantity_reserved AS reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].reserved);
    await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [expiring.order.id]);
    const expiration = await expirePaymentReservations();
    assert.equal(expiration.released, 1);
    assert.equal((await getAdminPayment(expiringPayment.id)).payment.status, "cancelled");
    assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [expiring.order.id])).rows[0].status, "cancelled");
    assert.equal(Number((await pool.query("SELECT usage_count FROM promotion_campaigns WHERE id=$1", [expiringCouponId])).rows[0].usage_count), 0);
    assert.equal(Number((await pool.query("SELECT count(*) FROM promotion_usages WHERE order_id=$1", [expiring.order.id])).rows[0].count), 0);
    assert.equal((await pool.query("SELECT status FROM inventory_reservations WHERE order_id=$1", [expiring.order.id])).rows[0].status, "released");
    assert.equal(Number((await pool.query("SELECT quantity_reserved AS reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].reserved), reservedBeforeExpiration - 1);

    const expiredWithoutIntent = await makeOrder(1, "expired-without-intent");
    const expiredWithoutIntentPayment = (await pool.query(
      `INSERT INTO payments (order_id,provider,status,amount,currency,idempotency_key)
       VALUES ($1,'fake','pending',10,'EUR',$2) RETURNING id`,
      [expiredWithoutIntent.order.id, `${marker}-expired-without-intent`],
    )).rows[0];
    await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [expiredWithoutIntent.order.id]);
    assert.equal((await expirePaymentReservations()).released, 1);
    assert.deepEqual(
      (await pool.query("SELECT status,provider_payment_id AS \"providerPaymentId\" FROM payments WHERE id=$1", [expiredWithoutIntentPayment.id])).rows[0],
      { status: "cancelled", providerPaymentId: null },
    );

    for (const providerState of ["pending", "requires_action", "cancelled", "failed"] as const) {
      const stateOrder = await makeOrder(1, `expired-${providerState}`);
      const statePayment = (await createPayment(
        stateOrder.order.id,
        { guestSessionId: stateOrder.session, guestAccessToken: stateOrder.guestAccessToken },
        `${marker}-expired-${providerState}`,
      )).payment;
      setFakePaymentStatusForTest(statePayment.providerPaymentId!, providerState);
      await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [stateOrder.order.id]);
      assert.equal((await expirePaymentReservations()).released, 1);
      const terminalState = (await pool.query(
        `SELECT p.status,o.status AS "orderStatus",o.payment_status AS "orderPaymentStatus",ir.status AS "reservationStatus"
           FROM payments p JOIN orders o ON o.id=p.order_id
           JOIN inventory_reservations ir ON ir.order_id=o.id WHERE p.id=$1`,
        [statePayment.id],
      )).rows[0];
      assert.equal(terminalState.status, providerState === "failed" ? "failed" : "cancelled");
      assert.equal(terminalState.orderStatus, "cancelled");
      assert.equal(terminalState.orderPaymentStatus, providerState === "failed" ? "failed" : "cancelled");
      assert.equal(terminalState.reservationStatus, "released");
      assert.equal(getFakePaymentCancelCountForTest(statePayment.providerPaymentId!), ["pending", "requires_action"].includes(providerState) ? 1 : 0);
      assert.deepEqual(await expirePaymentReservations(), { released: 0, finalized: 0, failed: 0 });
    }

    const processingExpiry = await makeOrder(1, "expired-processing");
    const processingPayment = (await createPayment(
      processingExpiry.order.id,
      { guestSessionId: processingExpiry.session, guestAccessToken: processingExpiry.guestAccessToken },
      `${marker}-expired-processing`,
    )).payment;
    setFakePaymentStatusForTest(processingPayment.providerPaymentId!, "processing");
    await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [processingExpiry.order.id]);
    assert.equal((await expirePaymentReservations()).failed, 1);
    assert.equal(getFakePaymentCancelCountForTest(processingPayment.providerPaymentId!), 0);
    const processingState = (await pool.query(
      `SELECT p.status,o.status AS "orderStatus",ir.status AS "reservationStatus",j.status AS "jobStatus",j.retryable
         FROM payments p JOIN orders o ON o.id=p.order_id
         JOIN inventory_reservations ir ON ir.order_id=o.id
         JOIN payment_recovery_jobs j ON j.payment_id=p.id AND j.operation='expiration'
        WHERE p.id=$1`,
      [processingPayment.id],
    )).rows[0];
    assert.deepEqual(processingState, { status: "processing", orderStatus: "pending", reservationStatus: "active", jobStatus: "failed", retryable: false });
    assert.deepEqual(await expirePaymentReservations(), { released: 0, finalized: 0, failed: 0 });
    await pool.query("DELETE FROM payment_recovery_jobs WHERE payment_id=$1 AND operation='expiration'", [processingPayment.id]);
    setFakePaymentStatusForTest(processingPayment.providerPaymentId!, "cancelled");
    assert.equal((await expirePaymentReservations()).released, 1);

    const processingRaceExpiry = await makeOrder(1, "expired-processing-race");
    const processingRacePayment = (await createPayment(
      processingRaceExpiry.order.id,
      { guestSessionId: processingRaceExpiry.session, guestAccessToken: processingRaceExpiry.guestAccessToken },
      `${marker}-expired-processing-race`,
    )).payment;
    setFakePaymentStatusForTest(processingRacePayment.providerPaymentId!, "requires_action");
    setFakePaymentStatusOnCancelForTest(processingRacePayment.providerPaymentId!, "processing");
    await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [processingRaceExpiry.order.id]);
    assert.equal((await expirePaymentReservations()).failed, 1);
    assert.equal(getFakePaymentCancelCountForTest(processingRacePayment.providerPaymentId!), 0);
    const processingRaceState = (await pool.query(
      `SELECT p.status,o.status AS "orderStatus",ir.status AS "reservationStatus",j.retryable
         FROM payments p JOIN orders o ON o.id=p.order_id
         JOIN inventory_reservations ir ON ir.order_id=o.id
         JOIN payment_recovery_jobs j ON j.payment_id=p.id AND j.operation='expiration'
        WHERE p.id=$1`,
      [processingRacePayment.id],
    )).rows[0];
    assert.deepEqual(processingRaceState, { status: "processing", orderStatus: "pending", reservationStatus: "active", retryable: false });
    assert.deepEqual(await expirePaymentReservations(), { released: 0, finalized: 0, failed: 0 });
    await pool.query("DELETE FROM payment_recovery_jobs WHERE payment_id=$1 AND operation='expiration'", [processingRacePayment.id]);
    setFakePaymentStatusForTest(processingRacePayment.providerPaymentId!, "cancelled");
    assert.equal((await expirePaymentReservations()).released, 1);

    const succeededExpiry = await makeOrder(1, "expired-succeeded");
    const succeededExpiryPayment = (await createPayment(
      succeededExpiry.order.id,
      { guestSessionId: succeededExpiry.session, guestAccessToken: succeededExpiry.guestAccessToken },
      `${marker}-expired-succeeded`,
    )).payment;
    setFakePaymentStatusForTest(succeededExpiryPayment.providerPaymentId!, "succeeded");
    await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [succeededExpiry.order.id]);
    assert.equal((await expirePaymentReservations()).finalized, 1);
    assert.equal(getFakePaymentCancelCountForTest(succeededExpiryPayment.providerPaymentId!), 0);
    const succeededExpiryState = (await pool.query(
      `SELECT p.status,o.status AS "orderStatus",o.payment_status AS "orderPaymentStatus",ir.status AS "reservationStatus"
         FROM payments p JOIN orders o ON o.id=p.order_id
         JOIN inventory_reservations ir ON ir.order_id=o.id WHERE p.id=$1`,
      [succeededExpiryPayment.id],
    )).rows[0];
    assert.deepEqual(succeededExpiryState, { status: "paid", orderStatus: "confirmed", orderPaymentStatus: "paid", reservationStatus: "converted" });
    assert.deepEqual(await expirePaymentReservations(), { released: 0, finalized: 0, failed: 0 });

    const recovering = await makeOrder(1, "recovering-webhook");
    const recoveringPayment = (await createPayment(recovering.order.id, { guestSessionId: recovering.session, guestAccessToken: recovering.guestAccessToken }, `${marker}-payment-recovering`)).payment;
    const recoveryEventId = `${marker}-event-recovery`;
    const recoveryPayload = { id: recoveryEventId, type: "payment_intent.succeeded", data: { object: { id: recoveringPayment.providerPaymentId, status: "succeeded", amount_received: 1000, currency: "eur", metadata: { order_id: recovering.order.id } } } };
    const recoveryJob = (await pool.query(
      `INSERT INTO payment_recovery_jobs (order_id,payment_id,provider_event_id,event_type,operation,payload_json,last_error)
       VALUES ($1,$2,$3,'payment_intent.succeeded','webhook',$4,'Simulated transient webhook failure') RETURNING id`,
      [recovering.order.id, recoveringPayment.id, recoveryEventId, recoveryPayload],
    )).rows[0];
    const workerResults = await Promise.all([runPaymentRecovery(), runPaymentRecovery()]);
    assert.equal(workerResults.reduce((sum, result) => sum + result.claimed, 0), 1);
    assert.equal((await getAdminPayment(recoveringPayment.id)).payment.status, "paid");
    assert.equal((await pool.query("SELECT status,attempts FROM payment_recovery_jobs WHERE id=$1", [recoveryJob.id])).rows[0].status, "succeeded");
    assert.equal(Number((await pool.query("SELECT attempts FROM payment_recovery_jobs WHERE id=$1", [recoveryJob.id])).rows[0].attempts), 1);
    assert.ok((await listPaymentRecovery({ status: "succeeded" })).items.some((item) => item.id === recoveryJob.id));
    await pool.query("UPDATE payment_recovery_jobs SET status='processing',locked_at=now(),lock_token=gen_random_uuid() WHERE id=$1", [recoveryJob.id]);
    await assert.rejects(() => retryPaymentRecovery(recoveryJob.id), /active recovery attempt/);
    await handleWebhook(Buffer.from(JSON.stringify(recoveryPayload)), "test-signature");
    assert.equal((await pool.query("SELECT status FROM payment_recovery_jobs WHERE id=$1", [recoveryJob.id])).rows[0].status, "processing");
    await pool.query("UPDATE payment_recovery_jobs SET status='succeeded',locked_at=NULL,lock_token=NULL WHERE id=$1", [recoveryJob.id]);
    await retryPaymentRecovery(recoveryJob.id);
    assert.equal((await runPaymentRecovery()).succeeded, 1);
    assert.equal(Number((await pool.query("SELECT attempts FROM payment_recovery_jobs WHERE id=$1", [recoveryJob.id])).rows[0].attempts), 2);
    assert.equal(Number((await pool.query("SELECT count(*) FROM payment_recovery_attempts WHERE payment_id=$1 AND source='webhook'", [recoveringPayment.id])).rows[0].count), 2);
    assert.equal(Number((await pool.query("SELECT count(*) FROM inventory_movements WHERE reference_id=$1 AND movement_type='sale'", [recovering.order.id])).rows[0].count), 1);

    const ambiguousRefund = (await pool.query(
      `INSERT INTO refunds (order_id,payment_id,amount,currency,status,idempotency_key,created_at,updated_at)
       VALUES ($1,$2,1,'EUR','processing',$3,now()-interval '21 hours',now()-interval '21 hours') RETURNING id`,
      [recovering.order.id, recoveringPayment.id, `${marker}-ambiguous-refund`],
    )).rows[0];
    const ambiguousRefundJob = (await pool.query(
      `INSERT INTO payment_recovery_jobs (order_id,payment_id,refund_id,operation,last_error)
       VALUES ($1,$2,$3,'refund','Provider outcome unknown') RETURNING id`,
      [recovering.order.id, recoveringPayment.id, ambiguousRefund.id],
    )).rows[0];
    const ambiguousRecovery = await runPaymentRecovery();
    assert.equal(ambiguousRecovery.failed, 1);
    const quarantined = (await pool.query("SELECT status,retryable,attempts FROM payment_recovery_jobs WHERE id=$1", [ambiguousRefundJob.id])).rows[0];
    assert.equal(quarantined.status, "failed");
    assert.equal(quarantined.retryable, false);
    assert.equal(Number(quarantined.attempts), 1);
    assert.equal((await pool.query("SELECT provider_reference AS reference FROM refunds WHERE id=$1", [ambiguousRefund.id])).rows[0].reference, null);
    await assert.rejects(() => retryPaymentRecovery(ambiguousRefundJob.id), /integrity limit/);
    assert.equal((await pool.query("SELECT retryable FROM payment_recovery_jobs WHERE id=$1", [ambiguousRefundJob.id])).rows[0].retryable, false);

    // Refund recovery scenarios each own their payment/order. The ambiguous
    // refund above intentionally leaves a protective reservation and must not
    // be reused for a later, independent provider outcome.
    const pendingRecovery = await makeOrder(1, "pending-refund-recovery");
    const pendingRecoveryPayment = (await createPayment(
      pendingRecovery.order.id,
      { guestSessionId: pendingRecovery.session, guestAccessToken: pendingRecovery.guestAccessToken },
      `${marker}-payment-pending-refund`,
    )).payment;
    await pool.query("UPDATE payments SET provider_payment_id='fake_pi_refund_pending_100_EUR' WHERE id=$1", [pendingRecoveryPayment.id]);
    const pendingRefund = (await pool.query(
      `INSERT INTO refunds (order_id,payment_id,amount,currency,status,idempotency_key,created_at,updated_at)
       VALUES ($1,$2,1,'EUR','processing',$3,now()-interval '11 minutes',now()-interval '11 minutes') RETURNING id`,
      [pendingRecovery.order.id, pendingRecoveryPayment.id, `${marker}-pending-refund`],
    )).rows[0];
    assert.equal((await queueStuckPaymentRecoveries()).queued, 1);
    assert.equal((await runPaymentRecovery()).failed, 1);
    const pendingRefundState = (await pool.query(
      `SELECT r.status,j.id AS "jobId",j.status AS "jobStatus",j.retryable
         FROM refunds r JOIN payment_recovery_jobs j ON j.refund_id=r.id WHERE r.id=$1`,
      [pendingRefund.id],
    )).rows[0];
    assert.equal(pendingRefundState.status, "processing");
    assert.equal(pendingRefundState.jobStatus, "failed");
    assert.equal(pendingRefundState.retryable, true);
    await pool.query(
      "UPDATE payment_recovery_jobs SET attempts=$1,next_attempt_at=now() WHERE id=$2",
      [env.PAYMENT_RECOVERY_MAX_RETRIES - 1, pendingRefundState.jobId],
    );
    assert.equal((await runPaymentRecovery()).failed, 1);
    const cappedJob = (await pool.query("SELECT attempts,retryable FROM payment_recovery_jobs WHERE id=$1", [pendingRefundState.jobId])).rows[0];
    assert.equal(Number(cappedJob.attempts), env.PAYMENT_RECOVERY_MAX_RETRIES);
    assert.equal(cappedJob.retryable, false);
    assert.equal((await runPaymentRecovery()).claimed, 0);
    await assert.rejects(() => retryPaymentRecovery(pendingRefundState.jobId), /automatic retry/);
    assert.equal(Number((await pool.query("SELECT attempts FROM payment_recovery_jobs WHERE id=$1", [pendingRefundState.jobId])).rows[0].attempts), env.PAYMENT_RECOVERY_MAX_RETRIES);

    const mismatchedRefundOrder = await makeOrder(1, "mismatched-refund-recovery");
    const mismatchedRefundPayment = (await createPayment(
      mismatchedRefundOrder.order.id,
      { guestSessionId: mismatchedRefundOrder.session, guestAccessToken: mismatchedRefundOrder.guestAccessToken },
      `${marker}-payment-mismatched-refund`,
    )).payment;
    await pool.query("UPDATE payments SET provider_payment_id=$1 WHERE id=$2", [`fake_pi_refund_succeeded_${Date.now()}_USD`, mismatchedRefundPayment.id]);
    const mismatchedRefund = (await pool.query(
      `INSERT INTO refunds (order_id,payment_id,amount,currency,status,idempotency_key)
       VALUES ($1,$2,1,'EUR','processing',$3) RETURNING id`,
      [mismatchedRefundOrder.order.id, mismatchedRefundPayment.id, `${marker}-mismatched-refund`],
    )).rows[0];
    const mismatchedRefundJob = (await pool.query(
      `INSERT INTO payment_recovery_jobs (order_id,payment_id,refund_id,operation,last_error)
       VALUES ($1,$2,$3,'refund','Provider outcome unknown') RETURNING id`,
      [mismatchedRefundOrder.order.id, mismatchedRefundPayment.id, mismatchedRefund.id],
    )).rows[0];
    assert.equal((await runPaymentRecovery()).failed, 1);
    assert.equal((await pool.query("SELECT retryable FROM payment_recovery_jobs WHERE id=$1", [mismatchedRefundJob.id])).rows[0].retryable, false);

    const missedWebhook = await makeOrder(1, "missed-webhook");
    const missedPayment = (await createPayment(missedWebhook.order.id, { guestSessionId: missedWebhook.session, guestAccessToken: missedWebhook.guestAccessToken }, `${marker}-payment-missed`)).payment;
    assert.equal(missedPayment.status, "requires_action");
    await pool.query(
      "UPDATE payments SET provider_payment_id=$1,updated_at=now()-interval '11 minutes' WHERE id=$2",
      [`fake_pi_succeeded_1000_EUR_${missedWebhook.order.id}`, missedPayment.id],
    );
    assert.equal((await queueStuckPaymentRecoveries()).queued, 1);
    assert.ok((await listPaymentRecovery()).stuck.some((item) => item.id === missedPayment.id));
    const staleWorkerResults = await Promise.all([runPaymentRecovery(), runPaymentRecovery()]);
    assert.equal(staleWorkerResults.reduce((sum, result) => sum + result.claimed, 0), 1);
    assert.equal((await getAdminPayment(missedPayment.id)).payment.status, "paid");
    const recoveredOrder = (await pool.query("SELECT status,payment_status AS \"paymentStatus\" FROM orders WHERE id=$1", [missedWebhook.order.id])).rows[0];
    assert.equal(recoveredOrder.status, "confirmed");
    assert.equal(recoveredOrder.paymentStatus, "paid");
    const recoveredJob = (await pool.query("SELECT status,attempts FROM payment_recovery_jobs WHERE payment_id=$1 AND operation='payment_status'", [missedPayment.id])).rows[0];
    assert.equal(recoveredJob.status, "succeeded");
    assert.equal(Number(recoveredJob.attempts), 1);
    assert.equal(Number((await pool.query("SELECT count(*) FROM inventory_movements WHERE reference_id=$1 AND movement_type='sale'", [missedWebhook.order.id])).rows[0].count), 1);
    assert.equal((await runPaymentRecovery()).claimed, 0);
    assert.equal(Number((await pool.query("SELECT count(*) FROM inventory_movements WHERE reference_id=$1 AND movement_type='sale'", [missedWebhook.order.id])).rows[0].count), 1);

    const mismatchedExpiry = await makeOrder(1, "mismatched-expiry");
    const mismatchedExpiryPayment = (await createPayment(mismatchedExpiry.order.id, { guestSessionId: mismatchedExpiry.session, guestAccessToken: mismatchedExpiry.guestAccessToken }, `${marker}-payment-expiry-mismatch`)).payment;
    setFakePaymentStatusForTest(mismatchedExpiryPayment.providerPaymentId!, "succeeded");
    setFakePaymentFactsForTest(mismatchedExpiryPayment.providerPaymentId!, { amountCents: 999, currency: "EUR", orderId: mismatchedExpiry.order.id });
    await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [mismatchedExpiry.order.id]);
    assert.equal((await expirePaymentReservations()).failed, 1);
    assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [mismatchedExpiry.order.id])).rows[0].status, "pending");
    // The contradiction is quarantined by the expiration scan and is not
    // eligible for another provider attempt.
    assert.equal((await runPaymentRecovery()).claimed, 0);
    const expiryQuarantine = (await pool.query("SELECT retryable FROM payment_recovery_jobs WHERE payment_id=$1 AND operation='expiration' ORDER BY created_at DESC LIMIT 1", [mismatchedExpiryPayment.id])).rows[0];
    assert.equal(expiryQuarantine.retryable, false);
    assert.ok(Number((await pool.query("SELECT count(*) FROM payment_recovery_attempts WHERE payment_id=$1 AND status='failed'", [mismatchedExpiryPayment.id])).rows[0].count) >= 1);

    const gatedCreation = await makeOrder(1, "toonies-gated-payment-creation");
    const gatedRecovery = await makeOrder(1, "toonies-gated-payment-recovery");
    const gatedRecoveryAccess = { guestSessionId: gatedRecovery.session, guestAccessToken: gatedRecovery.guestAccessToken };
    const gatedRecoveryPayment = (await createPayment(
      gatedRecovery.order.id,
      gatedRecoveryAccess,
      `${marker}-toonies-gated-recovery`,
    )).payment;
    assert.equal(gatedRecoveryPayment.status, "requires_action");
    const supplier = (await pool.query("SELECT id FROM suppliers WHERE slug='toonies' AND active=true")).rows[0];
    assert.ok(supplier, "the canonical Toonies supplier is required");
    maintenanceCatalogueItemId = (await pool.query(
      `INSERT INTO supplier_catalogue_items
        (supplier_id,external_product_id,external_category_id,title,original_amount,original_currency,normalized_eur,normalized_currency,minimum_order_quantity,stock,state,needs_review)
       VALUES($1,$2,$3,$4,1,'CNY',1,'EUR',1,10,'Synced',false) RETURNING id`,
      [supplier.id, `${marker}-gate-product`, `${marker}-gate-category`, `${marker} gate product`],
    )).rows[0].id;
    maintenanceCatalogueVariantId = (await pool.query(
      `INSERT INTO supplier_catalogue_variants
        (supplier_id,catalogue_item_id,external_variant_id,sku_code,title,attributes,original_amount,original_currency,normalized_eur,normalized_currency,minimum_order_quantity,weight_kg,stock,state,needs_review)
       VALUES($1,$2,$3,$3,$4,'[]'::jsonb,1,'CNY',1,'EUR',1,1,10,'Synced',false) RETURNING id`,
      [supplier.id, maintenanceCatalogueItemId, `${marker}-gate-variant`, `${marker} gate variant`],
    )).rows[0].id;
    maintenanceSupplierLinkId = (await pool.query(
      `INSERT INTO supplier_product_links(supplier_id,catalogue_item_id,catalogue_variant_id,product_id,variant_id)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [supplier.id, maintenanceCatalogueItemId, maintenanceCatalogueVariantId, productId, variantId],
    )).rows[0].id;
    for (const fixtureOrderId of [gatedCreation.order.id, gatedRecovery.order.id]) {
      await pool.query(
        `WITH original AS (
           DELETE FROM order_items WHERE order_id=$1 RETURNING *
         )
         INSERT INTO order_items
         SELECT (jsonb_populate_record(
           NULL::order_items,
           to_jsonb(original) || jsonb_build_object(
             'supplier_product_link_id',$2::text,
             'supplier_id',$3::text,
             'supplier_catalogue_item_id',$4::text,
             'supplier_catalogue_variant_id',$5::text,
             'supplier_product_code',$6::text,
             'supplier_sku_code',$7::text,
             'supplier_cost_eur','1.000000',
             'supplier_cost_cny','1.000000000000',
             'supplier_cost_provenance',jsonb_build_object('source','payment_gate_fixture'),
             'supplier_cost_threshold_percent','5.000000'
           )
         )).* FROM original`,
        [
          fixtureOrderId,
          maintenanceSupplierLinkId,
          supplier.id,
          maintenanceCatalogueItemId,
          maintenanceCatalogueVariantId,
          `${marker}-gate-product`,
          `${marker}-gate-variant`,
        ],
      );
    }

    await assert.rejects(
      () => createPayment(
        gatedCreation.order.id,
        { guestSessionId: gatedCreation.session, guestAccessToken: gatedCreation.guestAccessToken },
        `${marker}-toonies-gated-creation`,
      ),
      (error: any) => error.code === "TOONIES_PROCUREMENT_MAINTENANCE" && error.details?.retryable === true,
    );
    assert.equal(Number((await pool.query("SELECT count(*) FROM payments WHERE order_id=$1", [gatedCreation.order.id])).rows[0].count), 0);

    const gatedEventId = `${marker}-toonies-gated-event`;
    const gatedEvent = Buffer.from(JSON.stringify({
      id: gatedEventId,
      type: "payment_intent.succeeded",
      data: { object: {
        id: gatedRecoveryPayment.providerPaymentId,
        status: "succeeded",
        amount_received: 1000,
        currency: "eur",
        metadata: { order_id: gatedRecovery.order.id },
      } },
    }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => handleWebhook(gatedEvent, "test-signature"),
        (error: any) => error.code === "TOONIES_PROCUREMENT_MAINTENANCE",
      );
    }
    assert.equal(Number((await pool.query("SELECT count(*) FROM payment_recovery_jobs WHERE provider_event_id=$1", [gatedEventId])).rows[0].count), 1);
    assert.equal(Number((await pool.query("SELECT count(*) FROM payment_events WHERE provider_event_id=$1", [gatedEventId])).rows[0].count), 0);
    assert.equal((await getAdminPayment(gatedRecoveryPayment.id)).payment.status, "requires_action");
    assert.equal((await pool.query("SELECT payment_status AS status FROM orders WHERE id=$1", [gatedRecovery.order.id])).rows[0].status, "pending");
    assert.equal(Number((await pool.query("SELECT count(*) FROM toonies_procurement_commands WHERE order_id=$1", [gatedRecovery.order.id])).rows[0].count), 0);
    assert.equal((await runPaymentRecovery()).failed, 1);
    const gatedRecoveryJob = (await pool.query(
      "SELECT attempts,retryable,status FROM payment_recovery_jobs WHERE provider_event_id=$1",
      [gatedEventId],
    )).rows[0];
    assert.deepEqual(gatedRecoveryJob, { attempts: 0, retryable: true, status: "failed" });
    assert.equal((await getAdminPayment(gatedRecoveryPayment.id)).payment.status, "requires_action");
    assert.equal(Number((await pool.query("SELECT count(*) FROM toonies_procurement_commands WHERE order_id=$1", [gatedRecovery.order.id])).rows[0].count), 0);

    console.info("Payment lifecycle, recovery queue, webhook replay, refund, concurrency, and amount-safety checks passed.");
  } finally {
    if (orderIds.length) await pool.query("DELETE FROM notification_deliveries WHERE metadata_json->>'orderId'=ANY($1::text[])", [orderIds]);
    if (orderIds.length) await pool.query("DELETE FROM notifications WHERE data_json->>'orderId'=ANY($1::text[])", [orderIds]);
    for (const orderId of orderIds) await pool.query("DELETE FROM audit_logs WHERE entity_id=$1::uuid OR new_values_json->>'orderId'=$1::text", [orderId]);
    if (orderIds.length) await pool.query("DELETE FROM inventory_movements WHERE reference_type='order' AND reference_id=ANY($1::uuid[])", [orderIds]);
    if (orderIds.length) await pool.query("DELETE FROM refunds WHERE order_id=ANY($1::uuid[])", [orderIds]);
    if (orderIds.length) await pool.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [orderIds]);
    if (maintenanceSupplierLinkId) await pool.query("DELETE FROM supplier_product_links WHERE id=$1", [maintenanceSupplierLinkId]);
    if (maintenanceCatalogueVariantId) await pool.query("DELETE FROM supplier_catalogue_variants WHERE id=$1", [maintenanceCatalogueVariantId]);
    if (maintenanceCatalogueItemId) await pool.query("DELETE FROM supplier_catalogue_items WHERE id=$1", [maintenanceCatalogueItemId]);
    await pool.query("DELETE FROM carts WHERE guest_session_id LIKE $1", [`${marker}%`]);
    if (customerId) await pool.query("DELETE FROM carts WHERE user_id=$1", [customerId]);
    if (expiringCouponId) await pool.query("DELETE FROM promotion_campaigns WHERE id=$1", [expiringCouponId]);
    if (productId) await pool.query("DELETE FROM products WHERE id=$1", [productId]);
    if (warehouseId) await pool.query("DELETE FROM warehouses WHERE id=$1", [warehouseId]);
    if (categoryId) await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]);
    if (customerId) await pool.query("DELETE FROM users WHERE id=$1", [customerId]);
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});