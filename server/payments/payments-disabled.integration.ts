import assert from "node:assert/strict";
import { addItem } from "../cart/service.js";
import { env } from "../config/env.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { createOrder } from "../orders/service.js";
import { getPaymentProvider } from "./provider.js";
import { expirePaymentReservations, queuePaymentReconciliation, runPaymentRecovery } from "./service.js";

assert.equal(getPaymentProvider().name, "stripe");
assert.equal(getPaymentProvider().configured, false);

const pool = getDatabasePool();
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const marker = `disabled-payment-${suffix}`;
let categoryId = "";
let productId = "";
let warehouseId = "";
const orderIds: string[] = [];

try {
  categoryId = (await pool.query("INSERT INTO categories (name,slug,description) VALUES ($1,$2,$3) RETURNING id", [`Disabled payment ${suffix}`, marker, marker])).rows[0].id;
  productId = (await pool.query(
    `INSERT INTO products (name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,weight,status,published_at)
     VALUES ($1,$2,$3,$4,$5,4,10,19,1,'active',now()) RETURNING id`,
    [`Disabled payment ${suffix}`, `${marker}-product`, `${marker}-sku`, categoryId, marker],
  )).rows[0].id;
  const variantId = (await pool.query("INSERT INTO product_variants (product_id,sku,title,cost_price,base_price,active) VALUES ($1,$2,'Case',5,10,true) RETURNING id", [productId, `${marker}-variant`])).rows[0].id;
  warehouseId = (await pool.query("INSERT INTO warehouses (name,code,country_code) VALUES ($1,$2,'CY') RETURNING id", [`Disabled payment ${suffix}`, marker])).rows[0].id;
  await pool.query("INSERT INTO inventory (warehouse_id,variant_id,quantity_on_hand,quantity_reserved,low_stock_threshold) VALUES ($1,$2,10,0,2)", [warehouseId, variantId]);
  await addItem({ guestSessionId: marker }, { productId, variantId, quantity: 1 });
  const created = await createOrder({ guestSessionId: marker }, {
    email: `${marker}@example.com`,
    billingAddress: { firstName: "Provider", lastName: "Disabled", addressLine1: "1 Test Street", city: "Nicosia", postalCode: "1000", countryCode: "CY" },
    shippingAddress: { firstName: "Provider", lastName: "Disabled", addressLine1: "1 Test Street", city: "Nicosia", postalCode: "1000", countryCode: "CY" },
    idempotencyKey: `${marker}-order`,
    expectedGrandTotal: 10,
  });
  const orderId = created.order.id;
  orderIds.push(orderId);
  const paymentId = (await pool.query(
    `INSERT INTO payments (order_id,provider,status,amount,currency,idempotency_key,order_total_fingerprint)
     SELECT id,'stripe','pending',10,'EUR',$2,total_fingerprint FROM orders WHERE id=$1 RETURNING id`,
    [orderId, `${marker}-payment`],
  )).rows[0].id;
  await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [orderId]);
  assert.equal(Number((await pool.query("SELECT quantity_reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].quantity_reserved), 1);
  assert.equal((await expirePaymentReservations()).released, 1);
  assert.equal((await pool.query("SELECT status FROM payments WHERE id=$1", [paymentId])).rows[0].status, "cancelled");
  assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0].status, "cancelled");
  assert.equal(Number((await pool.query("SELECT quantity_reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].quantity_reserved), 0);
  const heldSession = `${marker}-held`;
  await addItem({ guestSessionId: heldSession }, { productId, variantId, quantity: 1 });
  const held = await createOrder({ guestSessionId: heldSession }, {
    email: `${heldSession}@example.com`,
    billingAddress: { firstName: "Provider", lastName: "Held", addressLine1: "1 Test Street", city: "Nicosia", postalCode: "1000", countryCode: "CY" },
    shippingAddress: { firstName: "Provider", lastName: "Held", addressLine1: "1 Test Street", city: "Nicosia", postalCode: "1000", countryCode: "CY" },
    idempotencyKey: `${heldSession}-order`,
    expectedGrandTotal: 10,
  });
  orderIds.push(held.order.id);
  const providerReference = `fake_pi_succeeded_1000_EUR_${held.order.id}`;
  const heldPaymentId = (await pool.query(
    `INSERT INTO payments (order_id,provider,provider_payment_id,status,amount,currency,idempotency_key,order_total_fingerprint)
     SELECT id,'stripe',$2,'pending',10,'EUR',$3,total_fingerprint FROM orders WHERE id=$1 RETURNING id`,
    [held.order.id, providerReference, `${heldSession}-payment`],
  )).rows[0].id;
  await pool.query("UPDATE orders SET reservation_expires_at=now()-interval '1 minute' WHERE id=$1", [held.order.id]);
  assert.equal((await expirePaymentReservations()).failed, 1);
  assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [held.order.id])).rows[0].status, "pending");
  assert.equal(Number((await pool.query("SELECT quantity_reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].quantity_reserved), 1);
  const review = (await pool.query("SELECT status,retryable FROM payment_recovery_jobs WHERE payment_id=$1 AND operation='expiration'", [heldPaymentId])).rows[0];
  assert.equal(review.status, "failed");
  assert.equal(review.retryable, false);
  assert.deepEqual(await expirePaymentReservations(), { released: 0, finalized: 0, failed: 0 });
  env.PAYMENT_PROVIDER = "fake";
  await queuePaymentReconciliation(heldPaymentId);
  assert.equal((await runPaymentRecovery()).succeeded, 1);
  assert.equal((await pool.query("SELECT status FROM payments WHERE id=$1", [heldPaymentId])).rows[0].status, "paid");
  assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [held.order.id])).rows[0].status, "confirmed");
  assert.equal(Number((await pool.query("SELECT quantity_reserved FROM inventory WHERE variant_id=$1", [variantId])).rows[0].quantity_reserved), 0);
  assert.equal((await runPaymentRecovery()).claimed, 0);
} finally {
  for (const orderId of orderIds) await pool.query("DELETE FROM audit_logs WHERE entity_id=$1::uuid OR new_values_json->>'orderId'=$1::text", [orderId]);
  if (orderIds.length) await pool.query("DELETE FROM inventory_movements WHERE reference_type='order' AND reference_id=ANY($1::uuid[])", [orderIds]);
  if (orderIds.length) await pool.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [orderIds]);
  await pool.query("DELETE FROM carts WHERE guest_session_id LIKE $1", [`${marker}%`]);
  if (productId) await pool.query("DELETE FROM products WHERE id=$1", [productId]);
  if (warehouseId) await pool.query("DELETE FROM warehouses WHERE id=$1", [warehouseId]);
  if (categoryId) await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]);
  await closeDatabase();
}
console.info("Missing Stripe credentials leave the payment provider safely disabled.");