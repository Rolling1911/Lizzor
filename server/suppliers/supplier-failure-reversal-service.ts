import { createHash } from "node:crypto";
import { acquireFinancialOperation, markFinancialOperationTransmitting, transitionFinancialOperation } from "../financial/operation-reservation.js";
import { AppError } from "../middleware/error-handler.js";
import { emitNotification } from "../notifications/service.js";
import { getPaymentProvider, type PaymentProvider } from "../payments/provider.js";

type Db = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> };
type Pool = Db & { connect: () => Promise<Db & { release: () => void }> };
// Only outcomes whose meaning is definitive at the supplier boundary may enter
// this saga. In particular, retry exhaustion and malformed responses are absent.
export const SUPPLIER_FAILURE_REASON_CODES = new Set([
  "INVALID_PRODUCT", "INVALID_SKU", "STOCK_REJECTED", "MOQ_REJECTED",
  "DESTINATION_REJECTED", "SUPPLIER_BALANCE_REJECTED", "NO_ORDERABLE_BASKET",
]);
const SUPPLIER_CODE_REASON: Record<number, string> = {
  40010: "INVALID_PRODUCT", 40011: "INVALID_SKU", 40020: "SUPPLIER_BALANCE_REJECTED",
  40021: "STOCK_REJECTED", 40022: "MOQ_REJECTED", 40030: "DESTINATION_REJECTED",
  40042: "NO_ORDERABLE_BASKET",
};
export function mapDocumentedSupplierFailure(code: unknown): string | null {
  const numeric = typeof code === "number" ? code : Number(code);
  return Number.isInteger(numeric) ? SUPPLIER_CODE_REASON[numeric] ?? null : null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )).digest("hex");
}
type RefundFacts = { providerRefundId: string; paymentId: string; localRefundId: string; amount: string; currency: string; status: string };
function assertRefundFacts(facts: RefundFacts, row: any): void {
  if (facts.paymentId !== row.providerPaymentId || facts.localRefundId !== row.refund_id ||
      amountCents(facts.amount) !== amountCents(String(row.payment_amount)) || facts.currency.toUpperCase() !== String(row.payment_currency).toUpperCase() ||
      facts.status !== "succeeded") {
    throw new AppError(409, "SUPPLIER_FAILURE_REFUND_FACTS_MISMATCH", "The provider refund facts do not match the locked refund authority.");
  }
}

