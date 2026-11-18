import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";
import { acquireFinancialOperation, markFinancialOperationTransmitting } from "./operation-reservation.js";

assertMutableIntegrationTestDatabase("financial operation reservation integration");
const pool = getDatabasePool();
const marker = `financial-interlock-${randomUUID()}`;

async function run() {
  const order = (await pool.query(
    `INSERT INTO orders(order_number,guest_email,status,payment_status,fulfillment_status,fulfillment_stage,currency,subtotal,discount_total,shipping_total,tax_total,grand_total,total_fingerprint,billing_address_snapshot,shipping_address_snapshot)
     VALUES($1,$2,'confirmed','paid','unfulfilled','unfulfilled','EUR',3,0,0,0,3,$3,$4::jsonb,$4::jsonb) RETURNING id`,
    [marker.slice(0, 36), `${marker}@example.test`, "f".repeat(64), JSON.stringify({ countryCode: "IE", addressLine1: "1 Fixture Street" })],
  )).rows[0];
  assert.ok(order);
  try {
    const first = await Promise.allSettled([1, 2].map(async (index) => {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const result = await acquireFinancialOperation(db, {
          orderId: order.id,
          operationType: index === 1 ? "supplier_settlement" : "payment_refund",
          operationReferenceId: `${marker}-${index}`,
          leaseSeconds: 120,
        });
        await db.query("COMMIT");
        return result;
      } catch (error) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { db.release(); }
    }));
    assert.equal(first.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(first.filter((result) => result.status === "rejected").length, 1);
    const reservation = (await pool.query("SELECT operation_type,state FROM financial_operation_reservations WHERE order_id=$1", [order.id])).rows[0];
    assert.ok(reservation);
    assert.equal(reservation.state, "active");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM financial_operation_reservations WHERE order_id=$1 AND state IN ('active','ambiguous','completed')", [order.id])).rows[0].count, 1);
    const crashOrder = (await pool.query(
      `INSERT INTO orders(order_number,guest_email,status,payment_status,fulfillment_status,fulfillment_stage,currency,subtotal,discount_total,shipping_total,tax_total,grand_total,total_fingerprint,billing_address_snapshot,shipping_address_snapshot)
       VALUES($1,$2,'confirmed','paid','unfulfilled','unfulfilled','EUR',3,0,0,0,3,$3,$4::jsonb,$4::jsonb) RETURNING id`,
      [`${marker.slice(0, 28)}-crash`, `${marker}-crash@example.test`, "e".repeat(64), JSON.stringify({ countryCode: "IE" })],
    )).rows[0];
    const crashDb = await pool.connect();
    try {
      await crashDb.query("BEGIN");
      const supplierReservation = await acquireFinancialOperation(crashDb, { orderId: crashOrder.id, operationType: "supplier_settlement", operationReferenceId: `${marker}-crash-settlement` });
      const transmitting = await markFinancialOperationTransmitting(crashDb, supplierReservation);
      await crashDb.query("COMMIT");
      assert.equal((await pool.query("SELECT state,phase,transmission_started_at FROM financial_operation_reservations WHERE id=$1", [supplierReservation.id])).rows[0].phase, "transmitting");
      await assert.rejects(() => pool.query(
        "INSERT INTO financial_operation_reservations(order_id,operation_type,operation_reference_id,state,phase,lease_token,lease_until,version) VALUES($1,'payment_refund',$2,'active','reserved',gen_random_uuid(),now()+interval '1 minute',0)",
        [crashOrder.id, `${marker}-crash-refund`],
      ));
      void transmitting;
    } finally { crashDb.release(); }
    await pool.query("DELETE FROM financial_operation_reservations WHERE order_id=$1", [crashOrder.id]);
    const refundCrashDb = await pool.connect();
    try {
      await refundCrashDb.query("BEGIN");
      const refundReservation = await acquireFinancialOperation(refundCrashDb, { orderId: crashOrder.id, operationType: "payment_refund", operationReferenceId: `${marker}-crash-refund-transmission` });
      await markFinancialOperationTransmitting(refundCrashDb, refundReservation);
      await refundCrashDb.query("COMMIT");
      assert.equal((await pool.query("SELECT phase,transmission_started_at FROM financial_operation_reservations WHERE id=$1", [refundReservation.id])).rows[0].phase, "transmitting");
      await assert.rejects(() => pool.query(
        "INSERT INTO financial_operation_reservations(order_id,operation_type,operation_reference_id,state,phase,lease_token,lease_until,version) VALUES($1,'supplier_settlement',$2,'active','reserved',gen_random_uuid(),now()+interval '1 minute',0)",
        [crashOrder.id, `${marker}-crash-settlement-after-refund`],
      ));
    } finally { refundCrashDb.release(); }
    await pool.query("DELETE FROM financial_operation_reservations WHERE order_id=$1", [crashOrder.id]);
    await pool.query("DELETE FROM orders WHERE id=$1", [crashOrder.id]);
    console.log("Financial operation reservation race passed.");
  } finally {
    await pool.query("DELETE FROM financial_operation_reservations WHERE order_id=$1", [order.id]);
    await pool.query("DELETE FROM orders WHERE id=$1", [order.id]);
  }
}

try { await run(); } finally { await closeDatabase(); }