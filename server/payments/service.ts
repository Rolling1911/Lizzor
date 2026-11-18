import { createHash } from "node:crypto";
import { getDatabasePool } from "../db/client.js";
import { databaseConfigured, env } from "../config/env.js";
import { AppError } from "../middleware/error-handler.js";
import { getOrder, type Access } from "../orders/service.js";
import { getPaymentProvider, mapProviderEventStatus, type ProviderPaymentStatus } from "./provider.js";
import { logger } from "../lib/logger.js";
import { emitAdminNotification, emitNotification } from "../notifications/service.js";
import { releasePromotionUsages } from "../promotions/service.js";
import { assertMerchandisePriceFloor } from "../pricing/floor.js";
import { calculatePayableTotals, payableTotalFingerprint, type TaxMode } from "../commerce/payable-total.js";
import { loadTooniesSupplierSnapshotFingerprint } from "../suppliers/toonies-snapshot.js";
import { assertTooniesOrderPaymentEnabled } from "../suppliers/toonies-procurement-gate.js";
import { assertTooniesSettlementMutationAllowed } from "../suppliers/toonies-settlement-service.js";
import { acquireFinancialOperation, markFinancialOperationTransmitting, transitionFinancialOperation, pauseAfterFinancialOperationReservation } from "../financial/operation-reservation.js";

async function assertOrderTotalIntegrity(client: any, orderId: string): Promise<void> {
  const order = (await client.query(
    `SELECT id,currency,shipping_total AS "shippingTotal",tax_total AS "taxTotal",grand_total AS "grandTotal",
            total_fingerprint AS "totalFingerprint"
       FROM orders WHERE id=$1 FOR SHARE`,
    [orderId],
  )).rows[0];
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
  // Orders created before the tax-integrity migration retain their existing
  // amount checks; new orders always carry a complete canonical fingerprint.
  if (!order.totalFingerprint) return;
  const lines = (await client.query(
    `SELECT product_id AS "productId",variant_id AS "variantId",quantity,line_total AS "lineTotal",
            tax_rate_snapshot AS "vatRate",tax_mode_snapshot AS "taxMode",
            vat_classified_at_snapshot AS "vatClassifiedAt"
       FROM order_items WHERE order_id=$1 ORDER BY product_id,variant_id NULLS FIRST`,
    [orderId],
  )).rows;
  const payableLines = lines.map((line: any) => ({
    key: `${line.productId}:${line.variantId ?? "product"}`,
    productId: line.productId,
    variantId: line.variantId,
    quantity: Number(line.quantity),
    merchandiseCents: cents(line.lineTotal),
    vatRate: line.vatRate,
    taxMode: line.taxMode as TaxMode,
    vatClassifiedAt: line.vatClassifiedAt,
  }));
  const totals = calculatePayableTotals({ lines: payableLines, shippingCents: cents(order.shippingTotal) });
  const fingerprint = payableTotalFingerprint({
    currency: order.currency,
    lines: payableLines,
    shippingCents: cents(order.shippingTotal),
    payableTotalCents: totals.payableTotalCents,
  });
  if (
    totals.taxCents !== cents(order.taxTotal)
    || totals.payableTotalCents !== cents(order.grandTotal)
    || fingerprint !== order.totalFingerprint
  ) throw new AppError(409, "ORDER_TOTAL_INTEGRITY_FAILED", "The stored order totals no longer match their authoritative snapshots.");
}

async function assertOrderMerchandisePayable(client: any, orderId: string): Promise<void> {
  await assertOrderTotalIntegrity(client, orderId);
  await client.query("SELECT p.id FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 FOR SHARE OF p", [orderId]);
  await client.query("SELECT pv.id FROM order_items oi JOIN product_variants pv ON pv.id=oi.variant_id WHERE oi.order_id=$1 FOR SHARE OF pv", [orderId]);
  await client.query("SELECT l.id FROM order_items oi JOIN supplier_product_links l ON l.product_id=oi.product_id AND l.variant_id IS NOT DISTINCT FROM oi.variant_id WHERE oi.order_id=$1 FOR SHARE OF l", [orderId]);
  const rows = (await client.query(`SELECT oi.product_id AS "productId",oi.variant_id AS "variantId",oi.product_name_snapshot AS "productName",oi.quantity,oi.line_total AS "lineTotal",
    p.status AS "productStatus",p.published_at AS "publishedAt",p.cost_price AS "productCost",
    p.vat_rate AS "currentVatRate",p.tax_mode AS "currentTaxMode",p.vat_classified_at AS "currentVatClassifiedAt",
    oi.tax_rate_snapshot AS "vatRateSnapshot",oi.tax_mode_snapshot AS "taxModeSnapshot",
    oi.vat_classified_at_snapshot AS "vatClassifiedAtSnapshot",o.total_fingerprint AS "totalFingerprint",
    pv.active AS "variantActive",pv.cost_price AS "variantCost",s.id AS "supplierId",
    COALESCE(scv.manual_cost_override_eur,scv.normalized_eur,sci.manual_cost_override_eur,sci.normalized_eur) AS "authoritativeCost",
    EXISTS(SELECT 1 FROM supplier_price_change_reviews r WHERE r.supplier_id=s.id AND r.product_id=oi.product_id AND r.variant_id IS NOT DISTINCT FROM oi.variant_id AND r.status IN ('pending','rejected')) AS "held"
    FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id LEFT JOIN product_variants pv ON pv.id=oi.variant_id
    LEFT JOIN supplier_product_links l ON l.product_id=oi.product_id AND l.variant_id IS NOT DISTINCT FROM oi.variant_id
    LEFT JOIN supplier_catalogue_items sci ON sci.id=l.catalogue_item_id
    LEFT JOIN supplier_catalogue_variants scv ON scv.id=l.catalogue_variant_id
    LEFT JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies' WHERE oi.order_id=$1`, [orderId])).rows;
  for (const row of rows) {
    if (row.productStatus !== "active" || !row.publishedAt || (row.variantId && row.variantActive !== true)) throw new AppError(409, "ORDER_MERCHANDISE_UNAVAILABLE", `${row.productName} is no longer available for payment.`);
    const timestamp = (value: unknown) => value ? new Date(value as string | Date).toISOString() : null;
    if (row.totalFingerprint && (
      Number(row.currentVatRate) !== Number(row.vatRateSnapshot)
      || row.currentTaxMode !== row.taxModeSnapshot
      || timestamp(row.currentVatClassifiedAt) !== timestamp(row.vatClassifiedAtSnapshot)
    )) throw new AppError(409, "PAYMENT_VAT_STATE_STALE", `${row.productName} tax details changed after checkout. Review the cart and create a new order.`);
    if (row.supplierId) {
      if (row.held) throw new AppError(409, "SUPPLIER_PRICE_REVIEW_REQUIRED", `${row.productName} is offline while a supplier price change is reviewed.`);
      if (!row.currentVatClassifiedAt) throw new AppError(409, "TOONIES_VAT_CLASSIFICATION_REQUIRED", `${row.productName} requires explicit VAT classification before payment.`);
    }
    assertMerchandisePriceFloor({ unitCost: Number(row.authoritativeCost ?? row.variantCost ?? row.productCost), quantity: Number(row.quantity), merchandiseRevenue: Number(row.lineTotal), code: "ORDER_BELOW_CURRENT_COST", message: `${row.productName} is below its current merchandise cost and cannot be paid.` });
  }
}

async function notifyPaymentEvent(paymentId: string, type: "payment.succeeded" | "payment.failed", database: any = getDatabasePool()) {
  const row = (await database.query(`SELECT p.id,p.order_id AS "orderId",o.order_number AS "orderNumber",o.user_id AS "userId",o.guest_email AS email
    FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=$1`, [paymentId])).rows[0];
  if (!row) return;
  await emitNotification({ type, idempotencyKey: `${type}:${paymentId}`, userId: row.userId ?? undefined, email: row.email ?? undefined,
    message: type === "payment.succeeded" ? `Payment for order ${row.orderNumber} was received.` : `Payment for order ${row.orderNumber} was not completed.`,
    metadata: { paymentId, orderId: row.orderId, orderNumber: row.orderNumber, path: `/account/orders/${row.orderId}` },
  }, database);
  if (type === "payment.failed") await emitAdminNotification("payments.view", {
    type: "admin.payment_failed", idempotencyKey: `admin.payment_failed:${paymentId}`,
    message: `Payment for order ${row.orderNumber} failed and may require review.`,
    metadata: { paymentId, orderId: row.orderId, orderNumber: row.orderNumber, path: `/admin/orders/${row.orderId}` },
  }, database);
}
async function notifyRefundEvent(refundId: string, status: string, database: any = getDatabasePool()) {
  const row = (await database.query(`SELECT r.id,r.order_id AS "orderId",o.order_number AS "orderNumber",o.user_id AS "userId",o.guest_email AS email
    FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.id=$1`, [refundId])).rows[0];
  if (!row) return;
  const type = status === "completed" ? "refund.completed" as const : "refund.updated" as const;
  await emitNotification({ type, idempotencyKey: `${type}:${refundId}:${status}`, userId: row.userId ?? undefined, email: row.email ?? undefined,
    message: status === "completed" ? `Your refund for order ${row.orderNumber} was completed.` : `Your refund for order ${row.orderNumber} is now ${status}.`,
    metadata: { refundId, orderId: row.orderId, orderNumber: row.orderNumber, path: `/account/orders/${row.orderId}` },
  }, database);
}

function cents(value: unknown): number {
  const text = String(value ?? "0");
  const match = text.match(/^-?\d+(?:\.(\d{1,2}))?$/);
  if (!match) throw new AppError(500, "INVALID_MONEY", "A stored monetary value is invalid.");
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

function hashKey(key: string): string {
  if (!key || key.length < 8 || key.length > 160) throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "A valid payment idempotency key is required.");
  return createHash("sha256").update(key).digest("hex");
}

function serializePayment(row: any) {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    provider: row.provider,
    providerPaymentId: row.providerPaymentId,
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    paymentMethodType: row.paymentMethodType,
    failureReason: row.failureReason,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function paymentById(client: any, paymentId: string) {
  const result = await client.query(
    `SELECT p.id, p.order_id AS "orderId", o.order_number AS "orderNumber", p.provider, p.provider_payment_id AS "providerPaymentId",
            p.status, p.amount, p.currency, p.payment_method_type AS "paymentMethodType", p.failure_reason AS "failureReason",
            p.paid_at AS "paidAt", p.created_at AS "createdAt", p.updated_at AS "updatedAt"
       FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1`,
    [paymentId],
  );
  return result.rows[0];
}

type RecoveryOperation = "webhook" | "payment_creation" | "payment_status" | "expiration" | "refund" | "payment_invalidation";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The payment operation failed.";
}

function retryDelay(attempts: number): number {
  return Math.min(60, Math.max(1, 2 ** Math.min(attempts, 5)));
}

async function enqueueRecoveryJob(input: {
  operation: RecoveryOperation;
  orderId?: string;
  paymentId?: string;
  refundId?: string;
  providerEventId?: string;
  eventType?: string;
  payload?: Record<string, any>;
  retryable?: boolean;
  reason: string;
}) {
  const pool = getDatabasePool();
  if (input.providerEventId) {
    await pool.query(
      `INSERT INTO payment_recovery_jobs
         (order_id,payment_id,refund_id,provider_event_id,event_type,operation,payload_json,retryable,status,last_error,next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8 THEN 'pending' ELSE 'failed' END,$9,now())
       ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL
       DO UPDATE SET
         status=CASE WHEN payment_recovery_jobs.status='processing' THEN 'processing' WHEN EXCLUDED.retryable THEN 'pending' ELSE 'failed' END,
         retryable=EXCLUDED.retryable,
         last_error=EXCLUDED.last_error,
         next_attempt_at=CASE WHEN payment_recovery_jobs.status='processing' THEN payment_recovery_jobs.next_attempt_at ELSE now() END,
         locked_at=CASE WHEN payment_recovery_jobs.status='processing' THEN payment_recovery_jobs.locked_at ELSE NULL END,
         lock_token=CASE WHEN payment_recovery_jobs.status='processing' THEN payment_recovery_jobs.lock_token ELSE NULL END,
         updated_at=now()`,
       [input.orderId ?? null, input.paymentId ?? null, input.refundId ?? null, input.providerEventId, input.eventType ?? null, input.operation, input.payload ?? null, input.retryable ?? true, input.reason.slice(0, 2000)],
    );
    return;
  }
  await pool.query(
    `INSERT INTO payment_recovery_jobs
       (order_id,payment_id,refund_id,operation,retryable,status,last_error,next_attempt_at)
     SELECT $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::boolean,
            CASE WHEN $5::boolean THEN 'pending' ELSE 'failed' END,$6::text,now()
      WHERE NOT EXISTS (
        SELECT 1 FROM payment_recovery_jobs
         WHERE operation=$4::varchar
           AND payment_id IS NOT DISTINCT FROM $2::uuid
           AND refund_id IS NOT DISTINCT FROM $3::uuid
           AND (status IN ('pending','processing') OR retryable=false)
      )
     ON CONFLICT DO NOTHING`,
    [input.orderId ?? null, input.paymentId ?? null, input.refundId ?? null, input.operation, input.retryable ?? true, input.reason.slice(0, 2000)],
  );
}