/** Creates an eligible saga from persisted supplier evidence only. */
export async function createSupplierFailureReversal(db: Db, input: {
  orderId: string; attemptId: string; reasonCode: string;
}): Promise<any> {
  const source = await db.query(
    `SELECT o.id AS "orderId",o.status AS "orderStatus",o.payment_status AS "paymentStatus",
            o.fulfillment_status AS "fulfillmentStatus",p.id AS "paymentId",
            p.provider_payment_id AS "providerPaymentId",p.amount,p.currency,
            p.order_total_fingerprint AS "paymentFingerprint",o.total_fingerprint AS "orderFingerprint",
            o.grand_total AS "grandTotal",o.currency AS "orderCurrency",
            a.state AS "attemptState",a.raw_snapshot AS "rawSnapshot",
            s.state AS "settlementState",s.transmission_count AS "transmissionCount",
            s.first_submission_at AS "firstSubmissionAt",
            a.failure_code AS "failureCode"
       FROM orders o JOIN payments p ON p.order_id=o.id AND p.status='paid'
       JOIN toonies_procurement_attempts a ON a.id=$2 AND a.order_id=o.id
       LEFT JOIN toonies_settlements s ON s.order_id=o.id
      WHERE o.id=$1 AND p.provider_payment_id IS NOT NULL
        AND p.amount=o.grand_total AND p.currency=o.currency
        AND p.order_total_fingerprint IS NOT NULL AND p.order_total_fingerprint=o.total_fingerprint
      ORDER BY p.paid_at DESC NULLS LAST LIMIT 1`,
    [input.orderId, input.attemptId],
  );
  const row = source.rows[0];
  if (!row || row.orderStatus !== "confirmed" || row.paymentStatus !== "paid" ||
      row.fulfillmentStatus !== "unfulfilled" || row.attemptState !== "failed" ||
      ["submitting", "transmitted_unknown", "reconciling", "replay_pending", "confirmed", "manual_review"].includes(row.settlementState) ||
      (row.settlementState && (row.settlementState !== "documented_rejection" || Number(row.transmissionCount) !== 0 || row.firstSubmissionAt))) {
    throw new Error("SUPPLIER_FAILURE_NOT_ELIGIBLE");
  }
  const snapshot = row.rawSnapshot && typeof row.rawSnapshot === "object" ? row.rawSnapshot : {};
  const lines = (await db.query("SELECT failure_code AS \"failureCode\",orderable,raw_snapshot AS \"rawSnapshot\" FROM toonies_procurement_lines WHERE attempt_id=$1", [input.attemptId])).rows;
  const documentedCodes = [...lines.map((line: any) => mapDocumentedSupplierFailure(line.failureCode)), mapDocumentedSupplierFailure(row.failureCode)].filter(Boolean);
  const derivedReason = [...new Set(documentedCodes)][0] as string | undefined;
  const exactFailedSemantics = lines.length > 0 && lines.every((line: any) =>
    line.orderable === false && (mapDocumentedSupplierFailure(line.failureCode) === derivedReason ||
      (derivedReason === "NO_ORDERABLE_BASKET" && line.failureCode == null)));
  if (!derivedReason || !exactFailedSemantics || !SUPPLIER_FAILURE_REASON_CODES.has(derivedReason) || (input.reasonCode && input.reasonCode !== derivedReason)) {
    throw new Error("SUPPLIER_FAILURE_EVIDENCE_NOT_DEFINITIVE");
  }
  const evidence = { attemptId: input.attemptId, reasonCode: derivedReason, supplierCode: row.failureCode, failedLines: lines.map((line: any) => ({ failureCode: line.failureCode, orderable: line.orderable, rawSnapshot: line.rawSnapshot })), rawSnapshot: snapshot };
  const providerRefundIdentity = `supplier-failure:${input.orderId}`;
  const inserted = await db.query(
    `INSERT INTO supplier_failure_reversals
       (order_id,payment_id,attempt_id,state,reason_code,evidence_snapshot,evidence_hash,
        payment_amount,payment_currency,provider_refund_identity)
     VALUES($1,$2,$3,'eligible',$4,$5,$6,$7,$8,$9)
     ON CONFLICT (order_id) DO UPDATE SET updated_at=now()
     RETURNING *`,
    [input.orderId, row.paymentId, input.attemptId, derivedReason, evidence, hash(evidence),
      row.amount, row.currency, providerRefundIdentity],
  );
  return inserted.rows[0];
}

/** Reserves payment_refund before any provider I/O. A settlement reservation
 * conflict is authoritative and is converted to manual review. */
