import { createHash, randomUUID } from "node:crypto";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { TooniesError, type TooniesClient } from "./toonies.js";
import { getTooniesClient } from "./toonies-service.js";
import { assertTooniesSettlementEnabled } from "./toonies-procurement-gate.js";
import { loadTooniesSupplierSnapshotFingerprint } from "./toonies-snapshot.js";
import { acquireFinancialOperation, markFinancialOperationTransmitting, transitionFinancialOperation, pauseAfterFinancialOperationReservation } from "../financial/operation-reservation.js";

type SettlementState = "not_submitted" | "submitting" | "transmitted_unknown" | "reconciling" | "replay_pending" | "confirmed" | "documented_rejection" | "manual_review";
const unresolved: SettlementState[] = ["submitting", "transmitted_unknown", "reconciling", "replay_pending", "manual_review"];

let settlementTestPauseAfterResponse: (() => Promise<void>) | undefined;

/** Test-only barrier used to deterministically exercise a worker returning
 * from the supplier after its settlement lease has been recovered. */
export function setTooniesSettlementTestPauseAfterResponse(pause: (() => Promise<void>) | undefined): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Settlement pause seam is test-only.");
  settlementTestPauseAfterResponse = pause;
}

/** Customer-side cancellation/refund/order mutation must not race supplier
 * financial settlement. Call from the same transaction that mutates payment
 * or order state. */
export async function assertTooniesSettlementMutationAllowed(db: { query: (...args: any[]) => Promise<any> }, orderId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [orderId]);
  await db.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE /* toonies-settlement-order-first */", [orderId]);
  await db.query("SELECT id FROM payments WHERE order_id=$1 ORDER BY id FOR UPDATE", [orderId]);
  await db.query("SELECT id FROM toonies_procurement_commands WHERE order_id=$1 FOR UPDATE", [orderId]);
  await db.query("SELECT id FROM toonies_procurement_attempts WHERE order_id=$1 ORDER BY generation FOR UPDATE", [orderId]);
  await db.query("SELECT id FROM toonies_settlements WHERE order_id=$1 ORDER BY generation FOR UPDATE", [orderId]);
  const row = (await db.query(
    `SELECT state FROM toonies_settlements
      WHERE order_id=$1 AND state IN ('submitting','transmitted_unknown','reconciling','replay_pending','confirmed','manual_review')
      LIMIT 1 FOR UPDATE`, [orderId],
  )).rows[0];
  if (row) throw new AppError(409, "TOONIES_SETTLEMENT_MUTATION_BLOCKED", "This order has a supplier settlement that must be resolved before cancellation or refund.");
}

async function lockSettlementOrder(db: { query: (...args: any[]) => Promise<any> }, settlementId: string): Promise<string> {
  const identity = (await db.query("SELECT order_id AS \"orderId\" FROM toonies_settlements WHERE id=$1", [settlementId])).rows[0];
  if (!identity) throw new AppError(404, "TOONIES_SETTLEMENT_NOT_FOUND", "The settlement was not found.");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [identity.orderId]);
  await db.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [identity.orderId]);
  await db.query("SELECT id FROM payments WHERE order_id=$1 ORDER BY id FOR UPDATE", [identity.orderId]);
  await db.query("SELECT id FROM toonies_procurement_commands WHERE order_id=$1 FOR UPDATE", [identity.orderId]);
  await db.query("SELECT id FROM toonies_procurement_attempts WHERE order_id=$1 ORDER BY generation FOR UPDATE", [identity.orderId]);
  await db.query("SELECT id FROM toonies_settlements WHERE order_id=$1 ORDER BY generation FOR UPDATE", [identity.orderId]);
  return identity.orderId;
}

function sha(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    return input;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}
function apiOrderSn(orderId: string, generation: number): string {
  const value = `lz_${orderId.replaceAll("-", "")}_g${generation.toString(36)}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new AppError(500, "TOONIES_SETTLEMENT_ID_INVALID", "The settlement identity could not be allocated.");
  return value;
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function amount(value: unknown): string {
  const valueText = typeof value === "number" ? String(value) : text(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(valueText)) throw new AppError(502, "TOONIES_SETTLEMENT_AMOUNT_INVALID", "The supplier returned an invalid monetary amount.");
  const normalized = valueText.includes(".") ? valueText.replace(/0+$/, "").replace(/\.$/, "") : valueText;
  if ((normalized.split(".")[1]?.length ?? 0) > 6) throw new AppError(502, "TOONIES_SETTLEMENT_AMOUNT_INVALID", "The supplier returned an invalid monetary amount.");
  return normalized;
}
function decimalAdd(left: string, right: string): string {
  const [lw, lf = ""] = left.split(".");
  const [rw, rf = ""] = right.split(".");
  const scale = Math.max(lf.length, rf.length);
  const l = BigInt(`${lw}${lf.padEnd(scale, "0")}`);
  const r = BigInt(`${rw}${rf.padEnd(scale, "0")}`);
  const total = (l + r).toString().padStart(scale + 1, "0");
  if (!scale) return total;
  return `${total.slice(0, -scale)}.${total.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "");
}
function decimalSubtract(left: string, right: string): string {
  const [lw, lf = ""] = left.split(".");
  const [rw, rf = ""] = right.split(".");
  const scale = Math.max(lf.length, rf.length);
  const l = BigInt(`${lw}${lf.padEnd(scale, "0")}`);
  const r = BigInt(`${rw}${rf.padEnd(scale, "0")}`);
  const total = l - r;
  const sign = total < 0n ? "-" : "";
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  if (!scale) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "");
}
function decimalMultiply(left: string, quantity: number): string {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new AppError(409, "TOONIES_SETTLEMENT_QUANTITY_INVALID", "The settlement quantity is invalid.");
  let result = "0";
  for (let index = 0; index < quantity; index += 1) result = decimalAdd(result, left);
  return result;
}
function evidence(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json.length <= 100_000 ? value : { truncated: true, sha256: sha(json), preview: json.slice(0, 98_000) };
}
function stateError(code: number, message: string): never {
  throw new AppError(502, `TOONIES_SETTLEMENT_${code}`, message, { supplierCode: code, settlementUnknown: true });
}

