import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { addItem, getCart } from "../cart/service.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { createPayment } from "../payments/service.js";
import { createOrder, validateCheckout } from "./service.js";

const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const marker = `tax-integrity-${suffix}`;
const address = {
  firstName: "Tax",
  lastName: "Buyer",
  addressLine1: "1 Integrity Street",
  city: "Nicosia",
  postalCode: "1000",
  countryCode: "CY",
};

async function run() {
  const pool = getDatabasePool();
  let categoryId = "";
  let warehouseId = "";
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const sessions: string[] = [];
  try {
    categoryId = (await pool.query(
      "INSERT INTO categories(name,slug,description,active) VALUES($1,$2,$3,true) RETURNING id",
      [`Tax integrity ${suffix}`, marker, marker],
    )).rows[0].id;
    warehouseId = (await pool.query(
      "INSERT INTO warehouses(name,code,country_code) VALUES($1,$2,'CY') RETURNING id",
      [`Tax integrity ${suffix}`, marker],
    )).rows[0].id;

    const createProduct = async (name: string, basePrice: number, taxMode: "inclusive" | "exclusive", vatRate = 19) => {
      const productId = (await pool.query(
        `INSERT INTO products(name,slug,parent_sku,category_id,description,cost_price,base_price,vat_rate,tax_mode,vat_classified_at,weight,status,published_at)
         VALUES($1,$2,$3,$4,$5,40,$6,$7,$8,now(),1,'active',now()) RETURNING id`,
        [name, `${marker}-${taxMode}-${productIds.length}`, `${marker}-${taxMode}-${productIds.length}`, categoryId, marker, basePrice, vatRate, taxMode],
      )).rows[0].id as string;
      productIds.push(productId);
      await pool.query(
        "INSERT INTO inventory(warehouse_id,product_id,quantity_on_hand,quantity_reserved,active) VALUES($1,$2,20,0,true)",
        [warehouseId, productId],
      );
      return productId;
    };

    const exclusiveProduct = await createProduct("Exclusive VAT", 100, "exclusive");
    const exclusiveSession = `${marker}-exclusive`;
    sessions.push(exclusiveSession);
    await addItem({ guestSessionId: exclusiveSession }, { productId: exclusiveProduct, quantity: 1 });
    const exclusiveCart = await getCart({ guestSessionId: exclusiveSession });
    assert.deepEqual(
      { subtotal: exclusiveCart.totals.subtotal, tax: exclusiveCart.totals.taxTotal, payable: exclusiveCart.totals.grandTotal },
      { subtotal: 100, tax: 19, payable: 119 },
      "exclusive €100 merchandise must add €19 VAT to the payable total",
    );
    const exclusiveValidation = await validateCheckout({ guestSessionId: exclusiveSession }, address, 119);
    assert.equal(exclusiveValidation.valid, true);
    const exclusiveOrder = await createOrder({ guestSessionId: exclusiveSession }, {
      email: `${exclusiveSession}@example.com`,
      billingAddress: address,
      shippingAddress: address,
      idempotencyKey: `${exclusiveSession}-order`,
      expectedGrandTotal: 119,
    });
    orderIds.push(exclusiveOrder.order.id);
    assert.equal(exclusiveOrder.order.taxTotal, 19);
    assert.equal(exclusiveOrder.order.grandTotal, 119);
    assert.equal(exclusiveOrder.order.items[0]!.taxMode, "exclusive");
    assert.match(exclusiveOrder.order.totalFingerprint, /^[0-9a-f]{64}$/);
    const payment = await createPayment(exclusiveOrder.order.id, {
      guestSessionId: exclusiveSession,
      guestAccessToken: exclusiveOrder.guestAccessToken,
    }, `${exclusiveSession}-payment`);
    assert.equal(payment.payment.amount, 119, "provider amount must equal the authoritative payable total");
    const paymentSnapshot = (await pool.query(
      `SELECT p.amount,p.order_total_fingerprint AS "paymentFingerprint",o.total_fingerprint AS "orderFingerprint"
         FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=$1`,
      [payment.payment.id],
    )).rows[0];
    assert.equal(Number(paymentSnapshot.amount), 119);
    assert.equal(paymentSnapshot.paymentFingerprint, paymentSnapshot.orderFingerprint);

    const inclusiveProduct = await createProduct("Inclusive VAT", 119, "inclusive");
    const inclusiveSession = `${marker}-inclusive`;
    sessions.push(inclusiveSession);
    await addItem({ guestSessionId: inclusiveSession }, { productId: inclusiveProduct, quantity: 1 });
    const inclusiveCart = await getCart({ guestSessionId: inclusiveSession });
    assert.deepEqual(
      { subtotal: inclusiveCart.totals.subtotal, tax: inclusiveCart.totals.taxTotal, payable: inclusiveCart.totals.grandTotal },
      { subtotal: 119, tax: 19, payable: 119 },
      "inclusive €119 merchandise must extract €19 VAT without adding it again",
    );

    const staleProduct = await createProduct("Stale VAT", 100, "exclusive");
    const staleSession = `${marker}-stale`;
    sessions.push(staleSession);
    await addItem({ guestSessionId: staleSession }, { productId: staleProduct, quantity: 1 });
    assert.equal((await getCart({ guestSessionId: staleSession })).totals.grandTotal, 119);
    await pool.query("UPDATE products SET vat_rate=20,vat_classified_at=now() WHERE id=$1", [staleProduct]);
    const staleValidation = await validateCheckout({ guestSessionId: staleSession }, address, 119);
    assert.deepEqual(
      { valid: staleValidation.valid, priceChanged: staleValidation.priceChanged, tax: staleValidation.taxTotal, payable: staleValidation.grandTotal },
      { valid: false, priceChanged: true, tax: 20, payable: 120 },
    );
    await assert.rejects(
      () => createOrder({ guestSessionId: staleSession }, {
        email: `${staleSession}@example.com`,
        billingAddress: address,
        shippingAddress: address,
        idempotencyKey: `${staleSession}-order`,
        expectedGrandTotal: 119,
      }),
      (error: any) => error?.code === "CHECKOUT_TOTAL_CHANGED",
      "a changed VAT rate must invalidate a stale checkout total",
    );

    await pool.query("UPDATE products SET vat_rate=20,vat_classified_at=now() WHERE id=$1", [exclusiveProduct]);
    await assert.rejects(
      () => createPayment(exclusiveOrder.order.id, {
        guestSessionId: exclusiveSession,
        guestAccessToken: exclusiveOrder.guestAccessToken,
      }, `${exclusiveSession}-payment`),
      (error: any) => error?.code === "PAYMENT_VAT_STATE_STALE",
      "a payment replay must fail when current VAT facts differ from the order snapshot",
    );

    console.info("Checkout VAT integrity, stale-state, and payment reconciliation checks passed.");
  } finally {
    if (orderIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE entity_id=ANY($1::uuid[]) OR new_values_json->>'orderId'=ANY($2::text[])", [orderIds, orderIds]);
      await pool.query("DELETE FROM orders WHERE id=ANY($1::uuid[])", [orderIds]);
    }
    if (sessions.length) await pool.query("DELETE FROM carts WHERE guest_session_id=ANY($1::text[])", [sessions]);
    if (productIds.length) await pool.query("DELETE FROM products WHERE id=ANY($1::uuid[])", [productIds]);
    if (warehouseId) await pool.query("DELETE FROM warehouses WHERE id=$1", [warehouseId]);
    if (categoryId) await pool.query("DELETE FROM categories WHERE id=$1", [categoryId]);
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});