export async function reserveSupplierFailureReversal(db: Db, reversalId: string): Promise<any> {
  const owner = (db as Pool).connect ? await (db as Pool).connect() : db;
  await owner.query("BEGIN");
  try {
    const row = (await owner.query("SELECT * FROM supplier_failure_reversals WHERE id=$1", [reversalId])).rows[0];
    if (!row) throw new Error("SUPPLIER_FAILURE_REVERSAL_NOT_FOUND");
    if (row.state === "completed") {
      await owner.query("COMMIT");
      return row;
    }
    await owner.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [row.order_id]);
    const order = (await owner.query("SELECT id,status,fulfillment_status,payment_status,total_fingerprint,grand_total,currency FROM orders WHERE id=$1 FOR UPDATE", [row.order_id])).rows[0];
    const payment = (await owner.query("SELECT id,status,amount,currency,order_total_fingerprint FROM payments WHERE id=$1 AND order_id=$2 FOR UPDATE", [row.payment_id, row.order_id])).rows[0];
    if (!order || !payment || order.status !== "confirmed" || order.fulfillment_status !== "unfulfilled" || order.payment_status !== "paid" ||
        payment.status !== "paid" || payment.order_total_fingerprint !== order.total_fingerprint ||
        String(payment.amount) !== String(order.grand_total) || payment.currency !== order.currency) {
      throw new AppError(409, "SUPPLIER_FAILURE_REVERSAL_STATE_CHANGED", "The order is no longer eligible for reversal.");
    }
    const lockedSaga = (await owner.query("SELECT * FROM supplier_failure_reversals WHERE id=$1 FOR UPDATE", [reversalId])).rows[0];
    if (!lockedSaga || lockedSaga.version !== row.version || lockedSaga.state !== "eligible") {
      throw new AppError(409, "SUPPLIER_FAILURE_REVERSAL_CAS_LOST", "The reversal worker lost ownership.");
    }
    const reservation = await acquireFinancialOperation(owner, {
      orderId: row.order_id, operationType: "payment_refund",
      operationReferenceId: reversalId,
      allowReleasedRetry: true,
    });
    const refund = await owner.query(
      `INSERT INTO refunds(order_id,payment_id,reason,idempotency_key,amount,currency,status)
       VALUES($1,$2,'supplier_failure_reversal',$3,$4,$5,'pending')
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
       RETURNING id`,
      [row.order_id, row.payment_id, row.provider_refund_identity, row.payment_amount, row.payment_currency],
    );
    const updated = await owner.query(
      `UPDATE supplier_failure_reversals
          SET state='reserved',operation_reservation_id=$2,refund_id=$3,lease_token=$4,lease_until=$5,version=version+1,updated_at=now()
        WHERE id=$1 AND state='eligible' AND version=$6 RETURNING *`,
      [reversalId, reservation.id, refund.rows[0].id, reservation.leaseToken, reservation.leaseUntil, row.version],
    );
    if (!updated.rowCount) throw new Error("SUPPLIER_FAILURE_REVERSAL_CAS_LOST");
    await owner.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    try {
      await owner.query("BEGIN");
      await owner.query(
        "UPDATE supplier_failure_reversals SET state='manual_review',last_error=$2,updated_at=now() WHERE id=$1 AND state='eligible'",
        [reversalId, String(error).slice(0, 2000)],
      );
      await owner.query("COMMIT");
    } catch {
      await owner.query("ROLLBACK").catch(() => undefined);
    }
    throw error instanceof AppError ? error : new AppError(409, "SUPPLIER_FAILURE_REVERSAL_RESERVATION_FAILED", "The supplier-failure reversal could not acquire refund authority.");
  } finally {
    if (owner !== db) (owner as any).release();
  }
}

/** Performs one provider refund, or lookup-only recovery for an ambiguous saga. */
function amountCents(value: string): number {
  const cents = Number(value) * 100;
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("SUPPLIER_FAILURE_REFUND_AMOUNT_INVALID");
  return cents;
}