function addressFields(snapshot: any, email: string) {
  const value = snapshot ?? {};
  const consignee = text(value.consignee ?? [value.firstName, value.lastName].filter(Boolean).join(" "));
  return {
    consignee,
    phone: text(value.phone),
    country_code: text(value.countryCode ?? value.country_code).toUpperCase(),
    province: text(value.province ?? value.region),
    city: text(value.city),
    address: text(value.address ?? [value.addressLine1, value.addressLine2].filter(Boolean).join(", ")),
    postcode: text(value.postcode ?? value.postalCode),
    email: text(value.email ?? email),
  };
}

function validateResponse(data: any, expected: { taskId: string; apiOrderSn: string; basket: any[]; productSum: string }) {
  if (!data || typeof data !== "object" || !text(data.order_sn) || text(data.api_order_sn) !== expected.apiOrderSn) {
    stateError(50001, "The supplier returned an invalid settlement identity.");
  }
  if (data.api_task_id !== undefined && text(data.api_task_id) !== expected.taskId) stateError(50001, "The supplier returned a different task identity.");
  if (String(data.currency ?? "") !== "CNY") stateError(50001, "The supplier settlement currency was not CNY.");
  const productSum = amount(data.product_sum);
  const shipping = amount(data.shipping_fee);
  const total = amount(data.sum);
  if (productSum !== expected.productSum || shipping !== "0" || total !== productSum) stateError(50001, "The supplier returned contradictory settlement amounts.");
  if (!Array.isArray(data.items) || data.items.length !== expected.basket.length || (data.skipped_items?.length ?? 0) !== 0) {
    stateError(50001, "The supplier returned an incomplete settlement basket.");
  }
  const expectedKeys = new Set(expected.basket.map((line) => `${line.productCode}\u0000${line.skuCode}\u0000${line.quantity}`));
  const seenKeys = new Set<string>();
  for (const item of data.items) {
    const key = `${item?.product_code}\u0000${item?.sku_code}\u0000${item?.num}`;
    if (seenKeys.has(key) || !expectedKeys.has(key)) stateError(50001, "The supplier returned an unexpected or duplicate settlement item.");
    seenKeys.add(key);
  }
  if (seenKeys.size !== expectedKeys.size) stateError(50001, "The supplier omitted a settlement item.");
  if (!["paid", "success", "created", "completed"].includes(String(data.pay_status ?? "").toLowerCase())
    || !["paid", "success", "created", "completed"].includes(String(data.status ?? "").toLowerCase())) {
    stateError(50001, "The supplier did not return documented successful settlement states.");
  }
  return { productSum, shipping, total };
}

async function recordEvidence(db: any, settlementId: string, eventType: string, fromState: string | null, toState: string | null, details: unknown, requestHash?: string, responseHash?: string, errorCode?: number) {
  await db.query(
    `INSERT INTO toonies_settlement_evidence(settlement_id,event_type,from_state,to_state,request_hash,response_hash,error_code,details)
     VALUES($1,$2,$3::toonies_settlement_state,$4::toonies_settlement_state,$5,$6,$7,$8)`,
    [settlementId, eventType, fromState, toState, requestHash ?? null, responseHash ?? null, errorCode ?? null, details ?? null],
  );
}

/** Re-read and lock both authoritative order lines and the procurement lines
 * immediately before ownership CAS. Mutable catalogue/order changes cannot
 * silently authorize a different supplier basket. */
async function authorizeSettlementLines(db: any, auth: any): Promise<void> {
  const rows = (await db.query(
    `SELECT l.product_code AS "productCode",l.sku_code AS "skuCode",l.requested_quantity AS quantity,
             l.returned_charge_cny AS charge,l.returned_subtotal_cny AS subtotal,l.returned_moq AS moq,
            l.returned_stock AS stock,l.orderable,l.product_id AS "lineProductId",l.variant_id AS "lineVariantId",
             l.expected_unit_cost_cny AS "expectedUnitCost",l.expected_subtotal_cny AS "expectedSubtotal",
             l.cost_threshold_percent AS "costThresholdPercent",l.returned_cost_variance_cny AS "returnedCostVariance",
            l.catalogue_item_id AS "lineCatalogueItemId",l.catalogue_variant_id AS "lineCatalogueVariantId",
            oi.product_id AS "orderProductId",oi.variant_id AS "orderVariantId",
            oi.supplier_product_link_id AS "linkId",oi.supplier_id AS "orderSupplierId",
            oi.supplier_catalogue_item_id AS "orderCatalogueItemId",
            oi.supplier_catalogue_variant_id AS "orderCatalogueVariantId",
            oi.supplier_product_code AS "orderProductCode",oi.supplier_sku_code AS "orderSkuCode",
            oi.quantity AS "orderQuantity"
       FROM toonies_procurement_lines l
       JOIN order_items oi ON oi.order_id=$1
         AND oi.supplier_product_code=l.product_code AND oi.supplier_sku_code=l.sku_code
      WHERE l.attempt_id=$2
      ORDER BY l.product_code,l.sku_code
      FOR UPDATE OF l,oi`, [auth.order_id, auth.attempt_id],
  )).rows;
  const canonical = Array.isArray(auth.canonical_basket) ? auth.canonical_basket : [];
  if (!rows.length || rows.length !== canonical.length) throw new AppError(409, "TOONIES_SETTLEMENT_BASKET_AUTHORIZATION_FAILED", "The authoritative settlement basket is incomplete.");
  const expected = new Set<string>();
  for (const line of canonical) {
    const key = `${line.productCode}\u0000${line.skuCode}`;
    if (expected.has(key)) throw new AppError(409, "TOONIES_SETTLEMENT_BASKET_DUPLICATE", "The persisted settlement basket contains duplicate lines.");
    expected.add(key);
  }
  const seen = new Set<string>();
  let productSum = "0";
  for (const row of rows) {
    const key = `${row.productCode}\u0000${row.skuCode}`;
    if (seen.has(key) || !expected.has(key) || row.orderProductId !== row.lineProductId
      || row.orderVariantId !== row.lineVariantId || row.orderCatalogueItemId !== row.lineCatalogueItemId
      || row.orderCatalogueVariantId !== row.lineCatalogueVariantId || row.orderProductCode !== row.productCode
      || row.orderSkuCode !== row.skuCode || row.orderQuantity !== row.quantity
      || row.orderSupplierId !== auth.supplier_id || row.orderQuantity <= 0
      || row.orderable !== true || row.stock === null || row.moq === null
      || row.quantity < row.moq || row.quantity > row.stock) {
      throw new AppError(409, "TOONIES_SETTLEMENT_BASKET_AUTHORIZATION_FAILED", "The authoritative order and procurement lines no longer match.");
    }
    const charge = amount(row.charge);
    const subtotal = amount(row.subtotal);
    const expectedSubtotal = decimalMultiply(amount(row.expectedUnitCost ?? charge), row.quantity);
    const variance = decimalSubtract(subtotal, expectedSubtotal);
    if (decimalMultiply(charge, row.quantity) !== subtotal
      || (row.expectedUnitCost !== null && amount(row.expectedUnitCost) !== charge)
      || (row.expectedSubtotal !== null && amount(row.expectedSubtotal) !== subtotal)
      || (row.returnedCostVariance !== null && amount(row.returnedCostVariance) !== amount(variance))) {
      throw new AppError(409, "TOONIES_SETTLEMENT_SUBTOTAL_MISMATCH", "The supplier charge and subtotal do not match exactly.");
    }
    const canonicalLine = canonical.find((line: any) => `${line.productCode}\u0000${line.skuCode}` === key);
    if (!canonicalLine || canonicalLine.quantity !== row.quantity || amount(canonicalLine.charge) !== charge
      || amount(canonicalLine.subtotal) !== subtotal || canonicalLine.productId !== row.lineProductId
      || canonicalLine.variantId !== row.lineVariantId || canonicalLine.linkId !== row.linkId
      || canonicalLine.catalogueItemId !== row.lineCatalogueItemId || canonicalLine.catalogueVariantId !== row.lineCatalogueVariantId
      || canonicalLine.moq !== row.moq || canonicalLine.stock !== row.stock) {
      throw new AppError(409, "TOONIES_SETTLEMENT_CANONICAL_BASKET_MISMATCH", "The immutable settlement basket no longer matches authoritative order facts.");
    }
    seen.add(key);
    productSum = decimalAdd(productSum, subtotal);
  }
  if (seen.size !== expected.size || amount(auth.expected_product_sum) !== productSum || amount(auth.expected_shipping_fee) !== "0"
    || amount(auth.expected_total_sum) !== productSum) {
    throw new AppError(409, "TOONIES_SETTLEMENT_TOTAL_MISMATCH", "The persisted settlement totals do not match exact line arithmetic.");
  }
}