async function completeRecoveryJob(providerEventId: string) {
  await getDatabasePool().query(
    `UPDATE payment_recovery_jobs
        SET status='succeeded',completed_at=COALESCE(completed_at,now()),locked_at=NULL,lock_token=NULL,updated_at=now()
      WHERE provider_event_id=$1 AND status NOT IN ('succeeded','processing')`,
    [providerEventId],
  );
}

function shouldRetryWebhook(error: unknown): boolean {
  if (!(error instanceof AppError)) return true;
  return ![
    "PAYMENT_PROVIDER_FACTS_MISMATCH",
    "REFUND_PROVIDER_FACTS_MISMATCH",
    "PAYMENT_NOT_FOUND",
    "INVALID_PAYMENT_EVENT",
  ].includes(error.code);
}

async function recordWebhookFailure(input: {
  orderId: string;
  paymentId: string;
  providerEventId: string;
  eventType: string;
  payload: Record<string, any>;
}, error: unknown) {
  try {
    const retryable = shouldRetryWebhook(error);
    await enqueueRecoveryJob({ ...input, operation: "webhook", retryable, reason: errorMessage(error) });
    logger.warn(retryable ? "payment webhook queued for recovery" : "payment webhook retained for operator review", {
      eventId: input.providerEventId,
      paymentId: input.paymentId,
      error: errorMessage(error),
    });
  } catch (queueError) {
    logger.error("payment webhook failure could not be recorded", {
      eventId: input.providerEventId,
      paymentId: input.paymentId,
      error: errorMessage(queueError),
    });
  }
}

async function claimRecoveryJobs(limit: number) {
  const pool = getDatabasePool();
  await pool.query(
    `UPDATE payment_recovery_jobs
        SET status='failed',retryable=(attempts < $1),last_error=COALESCE(last_error,'Worker lease expired'),next_attempt_at=now(),locked_at=NULL,lock_token=NULL,updated_at=now()
      WHERE status='processing' AND locked_at < now() - interval '15 minutes'`,
    [env.PAYMENT_RECOVERY_MAX_RETRIES],
  );
  const result = await pool.query(
    `WITH candidates AS (
       SELECT id
         FROM payment_recovery_jobs
         WHERE retryable=true AND attempts < $2 AND status IN ('pending','failed') AND next_attempt_at <= now()
        ORDER BY next_attempt_at,created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE payment_recovery_jobs j
        SET status='processing',attempts=j.attempts+1,last_attempt_at=now(),locked_at=now(),lock_token=gen_random_uuid(),updated_at=now()
       FROM candidates
      WHERE j.id=candidates.id
      RETURNING j.id,j.operation,j.order_id AS "orderId",j.payment_id AS "paymentId",j.refund_id AS "refundId",
                j.provider_event_id AS "providerEventId",j.event_type AS "eventType",j.payload_json AS "payload",
                j.attempts,j.lock_token AS "lockToken"`,
    [Math.min(500, Math.max(1, limit)), env.PAYMENT_RECOVERY_MAX_RETRIES],
  );
  return result.rows;
}

async function failRecoveryJob(jobId: string, lockToken: string, attempts: number, error: unknown) {
  const reason = errorMessage(error).slice(0, 2000);
  const maintenance = error instanceof AppError && error.code === "TOONIES_PROCUREMENT_MAINTENANCE";
  const retryable = maintenance || (attempts < env.PAYMENT_RECOVERY_MAX_RETRIES
    && !(error instanceof AppError && ["REFUND_RECOVERY_REQUIRES_REVIEW", "REFUND_PROVIDER_FACTS_MISMATCH", "PAYMENT_PROVIDER_FACTS_MISMATCH", "PAYMENT_EXPIRATION_REQUIRES_REVIEW"].includes(error.code)));
  const result = await getDatabasePool().query(
    `UPDATE payment_recovery_jobs
        SET status='failed',retryable=$3,last_error=$4,next_attempt_at=now() + ($5 || ' minutes')::interval,
            attempts=CASE WHEN $6 THEN GREATEST(attempts-1,0) ELSE attempts END,
            locked_at=NULL,lock_token=NULL,updated_at=now()
      WHERE id=$1 AND lock_token=$2`,
    [jobId, lockToken, retryable, reason, retryDelay(attempts), maintenance],
  );
  if (result.rowCount) logger.warn("payment recovery job failed", { jobId, attempts, error: reason });
  return Boolean(result.rowCount);
}

async function recordRecoveryAttempt(input: {
  paymentId: string;
  source: string;
  status: "succeeded" | "failed" | "skipped";
  attemptNumber: number;
  failureReason?: string;
  jobId?: string;
}) {
  await getDatabasePool().query(
    `WITH attempt AS (
       INSERT INTO payment_recovery_attempts (payment_id,source,status,attempt_number,failure_reason,details_json)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
     )
     INSERT INTO audit_logs (action,entity_type,entity_id,new_values_json)
     SELECT 'payment.recovery_attempted','payment',$1,$7 FROM attempt`,
    [
      input.paymentId,
      input.source.slice(0, 40),
      input.status,
      Math.max(1, input.attemptNumber),
      input.failureReason?.slice(0, 2000) ?? null,
      JSON.stringify(input.jobId ? { jobId: input.jobId } : {}),
      JSON.stringify({ source: input.source, status: input.status, attemptNumber: Math.max(1, input.attemptNumber), jobId: input.jobId, failureReason: input.failureReason?.slice(0, 500) }),
    ],
  );
}

function assertProviderSuccessFacts(
  outcome: { id: string; amountCents?: number; currency?: string; orderId?: string },
  payment: { providerPaymentId?: string | null; amount: unknown; currency: string; orderId: string },
) {
  if (
    (payment.providerPaymentId && outcome.id !== payment.providerPaymentId)
    || outcome.amountCents !== cents(payment.amount)
    || outcome.currency !== payment.currency
    || outcome.orderId !== payment.orderId
  ) throw new AppError(409, "PAYMENT_PROVIDER_FACTS_MISMATCH", "The provider payment facts do not match the locked order.");
}

async function releaseReservations(client: any, orderId: string): Promise<number> {
  const reservations = (await client.query(
    `SELECT ir.id, ir.inventory_id AS "inventoryId", ir.quantity
       FROM inventory_reservations ir WHERE ir.order_id = $1 AND ir.status = 'active' FOR UPDATE`,
    [orderId],
  )).rows;
  for (const reservation of reservations) {
    const updated = await client.query(
      `UPDATE inventory SET quantity_reserved = quantity_reserved - $1, updated_at = now()
        WHERE id = $2 AND quantity_reserved >= $1`,
      [reservation.quantity, reservation.inventoryId],
    );
    if (!updated.rowCount) throw new AppError(409, "RESERVATION_RELEASE_FAILED", "The inventory reservation could not be released safely.");
  }
  await client.query("UPDATE inventory_reservations SET status = 'released', released_at = now() WHERE order_id = $1 AND status = 'active'", [orderId]);
  return reservations.length;
}