export async function transmitSupplierFailureReversal(db: Db, reversalId: string, provider: PaymentProvider = getPaymentProvider()): Promise<void> {
  const owner = (db as Pool).connect ? await (db as Pool).connect() : db;
  await owner.query("BEGIN");
  let row = (await owner.query("SELECT r.*,p.provider_payment_id AS \"providerPaymentId\",f.lease_token AS \"financialLeaseToken\",f.version AS \"financialVersion\",f.id AS \"financialId\" FROM supplier_failure_reversals r JOIN payments p ON p.id=r.payment_id JOIN financial_operation_reservations f ON f.id=r.operation_reservation_id WHERE r.id=$1", [reversalId])).rows[0];
  if (!row || row.state === "completed") { await owner.query("ROLLBACK"); if (owner !== db) (owner as any).release(); return; }
  if (row.state === "ambiguous") {
    await owner.query("COMMIT"); if (owner !== db) (owner as any).release();
    const found = await provider.findRefund({ paymentId: row.providerPaymentId, localRefundId: row.refund_id });
    if (!found || found.status !== "succeeded") throw new AppError(409, "SUPPLIER_FAILURE_REFUND_REMAINS_AMBIGUOUS", "The provider refund remains ambiguous.");
    await finalizeSupplierFailureReversal(db, reversalId, {
      providerRefundId: found.id, paymentId: found.paymentId!,
      localRefundId: found.localRefundId!, amount: String(found.amountCents! / 100),
      currency: found.currency!, status: found.status,
    });
    return;
  }
  if (row.state !== "reserved") { await owner.query("ROLLBACK"); if (owner !== db) (owner as any).release(); throw new Error("SUPPLIER_FAILURE_REVERSAL_NOT_RESERVED"); }
  let marked: any;
  try {
    marked = await markFinancialOperationTransmitting(owner, {
      id: row.financialId, leaseToken: row.financialLeaseToken, version: row.financialVersion,
    });
    const saga = await owner.query("UPDATE supplier_failure_reversals SET state='transmitting',transmission_started_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND state='reserved' AND version=$2 RETURNING version", [reversalId, row.version]);
    if (!saga.rowCount) throw new AppError(409, "SUPPLIER_FAILURE_REVERSAL_CAS_LOST", "The reversal worker lost ownership.");
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    if (owner !== db) (owner as any).release();
    throw error;
  }
  await owner.query("COMMIT"); if (owner !== db) (owner as any).release();
  try {
    const refund = await provider.createRefund({
      paymentId: row.providerPaymentId,
      amountCents: amountCents(String(row.payment_amount)),
      currency: row.payment_currency,
      idempotencyKey: row.provider_refund_identity,
      localRefundId: row.refund_id,
    });
    if (refund.status !== "succeeded") throw new Error("SUPPLIER_FAILURE_REFUND_NOT_SUCCEEDED");
    await finalizeSupplierFailureReversal(db, reversalId, {
      providerRefundId: refund.id, paymentId: refund.paymentId!,
      localRefundId: refund.localRefundId!, amount: String(refund.amountCents! / 100),
      currency: refund.currency!, status: refund.status,
    });
  } catch (error) {
    const recovery = (db as Pool).connect ? await (db as Pool).connect() : db;
    try {
      await recovery.query("BEGIN");
      await recovery.query("UPDATE supplier_failure_reversals SET state='ambiguous',last_error=$2,recovery_evidence=$3,updated_at=now() WHERE id=$1 AND state='transmitting'", [reversalId, String(error).slice(0, 2000), { lookupOnly: true, identity: row.provider_refund_identity }]);
      await transitionFinancialOperation(recovery, { id: marked.id, leaseToken: row.financialLeaseToken, version: marked.version, state: "ambiguous", recoveryEvidence: { lookupOnly: true } });
      await recovery.query("COMMIT");
    } catch (recoveryError) {
      await recovery.query("ROLLBACK").catch(() => undefined);
      throw recoveryError;
    } finally {
      if (recovery !== db) (recovery as any).release();
    }
    throw error;
  }
}