async function loadOrCreateSettlement(attemptId: string) {
  const pool = getDatabasePool();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const attemptIdentity = (await db.query("SELECT order_id AS \"orderId\" FROM toonies_procurement_attempts WHERE id=$1", [attemptId])).rows[0];
    if (!attemptIdentity) throw new AppError(404, "TOONIES_ATTEMPT_NOT_FOUND", "The procurement attempt was not found.");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [attemptIdentity.orderId]);
    await db.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [attemptIdentity.orderId]);
    await db.query("SELECT id FROM payments WHERE order_id=$1 ORDER BY id FOR UPDATE", [attemptIdentity.orderId]);
    await db.query("SELECT id FROM toonies_procurement_commands WHERE order_id=$1 FOR UPDATE", [attemptIdentity.orderId]);
    await db.query("SELECT id FROM toonies_procurement_attempts WHERE order_id=$1 ORDER BY generation FOR UPDATE", [attemptIdentity.orderId]);
    await db.query("SELECT id FROM toonies_settlements WHERE order_id=$1 ORDER BY generation FOR UPDATE", [attemptIdentity.orderId]);
    // Recovery is authority-driven: once allocated, never rebuild identity
    // from a mutable/current procurement attempt.
    const persisted = (await db.query<any>("SELECT * FROM toonies_settlements WHERE attempt_id=$1 ORDER BY generation DESC LIMIT 1 FOR UPDATE", [attemptId])).rows[0];
    if (persisted) {
      if (persisted.request_hash !== sha(persisted.canonical_request)
        || persisted.basket_fingerprint !== sha(persisted.canonical_basket)) {
        throw new AppError(500, "TOONIES_SETTLEMENT_AUTHORITY_CORRUPT", "The persisted settlement authority failed its integrity checks.");
      }
      await db.query("COMMIT");
      return {
        ...persisted,
        request: persisted.canonical_request,
        basket: persisted.canonical_basket,
        productSum: amount(persisted.expected_product_sum),
      };
    }
    const attempt = (await db.query<any>(
      `SELECT a.id,a.order_id AS "orderId",a.supplier_id AS "supplierId",a.generation,a.task_id AS "taskId",
              a.state,a.snapshot_expires_at AS "snapshotExpiresAt",c.id AS "commandId",
              c.order_total_fingerprint AS "orderTotalFingerprint",c.supplier_snapshot_fingerprint AS "supplierSnapshotFingerprint",
              o.total_fingerprint AS "currentOrderTotalFingerprint",o.shipping_address_snapshot AS "shippingAddress",
              o.payment_status AS "paymentStatus",o.currency AS "orderCurrency",o.grand_total AS "grandTotal",
              p.amount AS "paidAmount",p.currency AS "paidCurrency",p.provider_payment_id AS "providerPaymentId",
              COALESCE(o.guest_email,u.email) AS email
         FROM toonies_procurement_attempts a
         JOIN toonies_procurement_commands c ON c.order_id=a.order_id
         JOIN orders o ON o.id=a.order_id
         JOIN payments p ON p.order_id=o.id AND p.status='paid'
         LEFT JOIN users u ON u.id=o.user_id
         WHERE a.id=$1 FOR UPDATE OF a,c,o,p`, [attemptId],
    )).rows[0];
    if (!attempt || attempt.state !== "ready" || !attempt.taskId || !attempt.orderId) throw new AppError(409, "TOONIES_SETTLEMENT_NOT_READY", "Only a paid, ready Toonies attempt can be settled.");
    if (!attempt.snapshotExpiresAt || new Date(attempt.snapshotExpiresAt).getTime() <= Date.now()) throw new AppError(409, "TOONIES_SETTLEMENT_SNAPSHOT_EXPIRED", "The ready Toonies snapshot has expired.");
    if (attempt.paymentStatus !== "paid" || attempt.orderCurrency !== "EUR" || attempt.paidCurrency !== "EUR"
      || !attempt.providerPaymentId || String(attempt.paidAmount) !== String(attempt.grandTotal)
      || !attempt.currentOrderTotalFingerprint || attempt.currentOrderTotalFingerprint !== attempt.orderTotalFingerprint) {
      throw new AppError(409, "TOONIES_SETTLEMENT_PAYMENT_INVALID", "The paid order is no longer financially authorized for settlement.");
    }
    const currentSupplierFingerprint = await loadTooniesSupplierSnapshotFingerprint(db, attempt.orderId);
    if (!currentSupplierFingerprint || currentSupplierFingerprint !== attempt.supplierSnapshotFingerprint) {
      throw new AppError(409, "TOONIES_SETTLEMENT_SNAPSHOT_INVALID", "The immutable supplier snapshot no longer matches the settlement authorization.");
    }
    const lines = (await db.query<any>(
      `SELECT product_code AS "productCode",sku_code AS "skuCode",requested_quantity AS quantity,
              returned_charge_cny AS charge,returned_subtotal_cny AS subtotal,returned_moq AS moq,
              returned_stock AS stock,orderable,product_id AS "productId",variant_id AS "variantId",
              catalogue_item_id AS "catalogueItemId",catalogue_variant_id AS "catalogueVariantId"
         FROM toonies_procurement_lines WHERE attempt_id=$1 ORDER BY id`, [attemptId],
    )).rows;
    if (!lines.length || lines.some((line) => line.orderable !== true || !line.charge || !line.subtotal)) throw new AppError(409, "TOONIES_SETTLEMENT_BASKET_INVALID", "The ready Toonies basket is incomplete.");
    const productSum = lines.reduce((sum, line) => decimalAdd(sum, amount(line.subtotal)), "0");
    const destination = addressFields(attempt.shippingAddress, attempt.email);
    if (Object.values(destination).some((value) => !value)) throw new AppError(409, "TOONIES_SETTLEMENT_ADDRESS_INVALID", "The order destination is incomplete.");
    const destinationFingerprint = sha(destination);
    const request = { task_id: attempt.taskId, api_order_sn: apiOrderSn(attempt.orderId, Number(attempt.generation)), ...destination };
    const requestHash = sha(request);
    const orderLinks = (await db.query<any>(
      `SELECT supplier_product_code AS "productCode",supplier_sku_code AS "skuCode",
              supplier_product_link_id AS "linkId"
         FROM order_items WHERE order_id=$1`, [attempt.orderId],
    )).rows;
    const canonicalBasket = lines.map((line) => ({
      ...line,
      charge: amount(line.charge),
      subtotal: amount(line.subtotal),
      linkId: orderLinks.find((item) => item.productCode === line.productCode && item.skuCode === line.skuCode)?.linkId ?? null,
    }));
    const inserted = (await db.query<any>(
       `INSERT INTO toonies_settlements(order_id,command_id,attempt_id,supplier_id,generation,task_id,api_order_sn,canonical_request,canonical_basket,expected_product_sum,expected_shipping_fee,expected_total_sum,request_hash,basket_fingerprint,destination_fingerprint,order_total_fingerprint,supplier_snapshot_fingerprint,reconciliation_source,reconciliation_date_start,reconciliation_date_end)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'api',now()-interval '30 days',now()) RETURNING *`,
      [attempt.orderId, attempt.commandId, attemptId, attempt.supplierId, attempt.generation, attempt.taskId, request.api_order_sn, JSON.stringify(request), JSON.stringify(canonicalBasket), productSum, "0", productSum, requestHash, sha(canonicalBasket), destinationFingerprint, attempt.currentOrderTotalFingerprint ?? attempt.orderTotalFingerprint, attempt.supplierSnapshotFingerprint],
    )).rows[0];
    await recordEvidence(db, inserted.id, "settlement_created", null, "not_submitted", { basketFingerprint: sha(canonicalBasket), destinationFingerprint }, requestHash);
    await db.query("COMMIT");
    return { ...inserted, request, basket: canonicalBasket, productSum };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