async function finalizeSuccess(paymentId: string, source: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const payment = (await client.query(
      `SELECT p.id, p.order_id AS "orderId", p.status, p.amount, p.currency, p.order_total_fingerprint AS "orderTotalFingerprint",
              o.status AS "orderStatus", o.payment_status AS "orderPaymentStatus", o.grand_total AS "grandTotal",
              o.total_fingerprint AS "currentOrderTotalFingerprint"
         FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1 FOR UPDATE`,
      [paymentId],
    )).rows[0];
    if (!payment) throw new AppError(404, "PAYMENT_NOT_FOUND", "The payment was not found.");
    if (cents(payment.amount) !== cents(payment.grandTotal) || payment.currency !== "EUR") throw new AppError(409, "PAYMENT_AMOUNT_MISMATCH", "The payment amount does not match the locked order total.");
    if (payment.currentOrderTotalFingerprint && payment.orderTotalFingerprint !== payment.currentOrderTotalFingerprint) {
      throw new AppError(409, "PAYMENT_TOTAL_STALE", "The payment no longer matches the authoritative order total.");
    }
    if (payment.status === "paid" && payment.orderPaymentStatus === "paid") {
      await client.query("COMMIT");
      return serializePayment(await paymentById(getDatabasePool(), paymentId));
    }
    const tooniesProcurementRequired = await assertTooniesOrderPaymentEnabled(client, payment.orderId);
    if (payment.orderStatus === "cancelled") throw new AppError(409, "ORDER_CANCELLED", "A cancelled order cannot be paid.");
    await assertOrderMerchandisePayable(client, payment.orderId);
    const reservations = (await client.query(
      `SELECT ir.id, ir.inventory_id AS "inventoryId", ir.quantity, i.warehouse_id AS "warehouseId", i.product_id AS "productId", i.variant_id AS "variantId",
              i.quantity_on_hand AS "onHand", i.quantity_reserved AS reserved
         FROM inventory_reservations ir JOIN inventory i ON i.id = ir.inventory_id
        WHERE ir.order_id = $1 AND ir.status = 'active' FOR UPDATE OF ir, i`,
      [payment.orderId],
    )).rows;
    for (const reservation of reservations) {
      if (Number(reservation.onHand) < Number(reservation.quantity) || Number(reservation.reserved) < Number(reservation.quantity)) throw new AppError(409, "RESERVATION_STOCK_CONFLICT", "Reserved stock is no longer available to finalize this order.");
      await client.query("UPDATE inventory SET quantity_on_hand = quantity_on_hand - $1, quantity_reserved = quantity_reserved - $1, updated_at = now() WHERE id = $2", [reservation.quantity, reservation.inventoryId]);
      await client.query(
        `INSERT INTO inventory_movements (warehouse_id, product_id, variant_id, movement_type, quantity, reference_type, reference_id, note)
         VALUES ($1, $2, $3, 'sale', $4, 'order', $5, $6)`,
        [reservation.warehouseId, reservation.productId, reservation.variantId, -Number(reservation.quantity), payment.orderId, `Payment ${source}`],
      );
    }
    await client.query("UPDATE inventory_reservations SET status = 'converted', released_at = NULL WHERE order_id = $1 AND status = 'active'", [payment.orderId]);
    await client.query("UPDATE payments SET status = 'paid', paid_at = COALESCE(paid_at, now()), failure_reason = NULL, updated_at = now() WHERE id = $1", [paymentId]);
    await client.query("UPDATE orders SET payment_status = 'paid', status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END, reservation_expires_at = NULL, updated_at = now() WHERE id = $1", [payment.orderId]);
    await client.query("INSERT INTO audit_logs (action, entity_type, entity_id, new_values_json) VALUES ('payment.succeeded','payment',$1,$2)", [paymentId, JSON.stringify({ orderId: payment.orderId, inventoryFinalized: reservations.length, source })]);
    // Durable hand-off: supplier I/O is performed by the background worker only
    // after this authoritative payment transaction has committed.
    const supplierFingerprint = await loadTooniesSupplierSnapshotFingerprint(client, payment.orderId);
    if (tooniesProcurementRequired && !supplierFingerprint) {
      throw new AppError(409, "TOONIES_SUPPLIER_SNAPSHOT_REQUIRED", "The paid order cannot be finalized without its immutable supplier snapshot.");
    }
    if (supplierFingerprint) await client.query(
      "INSERT INTO toonies_procurement_commands(order_id,order_total_fingerprint,supplier_snapshot_fingerprint) SELECT $1,total_fingerprint,$2 FROM orders WHERE id=$1 ON CONFLICT (order_id) DO NOTHING",
      [payment.orderId, supplierFingerprint],
    );
    await notifyPaymentEvent(paymentId, "payment.succeeded", client);
    await client.query("COMMIT");
    const finalized = serializePayment(await paymentById(getDatabasePool(), paymentId));
    return finalized;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function failPayment(paymentId: string, status: "failed" | "cancelled", reason: string, cancelOrder = false, suppliedReservation?: any) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const paymentOwner = (await client.query("SELECT order_id AS \"orderId\" FROM payments WHERE id=$1", [paymentId])).rows[0];
    if (!paymentOwner) throw new AppError(404, "PAYMENT_NOT_FOUND", "The payment was not found.");
    await assertTooniesSettlementMutationAllowed(client, paymentOwner.orderId);
    const payment = (await client.query("SELECT p.id, p.order_id AS \"orderId\", p.status, o.status AS \"orderStatus\" FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=$1 FOR UPDATE", [paymentId])).rows[0];
    if (!payment) throw new AppError(404, "PAYMENT_NOT_FOUND", "The payment was not found.");
    const cancellationReservation = suppliedReservation ?? await acquireFinancialOperation(client, {
      orderId: payment.orderId,
      operationType: "payment_cancellation",
      operationReferenceId: paymentId,
      leaseSeconds: 120,
    });
    if (payment.status === "paid" || payment.status === "refunded" || payment.status === "partially_refunded") {
      await client.query("COMMIT");
      return serializePayment(await paymentById(getDatabasePool(), paymentId));
    }
    await client.query("UPDATE payments SET status=$1::payment_status, failure_reason=$2, updated_at=now() WHERE id=$3", [status, reason.slice(0, 1000), paymentId]);
    const released = cancelOrder ? await releaseReservations(client, payment.orderId) : 0;
    const promotionsReleased = cancelOrder ? await releasePromotionUsages(client, payment.orderId) : 0;
    if (cancelOrder) {
      await client.query("UPDATE orders SET status='cancelled', payment_status=$1::payment_status, fulfillment_status='cancelled', reservation_expires_at=NULL, updated_at=now() WHERE id=$2 AND status <> 'cancelled'", [status, payment.orderId]);
    } else {
      await client.query("UPDATE orders SET payment_status='pending', updated_at=now() WHERE id=$1 AND status='pending'", [payment.orderId]);
    }
    await client.query("INSERT INTO audit_logs (action,entity_type,entity_id,new_values_json) VALUES ('payment.failed','payment',$1,$2)", [paymentId, JSON.stringify({ orderId: payment.orderId, orderCancelled: cancelOrder, reservationsReleased: released, promotionsReleased, reason })]);
    await notifyPaymentEvent(paymentId, "payment.failed", client);
    await transitionFinancialOperation(client, {
      id: cancellationReservation.id,
      leaseToken: cancellationReservation.leaseToken,
      version: cancellationReservation.version,
      state: "released",
      recoveryEvidence: { paymentId, status },
    });
    await client.query("COMMIT");
    const failed = serializePayment(await paymentById(getDatabasePool(), paymentId));
    return failed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function transition(paymentId: string, status: ProviderPaymentStatus, reason = "Payment provider reported a failure.") {
  if (status === "succeeded") return finalizeSuccess(paymentId, "provider");
  if (status === "cancelled") return failPayment(paymentId, "cancelled", reason);
  const result = await getDatabasePool().query(
    `UPDATE payments SET status=$1::payment_status, failure_reason=$3, updated_at=now() WHERE id=$2 AND status NOT IN ('paid','refunded','partially_refunded','cancelled') RETURNING id`,
    [status, paymentId, status === "failed" ? reason.slice(0, 1000) : null],
  );
  return result.rowCount ? serializePayment(await paymentById(getDatabasePool(), paymentId)) : serializePayment(await paymentById(getDatabasePool(), paymentId));
}

export async function createPayment(orderId: string, access: Access, idempotencyKey: string) {
  await getOrder(orderId, access);
  const keyHash = hashKey(idempotencyKey);
  const provider = getPaymentProvider();
  if (!provider.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online payments are not configured yet.");
  const client = await getDatabasePool().connect();
  let paymentId = "";
  let providerKey = keyHash;
  let existingProviderPaymentId = "";
  let replayed = false;
  try {
    await client.query("BEGIN");
    const order = (await client.query("SELECT id, status, payment_status AS \"paymentStatus\", grand_total AS \"grandTotal\", currency, total_fingerprint AS \"totalFingerprint\" FROM orders WHERE id=$1 FOR UPDATE", [orderId])).rows[0];
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
    await assertTooniesOrderPaymentEnabled(client, orderId);
    if (order.status === "pending" && order.paymentStatus === "pending") await assertOrderMerchandisePayable(client, orderId);
    const existing = (await client.query("SELECT id,order_id AS \"orderId\",provider_payment_id AS \"providerPaymentId\",idempotency_key AS \"idempotencyKey\",amount,currency,order_total_fingerprint AS \"orderTotalFingerprint\" FROM payments WHERE idempotency_key=$1", [keyHash])).rows[0];
    if (existing) {
      if (
        existing.orderId !== orderId
        || cents(existing.amount) !== cents(order.grandTotal)
        || existing.currency !== order.currency
        || (order.totalFingerprint && existing.orderTotalFingerprint !== order.totalFingerprint)
      ) throw new AppError(409, "PAYMENT_IDEMPOTENCY_KEY_REUSED", "This payment idempotency key was already used for different authoritative totals.");
      if (!existing.providerPaymentId) {
        paymentId = existing.id; providerKey = existing.idempotencyKey; replayed = true;
        await client.query("COMMIT");
      } else {
        paymentId = existing.id; providerKey = existing.idempotencyKey; replayed = true;
        existingProviderPaymentId = existing.providerPaymentId;
        await client.query("COMMIT");
      }
    } else {
      if (order.status === "cancelled" || ["paid", "refunded", "partially_refunded"].includes(order.paymentStatus)) throw new AppError(409, "ORDER_NOT_PAYABLE", "This order is not available for payment.");
      const active = (await client.query("SELECT id,provider_payment_id AS \"providerPaymentId\",idempotency_key AS \"idempotencyKey\",amount,currency,order_total_fingerprint AS \"orderTotalFingerprint\" FROM payments WHERE order_id=$1 AND status IN ('pending','requires_action','processing','authorized') ORDER BY created_at DESC LIMIT 1", [orderId])).rows[0];
      if (active) {
        if (
          cents(active.amount) !== cents(order.grandTotal)
          || active.currency !== order.currency
          || (order.totalFingerprint && active.orderTotalFingerprint !== order.totalFingerprint)
        ) throw new AppError(409, "PAYMENT_TOTAL_STALE", "The existing payment no longer matches the authoritative order total.");
        if (!active.providerPaymentId) {
          paymentId = active.id; providerKey = active.idempotencyKey; replayed = true;
          await client.query("COMMIT");
        } else {
          paymentId = active.id; providerKey = active.idempotencyKey; replayed = true;
          existingProviderPaymentId = active.providerPaymentId;
          await client.query("COMMIT");
        }
      } else {
        const inserted = (await client.query(
          `INSERT INTO payments (order_id, provider, status, amount, currency, idempotency_key, order_total_fingerprint)
           VALUES ($1,$2,'pending',$3,$4,$5,$6) RETURNING id`,
          [orderId, provider.name, Number(order.grandTotal).toFixed(2), order.currency, keyHash, order.totalFingerprint],
        )).rows[0];
        paymentId = inserted.id;
        await client.query("COMMIT");
      }
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  try {
    if (replayed && !existingProviderPaymentId) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const concurrent = (await getDatabasePool().query("SELECT provider_payment_id AS \"providerPaymentId\" FROM payments WHERE id=$1", [paymentId])).rows[0];
        if (concurrent?.providerPaymentId) {
          existingProviderPaymentId = concurrent.providerPaymentId;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const paymentRecord = (await getDatabasePool().query(
      `SELECT provider_payment_id AS "providerPaymentId",amount,currency,order_id AS "orderId"
         FROM payments WHERE id=$1`,
      [paymentId],
    )).rows[0];
    const result = existingProviderPaymentId
      ? await provider.retrievePayment(existingProviderPaymentId)
      : await provider.createPayment({ amountCents: cents(paymentRecord.amount), currency: paymentRecord.currency, orderId, idempotencyKey: providerKey });
    assertProviderSuccessFacts(result, paymentRecord);
    const postProviderClient = await getDatabasePool().connect();
    try {
      await postProviderClient.query("BEGIN");
      const current = (await postProviderClient.query("SELECT status FROM payments WHERE id=$1 FOR UPDATE", [paymentId])).rows[0];
      try {
        if (!current || current.status === "cancelled") throw new AppError(409, "ORDER_NOT_PAYABLE", "This payment was cancelled because the merchandise is no longer payable.");
        await assertOrderMerchandisePayable(postProviderClient, orderId);
      } catch (validationError) {
        let recovery: { operation: "payment_invalidation" | "refund"; refundId?: string; reason: string } | null = null;
        let postProviderCommitted = false;
        if (result.status === "succeeded") {
          const key = hashKey(`hold-race-refund:${paymentId}`);
          const inserted = (await postProviderClient.query(
            "INSERT INTO refunds(order_id,payment_id,amount,currency,status,idempotency_key,reason) SELECT order_id,id,amount,currency,'pending',$2,'Automatic refund after supplier price hold race.' FROM payments WHERE id=$1 RETURNING id",
            [paymentId, key],
          )).rows[0];
          await postProviderClient.query("UPDATE payments SET provider_payment_id=$1,status='processing',failure_reason='Automatic hold-race refund is being created.',updated_at=now() WHERE id=$2", [result.id, paymentId]);
          const refundReservation = await acquireFinancialOperation(postProviderClient, {
            orderId,
            operationType: "payment_refund",
            operationReferenceId: inserted.id,
            leaseSeconds: 180,
          });
          await postProviderClient.query("COMMIT");
          postProviderCommitted = true;
          try {
            const markClient = await getDatabasePool().connect();
            let marked: any;
            try { await markClient.query("BEGIN"); marked = await markFinancialOperationTransmitting(markClient, refundReservation); await markClient.query("COMMIT"); }
            catch (markError) { await markClient.query("ROLLBACK").catch(() => undefined); throw markError; } finally { markClient.release(); }
            const refund = await provider.createRefund({ paymentId: result.id, amountCents: cents(paymentRecord.amount), currency: paymentRecord.currency, idempotencyKey: key, localRefundId: inserted.id });
            const refundStatus = refund.status === "succeeded" ? "completed" : refund.status === "failed" ? "failed" : "processing";
            const outcomeClient = await getDatabasePool().connect();
            try {
              await outcomeClient.query("BEGIN");
              await outcomeClient.query("UPDATE refunds SET provider_reference=$1,status=$2::refund_status,failure_reason=$3,updated_at=now() WHERE id=$4", [refund.id, refundStatus, refund.failureReason ?? null, inserted.id]);
              await outcomeClient.query("UPDATE payments SET status=$1::payment_status,failure_reason=$2,updated_at=now() WHERE id=$3", [refund.status === "succeeded" ? "refunded" : "processing", refund.status === "succeeded" ? "Automatically refunded after supplier price hold race." : "Automatic hold-race refund requires reconciliation.", paymentId]);
              await transitionFinancialOperation(outcomeClient, { id: refundReservation.id, leaseToken: refundReservation.leaseToken, version: marked.version, state: refund.status === "succeeded" || refund.status === "failed" ? "released" : "ambiguous", recoveryEvidence: { refundId: inserted.id, providerReference: refund.id } });
              await outcomeClient.query("COMMIT");
            } catch (outcomeError) { await outcomeClient.query("ROLLBACK"); throw outcomeError; } finally { outcomeClient.release(); }
            if (refund.status !== "succeeded") await enqueueRecoveryJob({ operation: "refund", orderId, paymentId, refundId: inserted.id, reason: "Automatic hold-race refund is not terminal." });
          } catch (refundError) {
            await getDatabasePool().query("UPDATE refunds SET status='processing',failure_reason=$1,updated_at=now() WHERE id=$2", [errorMessage(refundError), inserted.id]);
            const ambiguousClient = await getDatabasePool().connect();
            try { await ambiguousClient.query("BEGIN"); await transitionFinancialOperation(ambiguousClient, { id: refundReservation.id, leaseToken: refundReservation.leaseToken, version: refundReservation.version, state: "ambiguous", failureMessage: errorMessage(refundError), recoveryEvidence: { refundId: inserted.id } }); await ambiguousClient.query("COMMIT"); } catch { await ambiguousClient.query("ROLLBACK").catch(() => undefined); } finally { ambiguousClient.release(); }
            await enqueueRecoveryJob({ operation: "refund", orderId, paymentId, refundId: inserted.id, reason: errorMessage(refundError) });
          }
          throw validationError;
        } else {
          const cancellationReservation = await acquireFinancialOperation(postProviderClient, { orderId, operationType: "payment_invalidation", operationReferenceId: `post-provider:${paymentId}`, leaseSeconds: 180 });
          await postProviderClient.query("COMMIT");
          postProviderCommitted = true;
           // Keep the test-only acquisition seam after the durable
           // invalidation reservation as well as in recovery.  This is
           // intentionally after COMMIT: callers must be able to coordinate
           // the financial authority race without pausing while holding the
           // payment row/order transaction locks.
           await pauseAfterFinancialOperationReservation();
          const markClient = await getDatabasePool().connect();
          let marked: any;
          try { await markClient.query("BEGIN"); marked = await markFinancialOperationTransmitting(markClient, cancellationReservation); await markClient.query("COMMIT"); }
          catch (markError) { await markClient.query("ROLLBACK").catch(() => undefined); throw markError; } finally { markClient.release(); }
          let cancelled: any = result;
          if (result.status !== "cancelled") {
            try { cancelled = await provider.cancelPayment(result.id); }
            catch (cancelError) {
              const ambiguous = await getDatabasePool().connect();
              try { await ambiguous.query("BEGIN"); await transitionFinancialOperation(ambiguous, { id: cancellationReservation.id, leaseToken: cancellationReservation.leaseToken, version: marked.version, state: "ambiguous", failureMessage: errorMessage(cancelError), recoveryEvidence: { paymentId, providerCall: "cancel" } }); await ambiguous.query("COMMIT"); } catch { await ambiguous.query("ROLLBACK").catch(() => undefined); } finally { ambiguous.release(); }
              throw cancelError;
            }
          }
          const confirmed = cancelled.status === "cancelled";
          const outcomeClient = await getDatabasePool().connect();
          try { await outcomeClient.query("BEGIN"); await outcomeClient.query("UPDATE payments SET provider_payment_id=$1,status=$2::payment_status,failure_reason=$3,updated_at=now() WHERE id=$4", [result.id, confirmed ? "cancelled" : "processing", confirmed ? "Cancelled after post-provider merchandise revalidation." : "Provider cancellation is not terminal and requires reconciliation.", paymentId]); await transitionFinancialOperation(outcomeClient, { id: cancellationReservation.id, leaseToken: cancellationReservation.leaseToken, version: marked.version, state: confirmed ? "released" : "ambiguous", recoveryEvidence: { paymentId, providerReference: result.id } }); await outcomeClient.query("COMMIT"); } catch (outcomeError) { await outcomeClient.query("ROLLBACK"); throw outcomeError; } finally { outcomeClient.release(); }
          if (!confirmed) recovery = { operation: "payment_invalidation", reason: "Provider cancellation after a supplier price hold is not terminal." };
        }
        if (!postProviderCommitted) await postProviderClient.query("COMMIT");
        if (recovery) await enqueueRecoveryJob({ operation: recovery.operation, orderId, paymentId, refundId: recovery.refundId, reason: recovery.reason });
        throw validationError;
      }
      await postProviderClient.query("UPDATE payments SET provider_payment_id=$1,status=$2::payment_status,payment_method_type=$3,failure_reason=$4,updated_at=now() WHERE id=$5", [result.id, result.status, result.paymentMethodType ?? null, result.failureReason ?? null, paymentId]);
      await postProviderClient.query("COMMIT");
    } catch (error) {
      try { await postProviderClient.query("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    } finally {
      postProviderClient.release();
    }
    if (result.status === "succeeded") await finalizeSuccess(paymentId, "payment_creation");
    else if (result.status === "failed") await transition(paymentId, "failed", result.failureReason ?? "The payment could not be completed.");
    else if (result.status === "cancelled") await failPayment(paymentId, "cancelled", result.failureReason ?? "The payment was cancelled.");
    return { payment: serializePayment(await paymentById(getDatabasePool(), paymentId)), clientSecret: result.clientSecret, replayed };
  } catch (error) {
    const definitive = error instanceof AppError && error.code === "PAYMENT_PROVIDER_ERROR";
    await getDatabasePool().query("UPDATE payments SET status=$1::payment_status, failure_reason=$2, updated_at=now() WHERE id=$3 AND status NOT IN ('paid','refunded','partially_refunded','cancelled') AND NOT (provider_payment_id IS NOT NULL AND status='processing')", [definitive ? "failed" : "pending", definitive ? error.message : "The provider outcome is unknown and must be reconciled before retrying.", paymentId]);
    try {
      const recoveryPayment = (await getDatabasePool().query("SELECT provider_payment_id AS \"providerPaymentId\",status FROM payments WHERE id=$1", [paymentId])).rows[0];
      if (!["cancelled", "refunded"].includes(recoveryPayment?.status)) {
        const maintenance = error instanceof AppError && error.code === "TOONIES_PROCUREMENT_MAINTENANCE";
        await enqueueRecoveryJob({ operation: maintenance ? "payment_status" : recoveryPayment?.providerPaymentId ? "payment_invalidation" : "payment_creation", orderId, paymentId, reason: errorMessage(error) });
      }
    } catch (queueError) {
      logger.error("payment creation recovery could not be queued", { paymentId, error: errorMessage(queueError) });
    }
    throw error;
  }
}

export async function getCustomerPayment(orderId: string, access: Access) {
  await getOrder(orderId, access);
  const rows = await getDatabasePool().query(
    `SELECT p.id, p.order_id AS "orderId", o.order_number AS "orderNumber", p.provider, p.provider_payment_id AS "providerPaymentId",
            p.status, p.amount, p.currency, p.payment_method_type AS "paymentMethodType", p.failure_reason AS "failureReason",
            p.paid_at AS "paidAt", p.created_at AS "createdAt", p.updated_at AS "updatedAt"
       FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.order_id=$1 ORDER BY p.created_at DESC`,
    [orderId],
  );
  return rows.rows.map(serializePayment);
}

async function processWebhookPayload(payload: Record<string, any>, eventId: string, eventType: string) {
  const provider = getPaymentProvider();
  const object = payload.data?.object ?? {};
  const providerPaymentId = typeof object.id === "string" ? object.id : "";
  if (eventType.startsWith("refund.")) return handleRefundWebhook(payload, eventId, eventType, object);
  const payment = providerPaymentId ? (await getDatabasePool().query("SELECT id,order_id AS \"orderId\",amount,currency FROM payments WHERE provider=$1 AND provider_payment_id=$2", [provider.name, providerPaymentId])).rows[0] : undefined;
  if (!payment) return { received: true, ignored: true };
  const duplicate = await getDatabasePool().query("SELECT 1 FROM payment_events WHERE provider_event_id=$1", [eventId]);
  if (duplicate.rowCount) {
    await completeRecoveryJob(eventId);
    return { received: true, duplicate: true };
  }
  const status = mapProviderEventStatus(eventType);
  try {
    if (status === "succeeded") {
      const signedAmount = Number(object.amount_received ?? object.amount);
      const signedCurrency = typeof object.currency === "string" ? object.currency.toUpperCase() : "";
      const signedOrderId = typeof object.metadata?.order_id === "string" ? object.metadata.order_id : "";
      if (!Number.isSafeInteger(signedAmount) || signedAmount !== cents(payment.amount) || signedCurrency !== payment.currency || signedOrderId !== payment.orderId) throw new AppError(409, "PAYMENT_PROVIDER_FACTS_MISMATCH", "The signed payment facts do not match the locked order.");
    }
    if (status) await transition(payment.id, status, typeof object.last_payment_error?.message === "string" ? object.last_payment_error.message : undefined);
    const inserted = await getDatabasePool().query(
      `INSERT INTO payment_events (payment_id, provider_event_id, event_type, payload_json, signature_verified)
       VALUES ($1,$2,$3,$4,true) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`,
      [payment.id, eventId, eventType, payload],
    );
    await completeRecoveryJob(eventId);
    if (!inserted.rowCount) return { received: true, duplicate: true };
    return { received: true, processed: Boolean(status) };
  } catch (error) {
    await recordWebhookFailure({ orderId: payment.orderId, paymentId: payment.id, providerEventId: eventId, eventType, payload }, error);
    throw error;
  }
}

export async function handleWebhook(rawBody: Buffer, signature: string) {
  const provider = getPaymentProvider();
  const payload = provider.verifyWebhook(rawBody, signature);
  const eventId = typeof payload.id === "string" ? payload.id : "";
  const eventType = typeof payload.type === "string" ? payload.type : "";
  if (!eventId || !eventType) throw new AppError(400, "INVALID_PAYMENT_EVENT", "The payment webhook event is invalid.");
  return processWebhookPayload(payload, eventId, eventType);
}

async function handleRefundWebhook(payload: Record<string, any>, eventId: string, eventType: string, object: any) {
  const reference = typeof object.id === "string" ? object.id : "";
  const metadataRefundId = typeof object.metadata?.refund_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(object.metadata.refund_id) ? object.metadata.refund_id : null;
  const refund = reference || metadataRefundId ? (await getDatabasePool().query(
    `SELECT r.id,r.order_id AS "orderId",r.payment_id AS "paymentId",r.amount,r.currency,p.provider_payment_id AS "providerPaymentId"
       FROM refunds r JOIN payments p ON p.id=r.payment_id
      WHERE r.provider_reference=$1 OR ($2::uuid IS NOT NULL AND r.id=$2::uuid)`,
    [reference, metadataRefundId],
  )).rows[0] : undefined;
  if (!refund) return { received: true, ignored: true };
  if (typeof object.payment_intent === "string" && object.payment_intent !== refund.providerPaymentId) {
    const error = new AppError(409, "REFUND_PROVIDER_FACTS_MISMATCH", "The signed refund facts do not match the payment record.");
    await recordWebhookFailure({ orderId: refund.orderId, paymentId: refund.paymentId, providerEventId: eventId, eventType, payload }, error);
    throw error;
  }
  if ((await getDatabasePool().query("SELECT 1 FROM payment_events WHERE provider_event_id=$1", [eventId])).rowCount) {
    await completeRecoveryJob(eventId);
    return { received: true, duplicate: true };
  }
  const signedAmount = Number(object.amount);
  const signedCurrency = typeof object.currency === "string" ? object.currency.toUpperCase() : "";
  if (!Number.isSafeInteger(signedAmount) || signedAmount !== cents(refund.amount) || signedCurrency !== refund.currency) {
    const error = new AppError(409, "REFUND_PROVIDER_FACTS_MISMATCH", "The signed refund facts do not match the refund record.");
    await recordWebhookFailure({ orderId: refund.orderId, paymentId: refund.paymentId, providerEventId: eventId, eventType, payload }, error);
    throw error;
  }
  const nextStatus = object.status === "succeeded" ? "completed" : object.status === "failed" || eventType === "refund.failed" ? "failed" : "processing";
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [refund.paymentId]);
    await client.query("UPDATE refunds SET status=$1::refund_status,failure_reason=$2,updated_at=now() WHERE id=$3", [nextStatus, typeof object.failure_reason === "string" ? object.failure_reason : null, refund.id]);
    if (nextStatus === "completed") {
      const totals = (await client.query("SELECT p.amount,COALESCE(sum(r.amount) FILTER (WHERE r.status='completed'),0)::text AS refunded FROM payments p LEFT JOIN refunds r ON r.payment_id=p.id WHERE p.id=$1 GROUP BY p.id", [refund.paymentId])).rows[0];
      await client.query("UPDATE payments SET status=$1::payment_status,updated_at=now() WHERE id=$2", [cents(totals.refunded) >= cents(totals.amount) ? "refunded" : "partially_refunded", refund.paymentId]);
    }
    await client.query("INSERT INTO payment_events (payment_id,provider_event_id,event_type,payload_json,signature_verified) VALUES ($1,$2,$3,$4,true) ON CONFLICT (provider_event_id) DO NOTHING", [refund.paymentId, eventId, eventType, payload]);
    await notifyRefundEvent(refund.id, nextStatus, client);
    await client.query("COMMIT");
    await completeRecoveryJob(eventId);
  } catch (error) {
    await client.query("ROLLBACK");
    try {
      await enqueueRecoveryJob({
        operation: "webhook",
        orderId: refund.orderId,
        paymentId: refund.paymentId,
        providerEventId: eventId,
        eventType,
        payload,
        reason: errorMessage(error),
      });
      logger.warn("refund webhook queued for recovery", { eventId, refundId: refund.id, error: errorMessage(error) });
    } catch (queueError) {
      logger.error("refund webhook recovery could not be queued", { eventId, refundId: refund.id, error: errorMessage(queueError) });
    }
    throw error;
  } finally { client.release(); }
  return { received: true, processed: true };
}

export async function listAdminPayments(filters: { search?: string; status?: string; page?: number; pageSize?: number } = {}) {
  const values: unknown[] = [];
  const clauses = ["1=1"];
  if (filters.search?.trim()) { values.push(`%${filters.search.trim()}%`); clauses.push(`(o.order_number ILIKE $${values.length} OR p.provider_payment_id ILIKE $${values.length} OR o.guest_email ILIKE $${values.length} OR u.email ILIKE $${values.length})`); }
  if (filters.status) { values.push(filters.status); clauses.push(`p.status=$${values.length}::payment_status`); }
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const count = await getDatabasePool().query(`SELECT count(*)::text AS count FROM payments p JOIN orders o ON o.id=p.order_id LEFT JOIN users u ON u.id=o.user_id WHERE ${clauses.join(" AND ")}`, values);
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await getDatabasePool().query(
    `SELECT p.id, p.order_id AS "orderId", o.order_number AS "orderNumber", p.provider, p.provider_payment_id AS "providerPaymentId", p.status,
            p.amount, p.currency, p.payment_method_type AS "paymentMethodType", p.failure_reason AS "failureReason", p.paid_at AS "paidAt",
            p.created_at AS "createdAt", COALESCE(o.guest_email,u.email) AS email
       FROM payments p JOIN orders o ON o.id=p.order_id LEFT JOIN users u ON u.id=o.user_id
      WHERE ${clauses.join(" AND ")} ORDER BY p.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = Number(count.rows[0]?.count ?? 0);
  return { items: rows.rows.map(serializePayment), meta: { page, pageSize, total, hasNext: (page - 1) * pageSize + rows.rows.length < total } };
}

function serializeAdminRefund(row: any) {
  const status = String(row.status);
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    paymentId: row.paymentId,
    returnRequestId: row.returnRequestId,
    customerName: row.customerName ?? null,
    customerEmail: row.customerEmail ?? null,
    companyName: row.companyName ?? null,
    provider: row.provider ?? null,
    providerPaymentId: row.providerPaymentId ?? null,
    providerReference: row.providerReference ?? null,
    requestedAmount: Number(row.requestedAmount),
    refundedAmount: status === "completed" ? Number(row.requestedAmount) : 0,
    currency: row.currency,
    status,
    reason: row.reason ?? null,
    failureReason: row.failureReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const adminRefundSelect = `
  SELECT r.id, r.order_id AS "orderId", o.order_number AS "orderNumber",
         r.payment_id AS "paymentId", r.return_request_id AS "returnRequestId",
         r.provider_reference AS "providerReference", r.amount AS "requestedAmount",
         r.currency, r.status, r.reason, r.failure_reason AS "failureReason",
         r.created_at AS "createdAt", r.updated_at AS "updatedAt",
         COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name), ''), u.email) AS "customerName",
         COALESCE(o.guest_email, u.email) AS "customerEmail",
         c.company_name AS "companyName",
         p.provider, p.provider_payment_id AS "providerPaymentId"
    FROM refunds r
    JOIN orders o ON o.id = r.order_id
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN companies c ON c.id = o.company_id
    LEFT JOIN payments p ON p.id = r.payment_id
`;

export async function listAdminRefunds(filters: { search?: string; status?: string; page?: number; pageSize?: number } = {}) {
  const values: unknown[] = [];
  const clauses = ["1=1"];
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    const parameter = `$${values.length}`;
    clauses.push(`(
      o.order_number ILIKE ${parameter}
      OR COALESCE(o.guest_email, u.email) ILIKE ${parameter}
      OR COALESCE(c.company_name, '') ILIKE ${parameter}
      OR COALESCE(r.provider_reference, '') ILIKE ${parameter}
      OR COALESCE(r.reason, '') ILIKE ${parameter}
      OR r.id::text ILIKE ${parameter}
    )`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`r.status = $${values.length}::refund_status`);
  }
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const pool = getDatabasePool();
  const where = `WHERE ${clauses.join(" AND ")}`;
  const count = await pool.query(`SELECT count(*)::text AS count FROM refunds r JOIN orders o ON o.id=r.order_id LEFT JOIN users u ON u.id=o.user_id LEFT JOIN companies c ON c.id=o.company_id ${where}`, values);
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await pool.query(
    `${adminRefundSelect}
     ${where}
     ORDER BY r.created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = Number(count.rows[0]?.count ?? 0);
  return {
    items: rows.rows.map(serializeAdminRefund),
    meta: { page, pageSize, total, hasNext: (page - 1) * pageSize + rows.rows.length < total },
    provider: (() => {
      const provider = getPaymentProvider();
      return { name: provider.name, configured: provider.configured };
    })(),
  };
}

export async function getAdminRefund(refundId: string) {
  const pool = getDatabasePool();
  const result = await pool.query(
    `${adminRefundSelect}
     WHERE r.id = $1`,
    [refundId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "REFUND_NOT_FOUND", "The refund was not found.");
  const [returnResult, recoveryResult] = await Promise.all([
    row.returnRequestId
      ? pool.query(
        `SELECT id, reason, description, status, reviewed_at AS "reviewedAt", received_at AS "receivedAt"
           FROM return_requests WHERE id = $1`,
        [row.returnRequestId],
      )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT id, operation, status, attempts, retryable, last_error AS "lastError",
              next_attempt_at AS "nextAttemptAt", last_attempt_at AS "lastAttemptAt"
         FROM payment_recovery_jobs WHERE refund_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [refundId],
    ),
  ]);
  return {
    refund: serializeAdminRefund(row),
    payment: row.paymentId ? {
      id: row.paymentId,
      provider: row.provider,
      providerPaymentId: row.providerPaymentId,
    } : null,
    order: { id: row.orderId, orderNumber: row.orderNumber },
    customer: row.customerName || row.customerEmail ? { name: row.customerName, email: row.customerEmail } : null,
    company: row.companyName ? { name: row.companyName } : null,
    returnRequest: returnResult.rows[0] ?? null,
    recoveryJobs: recoveryResult.rows,
    provider: (() => {
      const provider = getPaymentProvider();
      return { name: provider.name, configured: provider.configured };
    })(),
  };
}

export async function getAdminPayment(paymentId: string) {
  const client = getDatabasePool();
  const payment = await paymentById(client, paymentId);
  if (!payment) throw new AppError(404, "PAYMENT_NOT_FOUND", "The payment was not found.");
  const [events, refunds] = await Promise.all([
    client.query("SELECT id, provider_event_id AS \"providerEventId\", event_type AS \"eventType\", created_at AS \"createdAt\" FROM payment_events WHERE payment_id=$1 ORDER BY created_at DESC", [paymentId]),
    client.query("SELECT id, provider_reference AS \"providerReference\", amount, currency, status, failure_reason AS \"failureReason\", created_at AS \"createdAt\" FROM refunds WHERE payment_id=$1 ORDER BY created_at DESC", [paymentId]),
  ]);
  return { payment: serializePayment(payment), events: events.rows, refunds: refunds.rows.map((row) => ({ ...row, amount: Number(row.amount) })) };
}

export async function createRefund(paymentId: string, amount: number, idempotencyKey: string, reason?: string) {
  const keyHash = hashKey(idempotencyKey);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, "INVALID_REFUND_AMOUNT", "Refund amount must be greater than zero.");
  const provider = getPaymentProvider();
  if (!provider.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online refunds are not configured yet.");
  const client = await getDatabasePool().connect();
  let refundId = "";
  let providerPaymentId = "";
  let currency = "EUR";
  let refundAmountCents = cents(amount.toFixed(2));
  let replayed = false;
  let financialReservation: any;
  try {
    await client.query("BEGIN");
    const paymentOwner = (await client.query("SELECT order_id AS \"orderId\" FROM payments WHERE id=$1", [paymentId])).rows[0];
    if (!paymentOwner) throw new AppError(404, "PAYMENT_NOT_FOUND", "The payment was not found.");
    await assertTooniesSettlementMutationAllowed(client, paymentOwner.orderId);
    const payment = (await client.query("SELECT id,provider,provider_payment_id AS \"providerPaymentId\",status,amount,currency FROM payments WHERE id=$1 FOR UPDATE", [paymentId])).rows[0];
    if (!payment) throw new AppError(404, "PAYMENT_NOT_FOUND", "The payment was not found.");
    if (!["paid", "partially_refunded"].includes(payment.status)) throw new AppError(409, "PAYMENT_NOT_REFUNDABLE", "Only a paid payment can be refunded.");
    if (!payment.providerPaymentId) throw new AppError(409, "PAYMENT_PROVIDER_REFERENCE_MISSING", "The payment has no provider reference.");
    const existing = (await client.query("SELECT id,provider_reference AS \"providerReference\",amount,status FROM refunds WHERE idempotency_key=$1", [keyHash])).rows[0];
    if (existing?.providerReference || (existing && !["pending", "processing"].includes(existing.status))) {
      await client.query("COMMIT");
      return getAdminPayment(paymentId);
    }
    providerPaymentId = payment.providerPaymentId; currency = payment.currency;
    if (existing) {
      refundId = existing.id;
      refundAmountCents = cents(existing.amount);
      replayed = true;
    } else {
      const paidCents = cents(payment.amount);
      const alreadyRefunded = (await client.query("SELECT COALESCE(sum(amount),0)::text AS amount FROM refunds WHERE payment_id=$1 AND status IN ('pending','processing','completed')", [paymentId])).rows[0].amount;
      if (refundAmountCents > paidCents - cents(alreadyRefunded)) throw new AppError(409, "REFUND_EXCEEDS_PAYMENT", "The refund exceeds the remaining paid amount.");
      const inserted = (await client.query("INSERT INTO refunds (order_id,payment_id,amount,currency,status,idempotency_key,reason) SELECT order_id,id,$2,currency,'pending',$3,$4 FROM payments WHERE id=$1 RETURNING id", [paymentId, amount.toFixed(2), keyHash, reason?.trim() || null])).rows[0];
      refundId = inserted.id;
    }
    financialReservation = await acquireFinancialOperation(client, {
      orderId: paymentOwner.orderId,
      operationType: "payment_refund",
      operationReferenceId: refundId,
      leaseSeconds: 180,
    });
    financialReservation = { ...financialReservation, ...await markFinancialOperationTransmitting(client, financialReservation) };
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  try {
    const result = await provider.createRefund({ paymentId: providerPaymentId, amountCents: refundAmountCents, currency, idempotencyKey: keyHash, localRefundId: refundId });
    const clientResult = await getDatabasePool().connect();
    try {
      await clientResult.query("BEGIN");
      await clientResult.query("UPDATE refunds SET provider_reference=$1,status=$2::refund_status,failure_reason=$3,updated_at=now() WHERE id=$4", [result.id, result.status === "succeeded" ? "completed" : result.status === "failed" ? "failed" : "processing", result.failureReason ?? null, refundId]);
      if (result.status === "succeeded") {
        const totals = (await clientResult.query("SELECT p.amount, COALESCE(sum(r.amount) FILTER (WHERE r.status='completed'),0)::text AS refunded FROM payments p LEFT JOIN refunds r ON r.payment_id=p.id WHERE p.id=$1 GROUP BY p.id", [paymentId])).rows[0];
        const nextStatus = cents(totals.refunded) >= cents(totals.amount) ? "refunded" : "partially_refunded";
        await clientResult.query("UPDATE payments SET status=$1::payment_status,updated_at=now() WHERE id=$2", [nextStatus, paymentId]);
      }
      await transitionFinancialOperation(clientResult, {
        id: financialReservation.id,
        leaseToken: financialReservation.leaseToken,
        version: financialReservation.version,
        state: result.status === "pending" ? "ambiguous" : result.status === "succeeded" ? "released" : "failed",
        recoveryEvidence: { refundId, providerReference: result.id, status: result.status },
      });
      await notifyRefundEvent(refundId, result.status === "succeeded" ? "completed" : result.status === "failed" ? "failed" : "processing", clientResult);
      await clientResult.query("COMMIT");
      if (result.status === "pending") {
        await enqueueRecoveryJob({ operation: "refund", paymentId, refundId, reason: "The provider refund is still pending." });
      }
    } catch (error) { await clientResult.query("ROLLBACK"); throw error; } finally { clientResult.release(); }
  } catch (error) {
    const definitive = error instanceof AppError && error.code === "PAYMENT_PROVIDER_ERROR";
    await getDatabasePool().query("UPDATE refunds SET status=$1::refund_status,failure_reason=$2,updated_at=now() WHERE id=$3", [definitive ? "failed" : "processing", definitive ? error.message : "The provider outcome is unknown and must be reconciled by webhook.", refundId]);
    if (financialReservation) {
      const recoveryDb = await getDatabasePool().connect();
      try {
        await recoveryDb.query("BEGIN");
        await transitionFinancialOperation(recoveryDb, {
          id: financialReservation.id,
          leaseToken: financialReservation.leaseToken,
          version: financialReservation.version,
          state: definitive ? "failed" : "ambiguous",
          failureMessage: errorMessage(error),
          recoveryEvidence: { refundId, ambiguous: !definitive },
        });
        await recoveryDb.query("COMMIT");
      } catch { await recoveryDb.query("ROLLBACK").catch(() => undefined); } finally { recoveryDb.release(); }
    }
    try {
      await enqueueRecoveryJob({ operation: "refund", paymentId, refundId, reason: errorMessage(error) });
    } catch (queueError) {
      logger.error("refund recovery could not be queued", { refundId, error: errorMessage(queueError) });
    }
    throw error;
  }
  return { ...(await getAdminPayment(paymentId)), replayed };
}

async function recoverPaymentCreation(paymentId: string) {
  const payment = (await getDatabasePool().query(
    `SELECT p.id,p.order_id AS "orderId",p.provider_payment_id AS "providerPaymentId",p.idempotency_key AS "idempotencyKey",
            p.amount,p.currency,p.status,o.status AS "orderStatus",o.payment_status AS "orderPaymentStatus"
       FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=$1`,
    [paymentId],
  )).rows[0];
  if (!payment) throw new AppError(404, "PAYMENT_NOT_FOUND", "The payment was not found.");
  if (payment.providerPaymentId || ["paid", "cancelled", "refunded", "partially_refunded"].includes(payment.status) || payment.orderStatus === "cancelled") return;
  if (!payment.idempotencyKey) throw new AppError(409, "PAYMENT_IDEMPOTENCY_KEY_MISSING", "The payment cannot be recovered without its idempotency key.");
  await assertTooniesOrderPaymentEnabled(getDatabasePool(), payment.orderId);
  const provider = getPaymentProvider();
  if (!provider.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online payments are not configured yet.");
  const result = await provider.createPayment({
    amountCents: cents(payment.amount),
    currency: payment.currency,
    orderId: payment.orderId,
    idempotencyKey: payment.idempotencyKey,
  });
  await getDatabasePool().query(
    `UPDATE payments SET provider_payment_id=$1,status=$2::payment_status,payment_method_type=$3,failure_reason=$4,updated_at=now()
      WHERE id=$5 AND provider_payment_id IS NULL`,
    [result.id, result.status, result.paymentMethodType ?? null, result.failureReason ?? null, paymentId],
  );
  if (result.status === "succeeded") await finalizeSuccess(paymentId, "payment_creation_recovery");
  else if (result.status === "cancelled") await failPayment(paymentId, "cancelled", result.failureReason ?? "The payment was cancelled.");
  else if (result.status === "failed") await transition(paymentId, "failed", result.failureReason ?? "The payment provider reported a failure.");
}

export async function recoverInvalidatedPayment(paymentId: string) {
  const payment = (await getDatabasePool().query(
    `SELECT id,order_id AS "orderId",provider_payment_id AS "providerPaymentId",amount,currency,status FROM payments WHERE id=$1`,
    [paymentId],
  )).rows[0];
  if (!payment || ["cancelled", "refunded"].includes(payment.status)) return;
  if (!payment.providerPaymentId) throw new AppError(409, "PAYMENT_PROVIDER_REFERENCE_MISSING", "The invalidated payment has no provider reference.");
  const settlementLock = await getDatabasePool().connect();
  let financialReservation: any;
  try {
    await settlementLock.query("BEGIN");
    await assertTooniesSettlementMutationAllowed(settlementLock, payment.orderId);
    financialReservation = await acquireFinancialOperation(settlementLock, {
      orderId: payment.orderId,
      operationType: "payment_invalidation",
      operationReferenceId: paymentId,
      leaseSeconds: 300,
    });
    await settlementLock.query("COMMIT");
    await pauseAfterFinancialOperationReservation();
  } catch (error) {
    await settlementLock.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    settlementLock.release();
  }
  const provider = getPaymentProvider();
  let outcome: any;
  try {
    outcome = await provider.getPayment(payment.providerPaymentId);
  } catch (error) {
    const db = await getDatabasePool().connect();
    try {
      await db.query("BEGIN");
      await transitionFinancialOperation(db, { id: financialReservation.id, leaseToken: financialReservation.leaseToken, version: financialReservation.version, state: "ambiguous", failureMessage: errorMessage(error), recoveryEvidence: { paymentId, ambiguous: true } });
      await db.query("COMMIT");
    } catch { await db.query("ROLLBACK").catch(() => undefined); } finally { db.release(); }
    throw error;
  }
  if (outcome.status === "succeeded") {
    const key = hashKey(`hold-race-refund:${paymentId}`);
    const existing = (await getDatabasePool().query("SELECT id,status FROM refunds WHERE idempotency_key=$1", [key])).rows[0];
    if (existing?.status === "completed") {
      await getDatabasePool().query("UPDATE payments SET status='refunded',updated_at=now() WHERE id=$1", [paymentId]);
      const db = await getDatabasePool().connect();
      try { await db.query("BEGIN"); await transitionFinancialOperation(db, { id: financialReservation.id, leaseToken: financialReservation.leaseToken, version: financialReservation.version, state: "released", recoveryEvidence: { paymentId, status: "refunded" } }); await db.query("COMMIT"); } catch { await db.query("ROLLBACK").catch(() => undefined); } finally { db.release(); }
      return;
    }
    const refundId = existing?.id ?? (await getDatabasePool().query(
      "INSERT INTO refunds(order_id,payment_id,amount,currency,status,idempotency_key,reason) VALUES($1,$2,$3,$4,'pending',$5,'Automatic refund after supplier price hold race.') RETURNING id",
      [payment.orderId, paymentId, payment.amount, payment.currency, key],
    )).rows[0].id;
    const markDb = await getDatabasePool().connect();
    let marked: any;
    try { await markDb.query("BEGIN"); marked = await markFinancialOperationTransmitting(markDb, financialReservation); await markDb.query("COMMIT"); financialReservation = { ...financialReservation, ...marked }; }
    catch (error) { await markDb.query("ROLLBACK").catch(() => undefined); throw error; } finally { markDb.release(); }
    let refund: any;
    try {
      refund = await provider.createRefund({ paymentId: payment.providerPaymentId, amountCents: cents(payment.amount), currency: payment.currency, idempotencyKey: key, localRefundId: refundId });
    } catch (error) {
      const ambiguous = await getDatabasePool().connect();
      try { await ambiguous.query("BEGIN"); await transitionFinancialOperation(ambiguous, { id: financialReservation.id, leaseToken: financialReservation.leaseToken, version: financialReservation.version, state: "ambiguous", failureMessage: errorMessage(error), recoveryEvidence: { paymentId, refundId } }); await ambiguous.query("COMMIT"); } catch { await ambiguous.query("ROLLBACK").catch(() => undefined); } finally { ambiguous.release(); }
      throw error;
    }
    const status = refund.status === "succeeded" ? "completed" : refund.status === "failed" ? "failed" : "processing";
    await getDatabasePool().query("UPDATE refunds SET provider_reference=$1,status=$2::refund_status,failure_reason=$3,updated_at=now() WHERE id=$4", [refund.id, status, refund.failureReason ?? null, refundId]);
    if (refund.status !== "succeeded") throw new AppError(409, "PAYMENT_INVALIDATION_REFUND_PENDING", "The invalidated payment refund has not completed.");
    await getDatabasePool().query("UPDATE payments SET status='refunded',failure_reason='Automatically refunded after supplier price hold race.',updated_at=now() WHERE id=$1", [paymentId]);
    const db = await getDatabasePool().connect();
    try { await db.query("BEGIN"); await transitionFinancialOperation(db, { id: financialReservation.id, leaseToken: financialReservation.leaseToken, version: financialReservation.version, state: "released", recoveryEvidence: { paymentId, status: "refunded" } }); await db.query("COMMIT"); } catch { await db.query("ROLLBACK").catch(() => undefined); } finally { db.release(); }
    return;
  }
  let cancelled = outcome;
  if (outcome.status !== "cancelled") {
    const markDb = await getDatabasePool().connect();
    let marked: any;
    try { await markDb.query("BEGIN"); marked = await markFinancialOperationTransmitting(markDb, financialReservation); await markDb.query("COMMIT"); financialReservation = { ...financialReservation, ...marked }; }
    catch (error) { await markDb.query("ROLLBACK").catch(() => undefined); throw error; } finally { markDb.release(); }
    try { cancelled = await provider.cancelPayment(payment.providerPaymentId); }
    catch (error) {
      const ambiguous = await getDatabasePool().connect();
      try { await ambiguous.query("BEGIN"); await transitionFinancialOperation(ambiguous, { id: financialReservation.id, leaseToken: financialReservation.leaseToken, version: financialReservation.version, state: "ambiguous", failureMessage: errorMessage(error), recoveryEvidence: { paymentId, providerCall: "cancel" } }); await ambiguous.query("COMMIT"); } catch { await ambiguous.query("ROLLBACK").catch(() => undefined); } finally { ambiguous.release(); }
      throw error;
    }
  }
  if (cancelled.status !== "cancelled") throw new AppError(409, "PAYMENT_INVALIDATION_PENDING", "The invalidated provider payment has not cancelled.");
  await getDatabasePool().query("UPDATE payments SET status='cancelled',failure_reason='Provider cancellation confirmed after supplier price hold.',updated_at=now() WHERE id=$1", [paymentId]);
  const db = await getDatabasePool().connect();
  try { await db.query("BEGIN"); await transitionFinancialOperation(db, { id: financialReservation.id, leaseToken: financialReservation.leaseToken, version: financialReservation.version, state: "released", recoveryEvidence: { paymentId, status: "cancelled" } }); await db.query("COMMIT"); } catch { await db.query("ROLLBACK").catch(() => undefined); } finally { db.release(); }
}

async function recoverPaymentStatus(paymentId: string) {
  const payment = (await getDatabasePool().query(
    `SELECT p.id,p.order_id AS "orderId",p.provider_payment_id AS "providerPaymentId",p.status,p.amount,p.currency
       FROM payments p WHERE p.id=$1`,
    [paymentId],
  )).rows[0];
  if (!payment) throw new AppError(404, "PAYMENT_NOT_FOUND", "The payment was not found.");
  if (["paid", "cancelled", "refunded", "partially_refunded"].includes(payment.status)) return;
  if (!payment.providerPaymentId) throw new AppError(409, "PAYMENT_PROVIDER_REFERENCE_MISSING", "The payment has no provider reference.");
  await assertTooniesOrderPaymentEnabled(getDatabasePool(), payment.orderId);
  const provider = getPaymentProvider();
  if (!provider.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online payments are not configured yet.");
  const outcome = await provider.getPayment(payment.providerPaymentId);
  if (outcome.status === "succeeded" && (
    outcome.amountCents !== cents(payment.amount)
    || outcome.currency !== payment.currency
    || outcome.orderId !== payment.orderId
  )) throw new AppError(409, "PAYMENT_PROVIDER_FACTS_MISMATCH", "The provider payment facts do not match the locked order.");
  await transition(paymentId, outcome.status, outcome.failureReason);
}

async function recoverRefund(refundId: string) {
  const refund = (await getDatabasePool().query(
    `SELECT r.id,r.order_id AS "orderId",r.payment_id AS "paymentId",r.provider_reference AS "providerReference",r.amount,r.currency,r.status,
            r.idempotency_key AS "idempotencyKey",r.created_at AS "createdAt",p.provider_payment_id AS "providerPaymentId"
       FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE r.id=$1`,
    [refundId],
  )).rows[0];
  if (!refund) throw new AppError(404, "REFUND_NOT_FOUND", "The refund was not found.");
  if (refund.status === "completed" || refund.status === "cancelled") return;
  if (!refund.providerPaymentId || !refund.idempotencyKey) throw new AppError(409, "REFUND_NOT_RECOVERABLE", "The refund is missing its provider reference or idempotency key.");
  const reservationDb = await getDatabasePool().connect();
  let financialReservation: any;
  let recoveryOnly = false;
  try {
    await reservationDb.query("BEGIN");
    financialReservation = (await reservationDb.query(
      `SELECT id,order_id AS "orderId",operation_type AS "operationType",operation_reference_id AS "operationReferenceId",
              state,phase,transmission_started_at AS "transmissionStartedAt",lease_token AS "leaseToken",lease_until AS "leaseUntil",version
         FROM financial_operation_reservations WHERE operation_type='payment_refund' AND operation_reference_id=$1 FOR UPDATE`,
      [refund.id],
    )).rows[0];
    if (financialReservation) {
      recoveryOnly = financialReservation.state === "ambiguous" || financialReservation.phase === "transmitting" || Boolean(financialReservation.transmissionStartedAt);
      if (["completed", "failed", "released"].includes(financialReservation.state) && refund.status !== "processing") return;
    } else {
      financialReservation = await acquireFinancialOperation(reservationDb, {
        orderId: refund.orderId, operationType: "payment_refund", operationReferenceId: refund.id, leaseSeconds: 180,
      });
    }
    await reservationDb.query("COMMIT");
  } catch (error) {
    await reservationDb.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { reservationDb.release(); }
  const provider = getPaymentProvider();
  if (!provider.configured) throw new AppError(503, "PAYMENT_PROVIDER_NOT_CONFIGURED", "Online refunds are not configured yet.");
  const found = await provider.findRefund({ paymentId: refund.providerPaymentId, localRefundId: refund.id });
  if (!found && !recoveryOnly) {
    const markDb = await getDatabasePool().connect();
    try {
      await markDb.query("BEGIN");
      const marked = await markFinancialOperationTransmitting(markDb, financialReservation);
      await markDb.query("COMMIT");
      financialReservation = { ...financialReservation, ...marked };
    } catch (error) { await markDb.query("ROLLBACK").catch(() => undefined); throw error; } finally { markDb.release(); }
  }
  const result = found ?? (
    recoveryOnly
      ? (() => { throw new AppError(409, "REFUND_RECOVERY_REQUIRES_REVIEW", "The ambiguous refund reservation could not be located at the provider and remains protected."); })()
      :
    new Date(refund.createdAt).getTime() < Date.now() - 20 * 60 * 60 * 1000
      ? (() => { throw new AppError(409, "REFUND_RECOVERY_REQUIRES_REVIEW", "The refund is outside the safe provider idempotency window and could not be located. Review it before retrying."); })()
      : await provider.createRefund({
        paymentId: refund.providerPaymentId,
        amountCents: cents(refund.amount),
        currency: refund.currency,
        idempotencyKey: refund.idempotencyKey,
        localRefundId: refund.id,
      })
  );
  if (
    result.amountCents !== cents(refund.amount)
    || result.currency !== refund.currency
    || result.paymentId !== refund.providerPaymentId
  ) throw new AppError(409, "REFUND_PROVIDER_FACTS_MISMATCH", "The provider refund facts do not match the locked refund.");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [refund.paymentId]);
    await client.query(
      "UPDATE refunds SET provider_reference=$1,status=$2::refund_status,failure_reason=$3,updated_at=now() WHERE id=$4",
      [result.id, result.status === "succeeded" ? "completed" : result.status === "failed" ? "failed" : "processing", result.failureReason ?? null, refund.id],
    );
    if (result.status === "succeeded") {
      const totals = (await client.query(
        "SELECT p.amount,COALESCE(sum(r.amount) FILTER (WHERE r.status='completed'),0)::text AS refunded FROM payments p LEFT JOIN refunds r ON r.payment_id=p.id WHERE p.id=$1 GROUP BY p.id",
        [refund.paymentId],
      )).rows[0];
      await client.query("UPDATE payments SET status=$1::payment_status,updated_at=now() WHERE id=$2", [cents(totals.refunded) >= cents(totals.amount) ? "refunded" : "partially_refunded", refund.paymentId]);
    }
    await transitionFinancialOperation(client, {
      id: financialReservation.id,
      leaseToken: financialReservation.leaseToken,
      version: financialReservation.version,
      state: result.status === "succeeded" || result.status === "failed" ? "released" : "ambiguous",
      recoveryEvidence: { refundId, providerReference: result.id, status: result.status },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (result.status === "pending") throw new AppError(409, "REFUND_RECOVERY_PENDING", "The provider refund has not reached a terminal state.");
}

async function reconcileExpiredPayment(paymentId: string): Promise<"released" | "finalized" | "pending" | "review" | "skipped"> {
  const lockClient = await getDatabasePool().connect();
  let locked = false;
  let expirationReservation: any;
  try {
    locked = Boolean((await lockClient.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`payment-expiry:${paymentId}`])).rows[0]?.locked);
    if (!locked) return "skipped";
    const payment = (await lockClient.query(
      `SELECT o.id AS "orderId",o.status AS "orderStatus",o.payment_status AS "orderPaymentStatus",o.reservation_expires_at AS "reservationExpiresAt",
              o.currency,p.id AS "paymentId",p.provider_payment_id AS "providerPaymentId",p.idempotency_key AS "idempotencyKey",p.amount,p.status
         FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=$1`,
      [paymentId],
    )).rows[0];
    if (!payment || payment.orderStatus !== "pending" || payment.orderPaymentStatus !== "pending" || !payment.reservationExpiresAt || new Date(payment.reservationExpiresAt) > new Date()) return "skipped";
    const operationReferenceId = `expiration:${paymentId}`;
    const unresolvedReservation = (await lockClient.query(
      `SELECT id,order_id AS "orderId",operation_type AS "operationType",
              operation_reference_id AS "operationReferenceId",state,phase,
              transmission_started_at AS "transmissionStartedAt",
              lease_token AS "leaseToken",lease_until AS "leaseUntil",version
         FROM financial_operation_reservations
        WHERE operation_type='payment_cancellation'
          AND operation_reference_id=$1
          AND (state='ambiguous' OR (state='active' AND phase='transmitting'))
        FOR UPDATE`,
      [operationReferenceId],
    )).rows[0];
    const recoveryOnly = Boolean(unresolvedReservation);
    expirationReservation = unresolvedReservation ?? await acquireFinancialOperation(lockClient, {
      orderId: payment.orderId,
      operationType: "payment_cancellation",
      operationReferenceId,
      leaseSeconds: 300,
      allowReleasedRetry: true,
    });
    const provider = getPaymentProvider();
    if (!provider.configured) {
      if (payment.providerPaymentId) {
        const reason = "The reservation expired while provider reconciliation was unavailable. Inventory remains reserved until the provider payment is verified.";
        await enqueueRecoveryJob({
          operation: "expiration",
          orderId: payment.orderId,
          paymentId,
          retryable: false,
          reason,
        });
        return "review";
      }
      const reason = "The reservation expired before an external provider payment was created.";
      await failPayment(paymentId, "cancelled", reason, true, expirationReservation);
      return "released";
    }
    if (!payment.providerPaymentId) {
      await failPayment(paymentId, "cancelled", "The reservation expired before a Stripe PaymentIntent was created.", true, expirationReservation);
      return "released";
    }
    const current = await provider.retrievePayment(payment.providerPaymentId);
    assertProviderSuccessFacts(current, payment);
    if (current.status === "succeeded") {
      await finalizeSuccess(paymentId, "expiry_reconciliation");
      await transitionFinancialOperation(lockClient, {
        id: expirationReservation.id,
        leaseToken: expirationReservation.leaseToken,
        version: expirationReservation.version,
        state: "released",
        recoveryEvidence: { paymentId, status: "succeeded", providerReadOnly: true },
      });
      return "finalized";
    }
    if (current.status === "cancelled" || current.status === "failed") {
      await failPayment(paymentId, current.status === "failed" ? "failed" : "cancelled", current.failureReason ?? "The payment reservation expired.", true, expirationReservation);
      return "released";
    }
    if (current.status === "processing") {
      await transition(paymentId, "processing");
      if (!recoveryOnly) {
        await transitionFinancialOperation(lockClient, {
          id: expirationReservation.id,
          leaseToken: expirationReservation.leaseToken,
          version: expirationReservation.version,
          state: "released",
          recoveryEvidence: { paymentId, status: "processing", providerReadOnly: true },
        });
      }
      await enqueueRecoveryJob({
        operation: "expiration",
        orderId: payment.orderId,
        paymentId,
        retryable: false,
        reason: "The reservation expired while Stripe still reports the PaymentIntent as processing. Inventory remains reserved for operator review or a signed webhook.",
      });
      return "review";
    }
    if (recoveryOnly) {
      await enqueueRecoveryJob({
        operation: "expiration",
        orderId: payment.orderId,
        paymentId,
        retryable: false,
        reason: `The prior provider cancellation remains unresolved in ${current.status}. The durable financial reservation remains protective pending reconciliation.`,
      });
      return "review";
    }
    const transmitted = await markFinancialOperationTransmitting(lockClient, expirationReservation);
    const outcome = await provider.cancelPayment(payment.providerPaymentId);
    assertProviderSuccessFacts(outcome, payment);
    if (outcome.status === "succeeded") {
      await finalizeSuccess(paymentId, "expiry_reconciliation");
      return "finalized";
    }
    if (outcome.status === "cancelled" || outcome.status === "failed") {
      await failPayment(paymentId, outcome.status === "failed" ? "failed" : "cancelled", outcome.failureReason ?? "The payment reservation expired.", true, { ...expirationReservation, ...transmitted });
      return "released";
    }
    await transition(paymentId, outcome.status, outcome.failureReason);
    await enqueueRecoveryJob({
      operation: "expiration",
      orderId: payment.orderId,
      paymentId,
      retryable: false,
      reason: `Stripe kept the expired PaymentIntent in ${outcome.status} after cancellation. Inventory remains reserved for operator review or a signed webhook.`,
    });
    return "review";
  } catch (error) {
    if (expirationReservation) {
      await transitionFinancialOperation(lockClient, {
        id: expirationReservation.id,
        leaseToken: expirationReservation.leaseToken,
        version: expirationReservation.version,
        state: "ambiguous",
        failureMessage: errorMessage(error),
        recoveryEvidence: { paymentId, expirationReconciliation: true },
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (locked) await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`payment-expiry:${paymentId}`]);
    lockClient.release();
  }
}

export async function expirePaymentReservations(limit = 100) {
  const result = await getDatabasePool().query(
    `SELECT p.id AS "paymentId",p.order_id AS "orderId"
       FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE o.status='pending' AND o.payment_status='pending' AND o.reservation_expires_at <= now()
        AND p.id=(SELECT p2.id FROM payments p2 WHERE p2.order_id=o.id AND p2.status NOT IN ('paid','refunded','partially_refunded') ORDER BY p2.created_at DESC LIMIT 1)
        AND NOT EXISTS (
          SELECT 1 FROM payment_recovery_jobs j
           WHERE j.payment_id=p.id AND j.operation='expiration'
             AND (j.status IN ('pending','processing','failed') OR j.retryable=false)
        )
      ORDER BY o.reservation_expires_at LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  let released = 0;
  let finalized = 0;
  let failed = 0;
  for (const payment of result.rows) {
    try {
      const outcome = await reconcileExpiredPayment(payment.paymentId);
      if (outcome === "released") released += 1;
      if (outcome === "finalized") finalized += 1;
      if (outcome === "review") failed += 1;
      await recordRecoveryAttempt({
        paymentId: payment.paymentId,
        source: "expiration_scan",
        status: outcome === "review" || outcome === "pending" ? "failed" : outcome === "skipped" ? "skipped" : "succeeded",
        attemptNumber: 1,
        failureReason: outcome === "review" ? "The expired payment requires operator review; automatic expiration recovery has stopped." : undefined,
      });
    } catch (error) {
      failed += 1;
      await recordRecoveryAttempt({ paymentId: payment.paymentId, source: "expiration_scan", status: "failed", attemptNumber: 1, failureReason: errorMessage(error) });
      try {
        const code = error instanceof AppError ? error.code : undefined;
        await enqueueRecoveryJob({
          operation: "expiration",
          orderId: payment.orderId,
          paymentId: payment.paymentId,
          retryable: code === "PAYMENT_PROVIDER_FACTS_MISMATCH" || code === "FINANCIAL_OPERATION_AMBIGUOUS" ? false : undefined,
          reason: errorMessage(error),
        });
      } catch (queueError) {
        logger.error("expiration recovery could not be queued", { paymentId: payment.paymentId, error: errorMessage(queueError) });
      }
      logger.warn("payment expiration reconciliation failed", { paymentId: payment.paymentId, error: errorMessage(error) });
    }
  }
  return { released, finalized, failed };
}

export async function runPaymentRecovery(limit = 100) {
  const jobs = await claimRecoveryJobs(limit);
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      if (job.operation === "webhook") {
        if (!job.providerEventId || !job.eventType || !job.payload) throw new AppError(409, "RECOVERY_PAYLOAD_MISSING", "The stored webhook recovery payload is incomplete.");
        await processWebhookPayload(job.payload, job.providerEventId, job.eventType);
      } else if (job.operation === "payment_creation") {
        await recoverPaymentCreation(job.paymentId);
      } else if (job.operation === "payment_status") {
        await recoverPaymentStatus(job.paymentId);
      } else if (job.operation === "payment_invalidation") {
        await recoverInvalidatedPayment(job.paymentId);
      } else if (job.operation === "expiration") {
        const outcome = await reconcileExpiredPayment(job.paymentId);
        if (outcome === "pending") throw new AppError(409, "PAYMENT_RECOVERY_PENDING", "The provider cancellation has not reached a terminal state.");
        if (outcome === "review") throw new AppError(409, "PAYMENT_EXPIRATION_REQUIRES_REVIEW", "The expired provider payment requires operator review; automatic recovery has stopped.");
        if (outcome === "skipped") throw new AppError(409, "PAYMENT_RECOVERY_BUSY", "Another worker is reconciling this payment.");
      } else if (job.operation === "refund") {
        await recoverRefund(job.refundId);
      } else {
        throw new AppError(409, "RECOVERY_OPERATION_INVALID", "The recovery operation is invalid.");
      }
      const completed = await getDatabasePool().query(
        "UPDATE payment_recovery_jobs SET status='succeeded',completed_at=COALESCE(completed_at,now()),locked_at=NULL,lock_token=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lock_token=$2",
        [job.id, job.lockToken],
      );
      if (completed.rowCount) {
        await recordRecoveryAttempt({ paymentId: job.paymentId, source: job.operation, status: "succeeded", attemptNumber: Number(job.attempts), jobId: job.id });
        succeeded += 1;
      }
    } catch (error) {
      if (await failRecoveryJob(job.id, job.lockToken, Number(job.attempts), error)) {
        await recordRecoveryAttempt({ paymentId: job.paymentId, source: job.operation, status: "failed", attemptNumber: Number(job.attempts), failureReason: errorMessage(error), jobId: job.id });
        failed += 1;
      }
    }
  }
  return { claimed: jobs.length, succeeded, failed };
}

export async function queueStuckPaymentRecoveries(limit = 100) {
  const batchSize = Math.min(500, Math.max(1, limit));
  const payments = await getDatabasePool().query(
    `INSERT INTO payment_recovery_jobs (order_id,payment_id,operation,last_error,next_attempt_at)
     SELECT p.order_id,p.id,'payment_status','A provider payment remained non-terminal without a recent webhook.',now()
       FROM payments p
      WHERE p.provider_payment_id IS NOT NULL
        AND p.status IN ('pending','requires_action','processing','authorized','failed')
        AND p.updated_at < now() - interval '10 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM payment_recovery_jobs j
           WHERE j.payment_id=p.id AND j.operation='payment_status' AND j.updated_at > now() - interval '10 minutes'
        )
      ORDER BY p.updated_at
      LIMIT $1
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [batchSize],
  );
  const refunds = await getDatabasePool().query(
    `INSERT INTO payment_recovery_jobs (order_id,payment_id,refund_id,operation,last_error,next_attempt_at)
     SELECT r.order_id,r.payment_id,r.id,'refund','A provider refund remained non-terminal without a recent webhook.',now()
       FROM refunds r
      WHERE r.status IN ('pending','processing')
        AND r.updated_at < now() - interval '10 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM payment_recovery_jobs j
           WHERE j.refund_id=r.id AND j.operation='refund' AND j.updated_at > now() - interval '10 minutes'
        )
      ORDER BY r.updated_at
      LIMIT $1
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [batchSize],
  );
  return { queued: (payments.rowCount ?? 0) + (refunds.rowCount ?? 0) };
}

export async function listPaymentRecovery(filters: { status?: string; operation?: string; page?: number; pageSize?: number } = {}) {
  const values: unknown[] = [];
  const clauses = ["1=1"];
  if (filters.status) { values.push(filters.status); clauses.push(`j.status=$${values.length}`); }
  if (filters.operation) { values.push(filters.operation); clauses.push(`j.operation=$${values.length}`); }
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  const count = await getDatabasePool().query(`SELECT count(*)::text AS count FROM payment_recovery_jobs j WHERE ${clauses.join(" AND ")}`, values);
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await getDatabasePool().query(
    `SELECT j.id,j.operation,j.status,j.retryable,j.attempts,j.last_error AS "lastError",j.next_attempt_at AS "nextAttemptAt",
            j.last_attempt_at AS "lastAttemptAt",j.completed_at AS "completedAt",j.created_at AS "createdAt",
            j.order_id AS "orderId",o.order_number AS "orderNumber",j.payment_id AS "paymentId",p.status AS "paymentStatus",
            j.refund_id AS "refundId",r.status AS "refundStatus",j.provider_event_id AS "providerEventId",j.event_type AS "eventType"
       FROM payment_recovery_jobs j
       LEFT JOIN orders o ON o.id=j.order_id
       LEFT JOIN payments p ON p.id=j.payment_id
       LEFT JOIN refunds r ON r.id=j.refund_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY CASE WHEN j.status='failed' THEN 0 WHEN j.status='pending' THEN 1 ELSE 2 END,j.next_attempt_at,j.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = Number(count.rows[0]?.count ?? 0);
  const stuck = await getDatabasePool().query(
    `SELECT 'payment' AS type,p.id,p.order_id AS "orderId",o.order_number AS "orderNumber",p.status::text AS status,p.failure_reason AS "failureReason",p.updated_at AS "updatedAt"
       FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE p.status IN ('pending','requires_action','processing','authorized','failed') AND p.updated_at < now() - interval '10 minutes'
     UNION ALL
     SELECT 'refund' AS type,r.id,r.order_id AS "orderId",o.order_number AS "orderNumber",r.status::text AS status,r.failure_reason AS "failureReason",r.updated_at AS "updatedAt"
       FROM refunds r JOIN orders o ON o.id=r.order_id
      WHERE r.status IN ('pending','processing','failed') AND r.updated_at < now() - interval '10 minutes'
      ORDER BY "updatedAt"`,
  );
  return {
    items: rows.rows,
    stuck: stuck.rows,
    meta: { page, pageSize, total, hasNext: (page - 1) * pageSize + rows.rows.length < total },
    config: {
      enabled: databaseConfigured,
      intervalSeconds: env.PAYMENT_RECOVERY_INTERVAL_SECONDS,
      maxRetries: env.PAYMENT_RECOVERY_MAX_RETRIES,
      providerConfigured: getPaymentProvider().configured,
    },
  };
}

export async function retryPaymentRecovery(jobId: string) {
  const result = await getDatabasePool().query(
    `UPDATE payment_recovery_jobs
        SET status='pending',next_attempt_at=now(),locked_at=NULL,lock_token=NULL,completed_at=NULL,updated_at=now()
      WHERE id=$1 AND retryable=true AND attempts < $2 AND status <> 'processing'
      RETURNING id,operation,status,attempts,next_attempt_at AS "nextAttemptAt"`,
    [jobId, env.PAYMENT_RECOVERY_MAX_RETRIES],
  );
  if (!result.rowCount) {
    const existing = (await getDatabasePool().query("SELECT status,retryable,attempts FROM payment_recovery_jobs WHERE id=$1", [jobId])).rows[0];
    if (existing?.status === "processing") throw new AppError(409, "PAYMENT_RECOVERY_ACTIVE", "An active recovery attempt cannot be retried.");
    if (existing) throw new AppError(409, "PAYMENT_RECOVERY_REVIEW_REQUIRED", "This recovery reached its automatic retry or integrity limit and cannot be re-armed.");
    throw new AppError(404, "PAYMENT_RECOVERY_NOT_FOUND", "The payment recovery record was not found.");
  }
  return result.rows[0];
}

export async function queuePaymentReconciliation(paymentId: string) {
  const payment = (await getDatabasePool().query(
    `SELECT p.id,p.order_id AS "orderId",p.provider_payment_id AS "providerPaymentId",p.status,
            o.status AS "orderStatus",o.payment_status AS "orderPaymentStatus",o.reservation_expires_at AS "reservationExpiresAt"
       FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=$1`,
    [paymentId],
  )).rows[0];
  if (!payment) throw new AppError(404, "PAYMENT_NOT_FOUND", "The payment was not found.");
  if (["paid", "cancelled", "refunded", "partially_refunded"].includes(payment.status)) throw new AppError(409, "PAYMENT_RECOVERY_NOT_NEEDED", "This payment is already terminal.");
  const expired = payment.orderStatus === "pending" && payment.orderPaymentStatus === "pending" && payment.reservationExpiresAt && new Date(payment.reservationExpiresAt) <= new Date();
  const operation: RecoveryOperation = payment.providerPaymentId ? "payment_status" : expired ? "expiration" : "payment_creation";
  if (operation === "payment_status") {
    const resumed = await getDatabasePool().query(
      `UPDATE payment_recovery_jobs
          SET status='pending',retryable=true,next_attempt_at=now(),completed_at=NULL,updated_at=now()
        WHERE payment_id=$1 AND operation='payment_status' AND status='failed' AND retryable=false AND attempts=0
          AND last_error LIKE 'The reservation expired while provider reconciliation was unavailable.%'
        RETURNING id,operation,status,attempts,next_attempt_at AS "nextAttemptAt"`,
      [paymentId],
    );
    if (resumed.rowCount) return resumed.rows[0];
  }
  await enqueueRecoveryJob({ operation, orderId: payment.orderId, paymentId, reason: "An operator requested payment reconciliation." });
  return (await getDatabasePool().query(
    `SELECT id,operation,status,attempts,next_attempt_at AS "nextAttemptAt"
       FROM payment_recovery_jobs WHERE payment_id=$1 AND operation=$2 AND status IN ('pending','processing','failed')
       ORDER BY created_at DESC LIMIT 1`,
    [paymentId, operation],
  )).rows[0];
}

export async function queueRefundReconciliation(refundId: string) {
  const refund = (await getDatabasePool().query(
    "SELECT id,order_id AS \"orderId\",payment_id AS \"paymentId\",status FROM refunds WHERE id=$1",
    [refundId],
  )).rows[0];
  if (!refund) throw new AppError(404, "REFUND_NOT_FOUND", "The refund was not found.");
  if (["completed", "cancelled"].includes(refund.status)) throw new AppError(409, "REFUND_RECOVERY_NOT_NEEDED", "This refund is already terminal.");
  await enqueueRecoveryJob({ operation: "refund", orderId: refund.orderId, paymentId: refund.paymentId, refundId, reason: "An operator requested refund reconciliation." });
  return (await getDatabasePool().query(
    `SELECT id,operation,status,attempts,next_attempt_at AS "nextAttemptAt"
       FROM payment_recovery_jobs WHERE refund_id=$1 AND operation='refund' AND status IN ('pending','processing','failed')
       ORDER BY created_at DESC LIMIT 1`,
    [refundId],
  )).rows[0];
}