export async function finalizeSupplierFailureReversal(db: Db, reversalId: string, facts: RefundFacts): Promise<void> {
  const owner = (db as Pool).connect ? await (db as Pool).connect() : db;
  await owner.query("BEGIN");
  try {
    const identity = (await owner.query("SELECT order_id AS \"orderId\" FROM supplier_failure_reversals WHERE id=$1", [reversalId])).rows[0];
    if (!identity) throw new AppError(404, "SUPPLIER_FAILURE_REVERSAL_NOT_FOUND", "The reversal was not found.");
    await owner.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [identity.orderId]);
    await owner.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [identity.orderId]);
    await owner.query("SELECT id FROM payments WHERE order_id=$1 ORDER BY id FOR UPDATE", [identity.orderId]);
    await owner.query("SELECT id FROM toonies_procurement_attempts WHERE order_id=$1 ORDER BY generation FOR UPDATE", [identity.orderId]);
    await owner.query("SELECT id FROM toonies_settlements WHERE order_id=$1 ORDER BY generation FOR UPDATE", [identity.orderId]);
    const row = (await owner.query(`SELECT r.*,f.lease_token AS "financialLeaseToken",f.version AS "financialVersion",f.state AS "financialState"
      FROM supplier_failure_reversals r JOIN financial_operation_reservations f ON f.id=r.operation_reservation_id
      WHERE r.id=$1 FOR UPDATE OF r,f`, [reversalId])).rows[0];
    if (!row || row.state === "completed") { await owner.query("COMMIT"); if (owner !== db) (owner as any).release(); return; }
    if (!["transmitting", "ambiguous"].includes(row.state) || !["active", "ambiguous"].includes(row.financialState)) {
      throw new AppError(409, "SUPPLIER_FAILURE_REVERSAL_NOT_TRANSMITTING", "Only a transmitting or ambiguous reversal may be finalized.");
    }
    const current = (await owner.query(`SELECT p.provider_payment_id AS "providerPaymentId",p.status AS "paymentStatus",o.status AS "orderStatus",o.fulfillment_status AS "fulfillmentStatus",o.payment_status AS "orderPaymentStatus"
      FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=$1 FOR UPDATE`, [row.payment_id])).rows[0];
    if (!current || current.paymentStatus !== "paid" || current.orderStatus !== "confirmed" || current.fulfillmentStatus !== "unfulfilled" || current.orderPaymentStatus !== "paid") {
      throw new AppError(409, "SUPPLIER_FAILURE_REVERSAL_STATE_CHANGED", "The order is no longer eligible for reversal.");
    }
    assertRefundFacts(facts, { ...row, providerPaymentId: current.providerPaymentId });
    await transitionFinancialOperation(owner, { id: row.operation_reservation_id, leaseToken: row.financialLeaseToken, version: row.financialVersion, state: "completed", recoveryEvidence: { providerReference: facts.providerRefundId, facts } });
    await owner.query(`INSERT INTO refunds(order_id,payment_id,provider_reference,reason,idempotency_key,amount,currency,status)
      VALUES($1,$2,$3,'supplier_failure_reversal',$4,$5,$6,'completed')
      ON CONFLICT (idempotency_key) DO UPDATE SET status='completed',provider_reference=COALESCE(refunds.provider_reference,EXCLUDED.provider_reference)`,
      [row.order_id, row.payment_id, facts.providerRefundId, row.provider_refund_identity, row.payment_amount, row.payment_currency]);
    await owner.query("UPDATE payments SET status='refunded',updated_at=now() WHERE id=$1 AND status<>'refunded'", [row.payment_id]);
    const converted = (await owner.query(`SELECT ir.inventory_id AS "inventoryId",ir.quantity,i.warehouse_id AS "warehouseId",i.product_id AS "productId",i.variant_id AS "variantId"
      FROM inventory_reservations ir JOIN inventory i ON i.id=ir.inventory_id
      WHERE ir.order_id=$1 AND ir.status='converted' FOR UPDATE OF ir,i`, [row.order_id])).rows;
    for (const reservation of converted) {
      await owner.query("UPDATE inventory SET quantity_on_hand=quantity_on_hand+$1,updated_at=now() WHERE id=$2", [reservation.quantity, reservation.inventoryId]);
      await owner.query(`INSERT INTO inventory_movements(warehouse_id,product_id,variant_id,movement_type,quantity,reference_type,reference_id,note)
        VALUES($1,$2,$3,'return',$4,'supplier_failure_reversal',$5,'Supplier failure refund')`,
        [reservation.warehouseId, reservation.productId, reservation.variantId, reservation.quantity, row.order_id]);
    }
    await owner.query("UPDATE inventory_reservations SET status='released',released_at=COALESCE(released_at,now()) WHERE order_id=$1 AND status IN ('active','converted')", [row.order_id]);
    await owner.query(`WITH released AS (DELETE FROM promotion_usages WHERE order_id=$1 RETURNING campaign_id)
      UPDATE promotion_campaigns c SET usage_count=GREATEST(usage_count-1,0),updated_at=now() WHERE c.id IN (SELECT campaign_id FROM released)`, [row.order_id]);
    await owner.query(`INSERT INTO audit_logs(action,entity_type,entity_id,new_values_json)
      VALUES('supplier_failure_reversal.completed','order',$1,$2)`, [row.order_id, { reversalId, providerReference: facts.providerRefundId, evidenceHash: row.evidence_hash }]);
    const cancelled = await owner.query("UPDATE orders SET status='cancelled',payment_status='refunded',fulfillment_status='cancelled',fulfillment_stage='cancelled',updated_at=now() WHERE id=$1 AND status='confirmed' AND fulfillment_status='unfulfilled' AND payment_status='paid'", [row.order_id]);
    if (cancelled.rowCount !== 1) throw new AppError(409, "SUPPLIER_FAILURE_REVERSAL_STATE_CHANGED", "The order changed while refund finalization was in progress.");
    await owner.query("UPDATE supplier_failure_reversals SET state='completed',provider_refund_reference=$2,completed_at=COALESCE(completed_at,now()),version=version+1,updated_at=now() WHERE id=$1 AND state IN ('transmitting','ambiguous')", [reversalId, facts.providerRefundId]);
    const recipient = (await owner.query("SELECT user_id AS \"userId\",company_id AS \"companyId\",guest_email AS email FROM orders WHERE id=$1", [row.order_id])).rows[0];
    if (recipient?.userId || recipient?.companyId || recipient?.email) {
      await emitNotification({ type: "order.cancelled", idempotencyKey: `supplier-failure-reversal:${reversalId}:notification`, userId: recipient.userId ?? undefined, companyId: recipient.companyId ?? undefined, email: recipient.email ?? undefined, message: "Your order was refunded because the supplier could not fulfil it.", metadata: { reversalId } }, owner);
    }
    await owner.query("COMMIT"); if (owner !== db) (owner as any).release();
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    if (owner !== db) (owner as any).release();
    throw error;
  }
}