async function transmit(settlement: any, client: TooniesClient) {
  const pool = getDatabasePool();
  const token = randomUUID();
  const db = await pool.connect();
  let claim: any;
  let financialReservation: any;
  try {
    await db.query("BEGIN");
    // Every supplier submission uses the same order-first lock sequence as
    // customer-side refund/cancellation mutations.
    await lockSettlementOrder(db, settlement.id);
    const auth = (await db.query<any>(
      `SELECT s.*,a.state AS attempt_state,a.task_id AS attempt_task_id,a.snapshot_expires_at,
              (SELECT max(latest.generation) FROM toonies_procurement_attempts latest WHERE latest.order_id=s.order_id) AS latest_generation,
              c.id AS current_command_id,c.state AS command_state,c.order_total_fingerprint AS command_total_fingerprint,
              c.supplier_snapshot_fingerprint AS command_supplier_fingerprint,
              o.payment_status,o.total_fingerprint,o.shipping_address_snapshot,o.guest_email,o.currency AS order_currency,o.grand_total,
              p.amount AS paid_amount,p.currency AS paid_currency,p.provider_payment_id,
              p.order_total_fingerprint AS payment_order_total_fingerprint,
              EXISTS(SELECT 1 FROM refunds r WHERE r.order_id=o.id AND r.status IN ('pending','processing','completed')) AS has_refund
         FROM toonies_settlements s
         JOIN toonies_procurement_attempts a ON a.id=s.attempt_id
         JOIN toonies_procurement_commands c ON c.id=s.command_id
         JOIN orders o ON o.id=s.order_id
         JOIN payments p ON p.order_id=o.id AND p.status='paid'
        WHERE s.id=$1
         `, [settlement.id],
    )).rows[0];
    const currentSupplierFingerprint = auth ? await loadTooniesSupplierSnapshotFingerprint(db, auth.order_id) : null;
    const authorizationChecks = auth ? {
      settlementState: ["not_submitted", "replay_pending"].includes(auth.state),
      attemptIdentity: auth.attempt_state === "ready" && auth.attempt_task_id === auth.task_id,
      snapshotCurrent: Boolean(auth.snapshot_expires_at) && new Date(auth.snapshot_expires_at).getTime() > Date.now(),
      commandAuthority: auth.current_command_id === auth.command_id && auth.command_state === "completed",
      generationCurrent: auth.latest_generation === auth.generation,
      paymentIdentity: auth.payment_status === "paid" && auth.order_currency === "EUR" && auth.paid_currency === "EUR" && Boolean(auth.provider_payment_id),
      paymentAmount: String(auth.paid_amount) === String(auth.grand_total),
      totalFingerprints: auth.total_fingerprint === auth.order_total_fingerprint
        && auth.payment_order_total_fingerprint === auth.order_total_fingerprint
        && auth.command_total_fingerprint === auth.order_total_fingerprint,
      supplierFingerprints: auth.command_supplier_fingerprint === auth.supplier_snapshot_fingerprint
        && currentSupplierFingerprint === auth.supplier_snapshot_fingerprint,
      canonicalHashes: auth.request_hash === sha(auth.canonical_request) && auth.basket_fingerprint === sha(auth.canonical_basket),
      noRefund: auth.has_refund !== true,
      destinationIdentity: sha(addressFields(auth.shipping_address_snapshot, auth.guest_email)) === auth.destination_fingerprint,
    } : null;
    if (!authorizationChecks || Object.values(authorizationChecks).some((valid) => !valid)) {
      throw new AppError(409, "TOONIES_SETTLEMENT_AUTHORIZATION_FAILED", "The settlement authorization facts are no longer valid.",
        process.env.NODE_ENV === "test" ? { settlementState: auth?.state ?? null, authorizationChecks } : undefined);
    }
    await authorizeSettlementLines(db, auth);
     financialReservation = await acquireFinancialOperation(db, {
       orderId: auth.order_id,
       operationType: "supplier_settlement",
       operationReferenceId: settlement.id,
       leaseSeconds: 180,
     });
     financialReservation = { ...financialReservation, ...await markFinancialOperationTransmitting(db, financialReservation) };
    claim = await db.query(
      `UPDATE toonies_settlements SET state='submitting',lease_token=$1,lease_until=now()+interval '60 seconds',
         version=version+1,first_submission_at=COALESCE(first_submission_at,now()),last_transmission_at=now(),
         transmission_count=transmission_count+1,
          updated_at=now()
       WHERE id=$2 AND state IN ('not_submitted','replay_pending')
         AND version=$3 AND (lease_until IS NULL OR lease_until <= now())
       RETURNING *`, [token, settlement.id, auth.version],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
  if (!claim.rowCount) throw new AppError(409, "TOONIES_SETTLEMENT_NOT_OWNED", "The settlement is already being processed or resolved.");
  await pauseAfterFinancialOperationReservation();
  const owned = claim.rows[0];
  try {
    const data: any = await client.create(owned.canonical_request);
    const facts = validateResponse(data, { taskId: owned.task_id, apiOrderSn: owned.api_order_sn, basket: settlement.basket, productSum: settlement.productSum });
    let authoritative = data;
    if (data.duplicated === true) {
      const original = await client.getOrder({ order_sn: text(data.order_sn) }) as any;
      if (text(original?.order_sn) !== text(data.order_sn)) {
        stateError(50001, "The duplicate settlement GET returned a different order identity.");
      }
      validateReconciledOrder(original, owned, settlement.basket, settlement.productSum);
      authoritative = { ...original, duplicated: true, create_response: data };
    }
     await settlementTestPauseAfterResponse?.();
    const confirmDb = await pool.connect();
    try {
      await confirmDb.query("BEGIN");
      const result = await confirmDb.query(
        `UPDATE toonies_settlements SET state='confirmed',confirmation_kind=$1::toonies_settlement_confirmation_kind,order_sn=$2,trade_order_sn=$3,
           supplier_status=$4,pay_status=$5,currency=$6,product_sum=$7,shipping_fee=$8,total_sum=$9,total_weight=$10,
           response_evidence=$11,confirmed_at=now(),lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now()
          WHERE id=$12 AND state='submitting' AND lease_token=$13 AND version=$14 RETURNING *`,
         [data.duplicated === true ? "duplicate" : "original", authoritative.order_sn, authoritative.trade_order_sn ?? null, authoritative.status ?? null, authoritative.pay_status ?? null, authoritative.currency, facts.productSum, facts.shipping, facts.total, authoritative.total_weight ?? null, evidence(authoritative), owned.id, token, owned.version],
      );
      if (!result.rowCount) throw new AppError(409, "TOONIES_SETTLEMENT_LEASE_LOST", "The settlement lease was lost before confirmation.");
      await recordEvidence(confirmDb, owned.id, data.duplicated === true ? "duplicate_confirmed" : "original_confirmed", "submitting", "confirmed", data, owned.request_hash, sha(data));
       await transitionFinancialOperation(confirmDb, {
         id: financialReservation.id,
         leaseToken: financialReservation.leaseToken,
         version: financialReservation.version,
         state: "completed",
         recoveryEvidence: { settlementId: owned.id, orderSn: authoritative.order_sn },
       });
      await confirmDb.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await confirmDb.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      confirmDb.release();
    }
  } catch (error) {
    const code = error instanceof TooniesError ? error.code : error instanceof AppError ? Number(String(error.code).match(/\d+$/)?.[0] ?? 50001) : 50001;
    const unknownDb = await pool.connect();
    try {
      await unknownDb.query("BEGIN");
       const updated = await unknownDb.query("UPDATE toonies_settlements SET state='transmitted_unknown',failure_code=$1,failure_message=$2,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$3 AND state='submitting' AND lease_token=$4 AND version=$5 RETURNING id", [code, String(error instanceof Error ? error.message : error).slice(0, 2000), owned.id, token, owned.version]);
       if (updated.rowCount) {
         await recordEvidence(unknownDb, owned.id, "transmission_unknown", "submitting", "transmitted_unknown", { message: String(error), code }, owned.request_hash, undefined, code);
         await transitionFinancialOperation(unknownDb, {
           id: financialReservation.id,
           leaseToken: financialReservation.leaseToken,
           version: financialReservation.version,
           state: "ambiguous",
           failureCode: String(code),
           failureMessage: String(error),
           recoveryEvidence: { settlementId: owned.id, ambiguous: true },
         });
       }
      await unknownDb.query("COMMIT");
    } catch (persistError) {
      await unknownDb.query("ROLLBACK").catch(() => undefined);
      await pool.query(
        "UPDATE toonies_settlements SET state='transmitted_unknown',failure_code=$1,failure_message=$2,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$3 AND state='submitting' AND lease_token=$4",
        [code, "Settlement outcome persistence failed; conservatively marked unknown.", owned.id, token],
      ).catch(() => undefined);
      throw persistError;
    } finally {
      unknownDb.release();
    }
    throw error;
  }
}

export async function settleTooniesProcurementAttempt(attemptId: string) {
  await assertTooniesSettlementEnabled();
  const settlement = await loadOrCreateSettlement(attemptId);
  if (settlement.state === "confirmed" || settlement.state === "documented_rejection" || settlement.state === "manual_review") return settlement;
  return transmit(settlement, getTooniesClient());
}

export async function recoverExpiredTooniesSubmittingSettlements(limit = 100) {
  await assertTooniesSettlementEnabled();
  const db = await getDatabasePool().connect();
  try {
    await db.query("BEGIN");
    const rows = (await db.query<any>(
      `SELECT id,version FROM toonies_settlements
        WHERE state='submitting' AND lease_until < now()
        ORDER BY updated_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [Math.min(100, Math.max(1, limit))],
    )).rows;
    for (const row of rows) {
      const updated = await db.query(
        `UPDATE toonies_settlements SET state='transmitted_unknown',lease_token=NULL,lease_until=NULL,
          next_reconciliation_at=now(),version=version+1,updated_at=now()
         WHERE id=$1 AND state='submitting' AND version=$2 AND lease_until < now() RETURNING id`,
        [row.id, row.version],
      );
      if (!updated.rowCount) continue;
      await recordEvidence(db, row.id, "expired_submission_recovered", "submitting", "transmitted_unknown", { conservative: true });
    }
    await db.query("COMMIT");
    return rows.length;
  } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; } finally { db.release(); }
}

export async function replayTooniesSettlement(settlementId: string) {
  await assertTooniesSettlementEnabled();
  const db = await getDatabasePool().connect();
  let settlement: any;
  try {
    await db.query("BEGIN");
    settlement = (await db.query<any>(
      `UPDATE toonies_settlements
          SET state='replay_pending',version=version+1,updated_at=now()
        WHERE id=$1 AND state IN ('transmitted_unknown','reconciling')
          AND (lease_until IS NULL OR lease_until <= now())
        RETURNING *`, [settlementId],
    )).rows[0];
    if (settlement) {
      // A replay is permitted only for this immutable settlement identity. The
      // supplier reservation is reused (never replaced) and reset to the
      // pre-transmission phase so the same task/api_order_sn can be submitted
      // again after an ambiguous outcome.
      await db.query(
        `UPDATE financial_operation_reservations
            SET state='active',phase='reserved',transmission_started_at=NULL,
                lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now()
          WHERE operation_type='supplier_settlement'
            AND operation_reference_id=$1
            AND ((state='ambiguous' AND phase='ambiguous')
              OR (state='active' AND transmission_started_at IS NOT NULL))`,
        [settlementId],
      );
      await recordEvidence(db, settlementId, "replay_authorized", "transmitted_unknown", "replay_pending", { sameIdentity: true });
    }
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; } finally { db.release(); }
  if (!settlement) throw new AppError(404, "TOONIES_SETTLEMENT_NOT_FOUND", "The Toonies settlement was not found.");
  const prepared = await loadOrCreateSettlement(settlement.attempt_id);
  return transmit({ ...prepared, id: settlement.id, state: "replay_pending", basket: prepared.basket, productSum: prepared.productSum }, getTooniesClient());
}

export async function listTooniesSettlements(limit = 50) {
  const rows = await getDatabasePool().query<any>(
    `SELECT id,order_id AS "orderId",attempt_id AS "attemptId",generation,task_id AS "taskId",
       api_order_sn AS "apiOrderSn",state,confirmation_kind AS "confirmationKind",
       lease_until AS "leaseUntil",version,first_submission_at AS "firstSubmissionAt",
       last_transmission_at AS "lastTransmissionAt",confirmed_at AS "confirmedAt",
       transmission_count AS "transmissionCount",reconciliation_count AS "reconciliationCount",
       next_reconciliation_at AS "nextReconciliationAt",reconciliation_source AS "reconciliationSource",
       reconciliation_page AS "reconciliationPage",reconciliation_exhausted AS "reconciliationExhausted",
       order_sn AS "orderSn",trade_order_sn AS "tradeOrderSn",supplier_status AS "supplierStatus",
       pay_status AS "payStatus",currency,product_sum AS "productSum",shipping_fee AS "shippingFee",
       total_sum AS "totalSum",total_weight AS "totalWeight",failure_code AS "failureCode",
       failure_message AS "failureMessage",created_at AS "createdAt",updated_at AS "updatedAt"
     FROM toonies_settlements ORDER BY updated_at DESC LIMIT $1`, [Math.min(100, Math.max(1, limit))],
  );
  return rows.rows;
}

function validateReconciledOrder(data: any, settlement: any, basket: any[], productSum: string) {
  if (!data || text(data.order_sn) === "" || text(data.api_order_sn) !== settlement.api_order_sn) {
    throw new AppError(502, "TOONIES_RECONCILIATION_IDENTITY_MISMATCH", "The reconciled supplier order identity did not match.");
  }
  if (data.api_task_id !== undefined && text(data.api_task_id) !== settlement.task_id) {
    throw new AppError(502, "TOONIES_RECONCILIATION_TASK_MISMATCH", "The reconciled supplier task did not match.");
  }
  const destination = data.consignee || data.address ? {
    consignee: text(data.consignee),
    phone: text(data.phone),
    country_code: text(data.country_code ?? data.countryCode),
    province: text(data.province ?? data.region),
    city: text(data.city),
    address: text(data.address ?? data.address_line),
    postcode: text(data.postcode ?? data.postal_code),
    email: text(data.email),
  } : data.address_snapshot;
  if (destination && sha(destination) !== sha({
    consignee: settlement.canonical_request.consignee,
    phone: settlement.canonical_request.phone,
    country_code: settlement.canonical_request.country_code,
    province: settlement.canonical_request.province,
    city: settlement.canonical_request.city,
    address: settlement.canonical_request.address,
    postcode: settlement.canonical_request.postcode,
    email: settlement.canonical_request.email,
  })) {
    throw new AppError(502, "TOONIES_RECONCILIATION_ADDRESS_MISMATCH", "The reconciled supplier destination did not match.");
  }
  if (String(data.currency ?? "") !== "CNY") throw new AppError(502, "TOONIES_RECONCILIATION_CURRENCY_MISMATCH", "The reconciled supplier currency did not match.");
  if (amount(data.product_sum) !== productSum || amount(data.shipping_fee) !== "0" || amount(data.sum) !== productSum) {
    throw new AppError(502, "TOONIES_RECONCILIATION_AMOUNT_MISMATCH", "The reconciled supplier amounts did not match.");
  }
  if (!Array.isArray(data.items) || data.items.length !== basket.length || (data.skipped_items?.length ?? 0) !== 0) {
    throw new AppError(502, "TOONIES_RECONCILIATION_BASKET_MISMATCH", "The reconciled supplier basket was incomplete.");
  }
  const expected = new Set(basket.map((line) => `${line.productCode}\u0000${line.skuCode}\u0000${line.quantity}`));
  const seen = new Set<string>();
  if (data.items.some((item: any) => {
    const key = `${item?.product_code}\u0000${item?.sku_code}\u0000${item?.num}`;
    if (seen.has(key) || !expected.has(key)) return true;
    seen.add(key);
    return false;
  }) || seen.size !== expected.size) {
    throw new AppError(502, "TOONIES_RECONCILIATION_BASKET_MISMATCH", "The reconciled supplier basket did not match.");
  }
  if (!["paid", "success", "created", "completed"].includes(String(data.pay_status ?? "").toLowerCase())
    || !["paid", "success", "created", "completed"].includes(String(data.status ?? "").toLowerCase())) {
    throw new AppError(502, "TOONIES_RECONCILIATION_STATUS_MISMATCH", "The reconciled supplier payment status did not match.");
  }
}

/** Locate an ambiguous order using bounded list pages, then use the returned
 * order_sn for authoritative get. Zero matches never prove non-creation. */
export async function reconcileTooniesSettlement(settlementId: string) {
  await assertTooniesSettlementEnabled();
  const pool = getDatabasePool();
  const settlement = (await pool.query<any>("SELECT * FROM toonies_settlements WHERE id=$1", [settlementId])).rows[0];
  if (!settlement) throw new AppError(404, "TOONIES_SETTLEMENT_NOT_FOUND", "The Toonies settlement was not found.");
  if (!unresolved.includes(settlement.state as SettlementState)) throw new AppError(409, "TOONIES_RECONCILIATION_INVALID", "Only unresolved settlements can be reconciled.");
  const reconcileToken = randomUUID();
   const reconcileClaim = await pool.query("UPDATE toonies_settlements SET state='reconciling',lease_token=$1,lease_until=now()+interval '60 seconds',reconciliation_count=reconciliation_count+1,reconciliation_page=0,reconciliation_exhausted=false,version=version+1,updated_at=now() WHERE id=$2 AND state IN ('transmitted_unknown','reconciling','replay_pending') AND (lease_until IS NULL OR lease_until <= now()) RETURNING id,version,reconciliation_source,reconciliation_date_start,reconciliation_date_end", [reconcileToken, settlementId]);
  if (!reconcileClaim.rowCount) throw new AppError(409, "TOONIES_RECONCILIATION_LEASE_BUSY", "The settlement is already being reconciled.");
   let reconcileVersion = reconcileClaim.rows[0].version;
   const reconciliationSource = reconcileClaim.rows[0].reconciliation_source ?? "api";
  const prepared = await loadOrCreateSettlement(settlement.attempt_id);
   const now = Math.floor(new Date(reconcileClaim.rows[0].reconciliation_date_end).getTime() / 1000);
   const start = Math.floor(new Date(reconcileClaim.rows[0].reconciliation_date_start).getTime() / 1000);
  const records: any[] = [];
  let exhaustive = false;
  for (let page = 1; page <= 10; page += 1) {
    const progress = await pool.query("UPDATE toonies_settlements SET reconciliation_page=$1,version=version+1,updated_at=now() WHERE id=$2 AND state='reconciling' AND lease_token=$3 AND version=$4 RETURNING version", [page, settlementId, reconcileToken, reconcileVersion]);
    if (!progress.rowCount) throw new AppError(409, "TOONIES_RECONCILIATION_LEASE_LOST", "The reconciliation lease was lost.");
    reconcileVersion = progress.rows[0].version;
     let result: any;
     try {
       result = await getTooniesClient().listOrders({ order_source: reconciliationSource, date_start: start, date_end: now, page, page_size: 50 });
     } catch (error) {
       const db = await pool.connect();
       try {
         await db.query("BEGIN");
         const updated = await db.query("UPDATE toonies_settlements SET state='transmitted_unknown',failure_message=$1,next_reconciliation_at=now()+interval '5 minutes',lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$2 AND state='reconciling' AND lease_token=$3 AND version=$4 RETURNING id", [String(error instanceof Error ? error.message : error).slice(0, 2000), settlementId, reconcileToken, reconcileVersion]);
         if (updated.rowCount) await recordEvidence(db, settlementId, "reconciliation_error", "reconciling", "transmitted_unknown", { page, error: String(error) });
         await db.query("COMMIT");
       } catch (persistError) { await db.query("ROLLBACK").catch(() => undefined); throw persistError; } finally { db.release(); }
       throw error;
     }
    const rows = Array.isArray(result) ? result : result?.items ?? result?.orders ?? result?.list ?? [];
    records.push(...rows.filter((row: any) => text(row?.api_order_sn) === settlement.api_order_sn));
    if (rows.length < 50) { exhaustive = true; break; }
  }
  if (records.length > 1) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const updated = await db.query("UPDATE toonies_settlements SET state='manual_review',failure_message=$1,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$2 AND state='reconciling' AND lease_token=$3 AND version=$4 RETURNING id", ["Multiple supplier records matched the immutable api_order_sn.", settlementId, reconcileToken, reconcileVersion]);
      if (!updated.rowCount) throw new AppError(409, "TOONIES_RECONCILIATION_LEASE_LOST", "The reconciliation lease was lost.");
      await recordEvidence(db, settlementId, "reconciliation_multiple_matches", "reconciling", "manual_review", { count: records.length });
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; } finally { db.release(); }
    throw new AppError(409, "TOONIES_RECONCILIATION_MULTIPLE", "Multiple supplier orders matched the settlement identity.");
  }
  if (!exhaustive) {
    const db = await pool.connect();
    try { await db.query("BEGIN"); const updated = await db.query("UPDATE toonies_settlements SET state='transmitted_unknown',next_reconciliation_at=now()+interval '5 minutes',lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$1 AND state='reconciling' AND lease_token=$2 AND version=$3 RETURNING id", [settlementId, reconcileToken, reconcileVersion]); if (!updated.rowCount) throw new AppError(409, "TOONIES_RECONCILIATION_LEASE_LOST", "The reconciliation lease was lost."); await recordEvidence(db, settlementId, "reconciliation_bound_reached", "reconciling", "transmitted_unknown", { pages: 10, exhaustive: false }); await db.query("COMMIT"); } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; } finally { db.release(); }
    return { state: "transmitted_unknown", found: false, exhaustive: false };
  }
  if (records.length === 0) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const updated = await db.query("UPDATE toonies_settlements SET state='transmitted_unknown',next_reconciliation_at=now()+interval '1 minute',reconciliation_exhausted=true,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$1 AND state='reconciling' AND lease_token=$2 AND version=$3 RETURNING id", [settlementId, reconcileToken, reconcileVersion]);
      if (!updated.rowCount) throw new AppError(409, "TOONIES_RECONCILIATION_LEASE_LOST", "The reconciliation lease was lost.");
      await recordEvidence(db, settlementId, "reconciliation_not_found", "reconciling", "transmitted_unknown", { searchedFrom: start, searchedTo: now });
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; } finally { db.release(); }
    return { state: "transmitted_unknown", found: false };
  }
   let order: any;
   try {
     order = await getTooniesClient().getOrder({ order_sn: text(records[0].order_sn) }) as any;
     validateReconciledOrder(order, settlement, prepared.basket, prepared.productSum);
   } catch (error) {
     const db = await pool.connect();
     try {
       await db.query("BEGIN");
       const updated = await db.query("UPDATE toonies_settlements SET state='manual_review',failure_message=$1,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$2 AND state='reconciling' AND lease_token=$3 AND version=$4 RETURNING id", [String(error instanceof Error ? error.message : error).slice(0, 2000), settlementId, reconcileToken, reconcileVersion]);
       if (updated.rowCount) await recordEvidence(db, settlementId, "reconciliation_contradiction", "reconciling", "manual_review", { error: String(error) });
       await db.query("COMMIT");
     } catch (persistError) { await db.query("ROLLBACK").catch(() => undefined); throw persistError; } finally { db.release(); }
     throw error;
   }
  const confirmDb = await pool.connect();
  try {
    await confirmDb.query("BEGIN");
    const confirmed = (await confirmDb.query<any>(
      `UPDATE toonies_settlements SET state='confirmed',confirmation_kind='duplicate',order_sn=$1,trade_order_sn=$2,
         supplier_status=$3,pay_status=$4,currency=$5,product_sum=$6,shipping_fee=$7,total_sum=$8,
         total_weight=$9,response_evidence=$10,confirmed_at=now(),lease_token=NULL,lease_until=NULL,updated_at=now()
       WHERE id=$11 AND state='reconciling' AND lease_token=$12 AND version=$13 RETURNING *`,
      [order.order_sn, order.trade_order_sn ?? null, order.status ?? null, order.pay_status ?? null, order.currency, amount(order.product_sum), amount(order.shipping_fee), amount(order.sum), order.total_weight ?? null, evidence(order), settlementId, reconcileToken, reconcileVersion],
    )).rows[0];
    if (!confirmed) throw new AppError(409, "TOONIES_RECONCILIATION_LEASE_LOST", "The reconciliation lease was lost.");
    await recordEvidence(confirmDb, settlementId, "reconciliation_confirmed", "reconciling", "confirmed", order, settlement.request_hash, sha(order));
    await confirmDb.query("COMMIT");
    return confirmed;
  } catch (error) { await confirmDb.query("ROLLBACK").catch(() => undefined); throw error; } finally { confirmDb.release(); }
}

export async function markTooniesSettlementManualReview(settlementId: string, reason: string) {
  await assertTooniesSettlementEnabled();
  const db = await getDatabasePool().connect();
  try {
    await db.query("BEGIN");
    const result = await db.query(
      `UPDATE toonies_settlements SET state='manual_review',failure_message=$1,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=now()
        WHERE id=$2 AND state IN ('transmitted_unknown','reconciling','replay_pending')
          AND (lease_until IS NULL OR lease_until <= now()) RETURNING id`,
      [reason.slice(0, 2000), settlementId],
    );
    if (!result.rowCount) throw new AppError(409, "TOONIES_SETTLEMENT_REVIEW_INVALID", "The settlement is not eligible for manual review.");
    await recordEvidence(db, settlementId, "manual_review", "transmitted_unknown", "manual_review", { reason });
    await db.query("COMMIT");
    return { id: settlementId, state: "manual_review" };
  } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; } finally { db.release(); }
}