/** Reclaims only work which is provably pre-transmission. Any transmission
 * timestamp or transmitting/ambiguous state is deliberately left untouched. */
export async function reclaimExpiredSupplierFailureReversal(db: Db, reversalId: string): Promise<boolean> {
  const owner = (db as Pool).connect ? await (db as Pool).connect() : db;
  try {
    await owner.query("BEGIN");
    const row = (await owner.query(`SELECT r.*,f.state AS "financialState",f.phase AS "financialPhase",f.lease_token AS "financialToken",f.version AS "financialVersion"
      FROM supplier_failure_reversals r JOIN financial_operation_reservations f ON f.id=r.operation_reservation_id
      WHERE r.id=$1 FOR UPDATE OF r,f`, [reversalId])).rows[0];
    if (!row || row.state !== "reserved" || row.transmission_started_at || row.lease_until === null || new Date(row.lease_until).getTime() >= Date.now() ||
        row.financialState !== "active" || row.financialPhase !== "reserved" || row.financialToken !== row.lease_token || row.financialVersion !== row.version - 1) {
      await owner.query("ROLLBACK"); return false;
    }
    const released = await owner.query(`UPDATE financial_operation_reservations
      SET state='released',phase='terminal',lease_token=NULL,lease_until=NULL,completed_at=COALESCE(completed_at,now()),version=version+1,updated_at=now()
      WHERE id=$1 AND state='active' AND phase='reserved' AND lease_token=$2 AND version=$3 AND transmission_started_at IS NULL`, [row.operation_reservation_id, row.financialToken, row.financialVersion]);
    if (released.rowCount !== 1) { await owner.query("ROLLBACK"); return false; }
    const changed = await owner.query(`UPDATE supplier_failure_reversals SET state='eligible',operation_reservation_id=NULL,refund_id=NULL,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now()
      WHERE id=$1 AND state='reserved' AND version=$2 AND transmission_started_at IS NULL`, [reversalId, row.version]);
    if (changed.rowCount !== 1) { await owner.query("ROLLBACK"); return false; }
    await owner.query("DELETE FROM refunds WHERE id=$1 AND idempotency_key=$2 AND status='pending'", [row.refund_id, row.provider_refund_identity]);
    await owner.query("COMMIT");
    return true;
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (owner !== db) (owner as any).release();
  }
}