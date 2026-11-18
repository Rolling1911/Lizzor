import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getDatabasePool } from "../db/client.js";
import { createSupplierFailureReversal, mapDocumentedSupplierFailure } from "./supplier-failure-reversal-service.js";
import { AppError } from "../middleware/error-handler.js";
import { TooniesError } from "./toonies.js";
import { getTooniesClient } from "./toonies-service.js";
import { loadTooniesSupplierSnapshotFingerprint } from "./toonies-snapshot.js";
import { assertTooniesProcurementEnabled, getTooniesProcurementGateStatus, getTooniesSettlementGateStatus } from "./toonies-procurement-gate.js";
import { reconcileTooniesSettlement, recoverExpiredTooniesSubmittingSettlements, settleTooniesProcurementAttempt } from "./toonies-settlement-service.js";

const localLines = z.array(z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid(),
    quantity: z.number().int().positive().max(2_147_483_647),
  }).strict()).min(1).max(200);
const orderAttemptInput = z.object({ orderId: z.string().uuid() }).strict();
const manualAttemptInput = z.object({ lines: localLines }).strict();
const attemptInput = z.union([orderAttemptInput, manualAttemptInput]);

type Input = z.infer<typeof attemptInput>;
type CommandAuthority = { commandId: string; leaseToken: string };
type SupplierLine = {
  productId: string; variantId: string; catalogueItemId: string; catalogueVariantId: string;
  productCode: string; skuCode: string; quantity: number; expectedUnitCostCny?: string; expectedSubtotalCny?: string; costThresholdPercent?: string; supplierProductLinkId?: string;
};

function fingerprint(orderId: string | null, actorAdminId: string | null, lines: SupplierLine[]): string {
  const canonical = JSON.stringify({
    orderId,
    actorAdminId: orderId ? null : actorAdminId,
    lines: [...lines].sort((a, b) => `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`))
      .map((line) => [line.productId, line.variantId, line.supplierProductLinkId, line.catalogueItemId, line.catalogueVariantId, line.productCode, line.skuCode, line.quantity, line.expectedUnitCostCny, line.expectedSubtotalCny, line.costThresholdPercent]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function deriveTooniesClientTaskNo(supplierId: string, digest: string, generation = 1): string {
  return `lizzor-${createHash("sha256").update(`${supplierId}:${digest}:${generation}`).digest("hex").slice(0, 48)}`;
}

function expiry(value: unknown, expireIn: unknown): Date | null {
  const numberValue = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isFinite(numberValue)) return new Date(numberValue < 1_000_000_000_000 ? numberValue * 1000 : numberValue);
  const seconds = Number(expireIn);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
}
function boundedEvidence(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    return json.length <= 100_000 ? value : { truncated: true, sha256: createHash("sha256").update(json).digest("hex"), preview: json.slice(0, 99_000) };
  } catch {
    return { truncated: true };
  }
}
function strictDecimal(value: unknown): string | null {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  return /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(text) ? text : null;
}

const publicFailure: Record<number, string> = {
  40001: "The supplier request was invalid.", 40003: "The supplier request could not be authenticated.",
  40004: "The supplier request expired.", 40005: "The supplier request could not be repeated.",
  40006: "Supplier access is unavailable.", 40010: "The supplier product or SKU is invalid.",
  40011: "The supplier SKU is unavailable.", 40020: "Supplier balance is insufficient.",
  40021: "Supplier stock is insufficient.", 40022: "The supplier minimum quantity was not met.",
  40030: "The destination is unsupported.", 40031: "The supplier task identity was already used.",
  40040: "The supplier task is not ready.", 40041: "The supplier snapshot expired.",
  40042: "The supplier returned no orderable items.", 42901: "The supplier is rate limiting requests.",
  50001: "The supplier is temporarily unavailable.",
  40043: "The supplier cost exceeded the approved variance threshold.",
};
function supplierFailure(error: unknown): never {
  if (error instanceof TooniesError) {
    const retryable = error.code === 50001 || error.code === 42901 || error.code === 40040;
    throw new AppError(retryable ? 503 : 502, `TOONIES_${error.code}`, publicFailure[error.code] ?? "The supplier precheck could not be completed.", { supplierCode: error.code, retryable });
  }
  throw error;
}

async function linkedLines(input: Input): Promise<{ supplierId: string; lines: SupplierLine[] }> {
  const pool = getDatabasePool();
  const supplier = (await pool.query<{ id: string }>("SELECT id FROM suppliers WHERE slug='toonies' AND active=true")).rows[0];
  if (!supplier) throw new AppError(503, "TOONIES_SUPPLIER_UNAVAILABLE", "The Toonies supplier is not available.");
  const lines: SupplierLine[] = [];
  const orderId = "orderId" in input ? input.orderId : null;
  const manualLines = "lines" in input ? input.lines : null;
  const requestedLines = manualLines ?? (orderId ? (await pool.query<any>(
    `SELECT product_id AS "productId",variant_id AS "variantId",supplier_id AS "supplierId",supplier_product_link_id AS "supplierProductLinkId",
            supplier_catalogue_item_id AS "catalogueItemId",supplier_catalogue_variant_id AS "catalogueVariantId",
            supplier_product_code AS "productCode",supplier_sku_code AS "skuCode",quantity,
            supplier_cost_cny AS "expectedUnitCostCny",supplier_cost_threshold_percent AS "costThresholdPercent"
       FROM order_items WHERE order_id=$1 AND supplier_id=$2 ORDER BY created_at,id`, [orderId, supplier.id],
  )).rows.map((row: any) => ({ ...row, variantId: row.variantId, quantity: Number(row.quantity) })) : []);
  if (!requestedLines.length) throw new AppError(400, "TOONIES_LINES_REQUIRED", "At least one procurement line is required.");
  if (!manualLines && orderId) {
    if (requestedLines.some((row: any) => !row.supplierId || !row.supplierProductLinkId || !row.catalogueItemId || !row.catalogueVariantId || !row.productCode || !row.skuCode)) {
      throw new AppError(409, "TOONIES_ORDER_SNAPSHOT_INVALID", "The paid order does not contain a complete immutable Toonies supplier snapshot.");
    }
    const supplierIds = new Set(requestedLines.map((row: any) => row.supplierId));
    if (supplierIds.size !== 1 || !supplierIds.has(supplier.id)) throw new AppError(409, "TOONIES_ORDER_SNAPSHOT_INVALID", "The paid order contains an ambiguous supplier snapshot.");
    const snapshots = new Map<string, SupplierLine>();
    for (const row of requestedLines) {
      const key = `${row.productId}:${row.variantId}`;
      const prior = snapshots.get(key);
      if (prior && (prior.catalogueItemId !== row.catalogueItemId || prior.catalogueVariantId !== row.catalogueVariantId || prior.productCode !== row.productCode || prior.skuCode !== row.skuCode || String(prior.expectedUnitCostCny) !== String(row.expectedUnitCostCny) || String(prior.costThresholdPercent) !== String(row.costThresholdPercent))) {
        throw new AppError(409, "TOONIES_ORDER_SNAPSHOT_INVALID", "Duplicate order lines contain conflicting immutable supplier snapshots.");
      }
      if (prior) prior.quantity += Number(row.quantity);
      else snapshots.set(key, {
      productId: row.productId, variantId: row.variantId, catalogueItemId: row.catalogueItemId, catalogueVariantId: row.catalogueVariantId,
      productCode: row.productCode, skuCode: row.skuCode, quantity: row.quantity,
      supplierProductLinkId: row.supplierProductLinkId,
      expectedUnitCostCny: String(row.expectedUnitCostCny), expectedSubtotalCny: String(row.expectedUnitCostCny),
      costThresholdPercent: String(row.costThresholdPercent),
      });
    }
    return { supplierId: supplier.id, lines: [...snapshots.values()] };
  }
  for (const requested of requestedLines) {
    const row = (await pool.query<SupplierLine>(
      `SELECT p.id AS "productId",pv.id AS "variantId",l.catalogue_item_id AS "catalogueItemId",
              l.catalogue_variant_id AS "catalogueVariantId",ci.external_product_id AS "productCode",
              cv.sku_code AS "skuCode"
         FROM products p
         JOIN product_variants pv ON pv.product_id=p.id AND pv.id=$2
         JOIN supplier_product_links l ON l.product_id=p.id AND l.variant_id=pv.id AND l.supplier_id=$3
         JOIN supplier_catalogue_items ci ON ci.id=l.catalogue_item_id AND ci.supplier_id=l.supplier_id
         JOIN supplier_catalogue_variants cv ON cv.id=l.catalogue_variant_id
          AND cv.catalogue_item_id=l.catalogue_item_id AND cv.supplier_id=l.supplier_id
        WHERE p.id=$1 AND p.status='active' AND pv.active=true`,
      [requested.productId, requested.variantId, supplier.id],
    )).rows[0];
    if (!row) throw new AppError(409, "TOONIES_SUPPLIER_LINK_INVALID", "Every requested line must have an active Toonies product and SKU link.");
    lines.push({ ...row, quantity: requested.quantity });
  }
  const aggregated = new Map<string, SupplierLine>();
  for (const line of lines) {
    const key = `${line.productId}:${line.variantId}`;
    const existing = aggregated.get(key);
    if (existing) existing.quantity += line.quantity;
    else aggregated.set(key, { ...line });
  }
  return { supplierId: supplier.id, lines: [...aggregated.values()] };
}

async function recordEvent(db: { query: (...args: any[]) => Promise<any> }, attemptId: string, actorAdminId: string | null, fromState: string | null, toState: string, eventType: string, details?: unknown, errorCode?: number) {
  await db.query(
    "INSERT INTO toonies_procurement_events(attempt_id,actor_admin_id,from_state,to_state,event_type,error_code,details) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [attemptId, actorAdminId, fromState, toState, eventType, errorCode ?? null, details ?? null],
  );
}

async function assertOrderBoundIoIntegrity(attemptId: string, authority?: CommandAuthority, attemptLeaseToken?: string) {
  const pool = getDatabasePool();
  const facts = (await pool.query<any>(
    `SELECT a.order_id AS "orderId",a.lease_token AS "attemptLeaseToken",a.lease_until AS "attemptLeaseUntil",
            c.id AS "commandId",c.state AS "commandState",c.lease_token AS "commandLeaseToken",c.lease_until AS "commandLeaseUntil",
            c.order_total_fingerprint AS "commandTotalFingerprint",c.supplier_snapshot_fingerprint AS "commandSupplierFingerprint",
            o.total_fingerprint AS "orderTotalFingerprint",o.payment_status AS "paymentStatus",
            EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.status='paid' AND p.currency='EUR'
              AND p.amount=o.grand_total AND p.order_total_fingerprint=o.total_fingerprint) AS "verifiedPayment"
       FROM toonies_procurement_attempts a
       JOIN orders o ON o.id=a.order_id
       JOIN toonies_procurement_commands c ON c.order_id=o.id
      WHERE a.id=$1`,
    [attemptId],
  )).rows[0];
  if (!facts) throw new AppError(409, "ORDER_PROCUREMENT_INTEGRITY_FAILED", "The paid-order procurement authorization is unavailable.");
  const now = Date.now();
  if (authority) {
    if (facts.commandId !== authority.commandId || facts.commandState !== "processing" || facts.commandLeaseToken !== authority.leaseToken
      || !facts.commandLeaseUntil || new Date(facts.commandLeaseUntil).getTime() <= now) {
      throw new AppError(409, "ORDER_PROCUREMENT_LEASE_LOST", "The paid-order procurement command lease is no longer valid.");
    }
  } else if (facts.commandState !== "completed") {
    throw new AppError(409, "ORDER_PROCUREMENT_COMMAND_INVALID", "The paid-order procurement command is not complete.");
  }
  if (attemptLeaseToken && (facts.attemptLeaseToken !== attemptLeaseToken || !facts.attemptLeaseUntil || new Date(facts.attemptLeaseUntil).getTime() <= now)) {
    throw new AppError(409, "ORDER_PROCUREMENT_LEASE_LOST", "The paid-order procurement attempt lease is no longer valid.");
  }
  if (facts.paymentStatus !== "paid" || facts.verifiedPayment !== true || !facts.orderTotalFingerprint
    || facts.commandTotalFingerprint !== facts.orderTotalFingerprint) {
    throw new AppError(409, "ORDER_PROCUREMENT_PAYMENT_INVALID", "The paid-order payment or total fingerprint is no longer valid.");
  }
  const currentSupplierFingerprint = await loadTooniesSupplierSnapshotFingerprint(pool, facts.orderId);
  if (!currentSupplierFingerprint || currentSupplierFingerprint !== facts.commandSupplierFingerprint) {
    throw new AppError(409, "ORDER_PROCUREMENT_SNAPSHOT_INVALID", "The immutable supplier snapshot no longer matches the paid-order command.");
  }
}

export async function createTooniesProcurementAttempt(raw: unknown, actorAdminId: string | null = null) {
  await assertTooniesProcurementEnabled();
  if (orderAttemptInput.safeParse(raw).success) {
    throw new AppError(403, "ORDER_PROCUREMENT_WORKER_ONLY", "Paid order procurement is worker-only.");
  }
  return createTooniesProcurementAttemptInternal(manualAttemptInput.parse(raw), actorAdminId);
}

async function createOrderBoundTooniesProcurementAttempt(orderId: string, authority: CommandAuthority) {
  return createTooniesProcurementAttemptInternal(orderAttemptInput.parse({ orderId }), null, authority);
}

async function createTooniesProcurementAttemptInternal(input: Input, actorAdminId: string | null, authority?: CommandAuthority) {
  const orderId = "orderId" in input ? input.orderId : null;
  if (orderId && !authority) throw new AppError(403, "ORDER_PROCUREMENT_WORKER_ONLY", "Paid order procurement is worker-only.");
  const { supplierId, lines } = await linkedLines(input);
  const digest = fingerprint(orderId, actorAdminId, lines);
  const db = await getDatabasePool().connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`toonies-procurement:${supplierId}:${digest}`]);
    const order = orderId ? (await db.query("SELECT id FROM orders WHERE id=$1 FOR SHARE", [orderId])).rows[0] : null;
    if (orderId && !order) throw new AppError(404, "ORDER_NOT_FOUND", "The order was not found.");
    if (orderId) {
      const paid = (await db.query(
        `SELECT o.payment_status AS "paymentStatus",o.total_fingerprint AS "totalFingerprint",
                EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.status='paid' AND p.currency='EUR' AND p.amount=o.grand_total) AS "verifiedPayment"
           FROM orders o WHERE o.id=$1`,
        [orderId],
      )).rows[0];
      if (!paid || paid.paymentStatus !== "paid" || paid.verifiedPayment !== true) throw new AppError(409, "ORDER_NOT_PAID", "Procurement is only available for paid orders with a verified payment.");
      if (!paid.totalFingerprint) throw new AppError(409, "ORDER_TOTAL_INTEGRITY_FAILED", "The paid order has no current authoritative total fingerprint.");
      const expected = (await db.query<any>("SELECT product_id AS \"productId\",variant_id AS \"variantId\",sum(quantity)::int AS quantity FROM order_items WHERE order_id=$1 AND supplier_id=$2 GROUP BY product_id,variant_id", [orderId, supplierId])).rows;
      const actual = new Map(lines.map((line) => [`${line.productId}:${line.variantId}`, line.quantity]));
      if (expected.length !== actual.size || expected.some((line: any) => actual.get(`${line.productId}:${line.variantId}`) !== line.quantity)) {
        throw new AppError(409, "ORDER_LINES_MISMATCH", "The requested procurement lines do not match the order.");
      }
    }
    const existing = (await db.query<any>(
      "SELECT * FROM toonies_procurement_attempts WHERE supplier_id=$1 AND request_fingerprint=$2 ORDER BY generation DESC LIMIT 1 FOR UPDATE",
      [supplierId, digest],
    )).rows[0];
    if (existing?.state === "ready" && existing.snapshot_expires_at && new Date(existing.snapshot_expires_at).getTime() <= Date.now()) {
      await db.query("UPDATE toonies_procurement_attempts SET state='expired',updated_at=now() WHERE id=$1", [existing.id]);
      await recordEvent(db, existing.id, actorAdminId, "ready", "expired", "snapshot_expired", undefined, 40041);
      existing.state = "expired";
    }
    const active = existing && (
      ["precheck_pending", "task_pending", "retry_wait"].includes(existing.state)
      || (existing.state === "ready" && (!existing.snapshot_expires_at || new Date(existing.snapshot_expires_at).getTime() > Date.now()))
    );
    if (active) {
      await db.query("COMMIT");
      if (!existing.task_id && ["precheck_pending", "retry_wait"].includes(existing.state)) {
        return submitPrecheck(existing.id, actorAdminId, authority);
      }
      return getTooniesProcurementAttempt(existing.id);
    }
    const generation = existing ? Number(existing.generation) + 1 : 1;
    const taskNo = deriveTooniesClientTaskNo(supplierId, digest, generation);
    const inserted = (await db.query<{ id: string }>(
      `INSERT INTO toonies_procurement_attempts(order_id,supplier_id,actor_admin_id,client_task_no,generation,state,request_fingerprint)
       VALUES($1,$2,$3,$4,$5,'validating',$6) RETURNING id`,
      [orderId, supplierId, actorAdminId, taskNo, generation, digest],
    )).rows[0]!;
    for (const line of lines) {
      await db.query(
        `INSERT INTO toonies_procurement_lines(attempt_id,product_id,variant_id,catalogue_item_id,catalogue_variant_id,product_code,sku_code,requested_quantity,expected_unit_cost_cny,expected_subtotal_cny,cost_threshold_percent)
          VALUES($1,$2,$3,$4,$5,$6,$7,($8::text)::integer,$9,($9::numeric*($8::text)::numeric),$10)`,
        [inserted.id, line.productId, line.variantId, line.catalogueItemId, line.catalogueVariantId, line.productCode, line.skuCode, line.quantity, line.expectedUnitCostCny ?? null, line.costThresholdPercent ?? null],
      );
    }
    await recordEvent(db, inserted.id, actorAdminId, "created", "validating", "attempt_created");
    await db.query("UPDATE toonies_procurement_attempts SET state='precheck_pending',updated_at=now() WHERE id=$1", [inserted.id]);
    await recordEvent(db, inserted.id, actorAdminId, "validating", "precheck_pending", "precheck_queued");
    await db.query("COMMIT");
    const data = await submitPrecheck(inserted.id, actorAdminId, authority);
    return data;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    supplierFailure(error);
  } finally {
    db.release();
  }
}

async function submitPrecheck(attemptId: string, actorAdminId: string | null = null, authority?: CommandAuthority) {
  const pool = getDatabasePool();
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", [`toonies-precheck:${attemptId}`]);
    const attempt = (await lock.query<any>("SELECT id,order_id AS \"orderId\",supplier_id AS \"supplierId\",client_task_no AS \"clientTaskNo\",task_id AS \"taskId\",state,retry_count AS \"retryCount\",max_attempts AS \"maxAttempts\" FROM toonies_procurement_attempts WHERE id=$1", [attemptId])).rows[0];
    if (!attempt) throw new AppError(404, "TOONIES_ATTEMPT_NOT_FOUND", "The Toonies procurement attempt was not found.");
    if (attempt.taskId || !["precheck_pending", "retry_wait"].includes(attempt.state) || attempt.retryCount >= attempt.maxAttempts) return getTooniesProcurementAttempt(attemptId);
    const lines = (await lock.query<any>("SELECT product_code AS \"productCode\",sku_code AS \"skuCode\",requested_quantity AS \"quantity\" FROM toonies_procurement_lines WHERE attempt_id=$1 ORDER BY id", [attemptId])).rows;
    await assertTooniesProcurementEnabled();
    if (attempt.orderId) await assertOrderBoundIoIntegrity(attemptId, authority);
    const data: any = await getTooniesClient().precheck({ client_task_no: attempt.clientTaskNo, items: lines.map((line: any) => ({ product_code: line.productCode, sku_code: line.skuCode, num: line.quantity })) });
    if (!data || typeof data.task_id !== "string" || typeof data.status !== "string") throw new AppError(502, "TOONIES_INVALID_PRECHECK_RESPONSE", "Toonies returned an invalid precheck response.");
    await lock.query("UPDATE toonies_procurement_attempts SET task_id=$1,state='task_pending',raw_snapshot=$2,next_poll_at=now(),failure_code=NULL,failure_message=NULL,updated_at=now() WHERE id=$3", [data.task_id, boundedEvidence(data), attemptId]);
    await recordEvent(lock, attemptId, actorAdminId, attempt.state, "task_pending", "precheck_submitted");
    return getTooniesProcurementAttempt(attemptId);
  } catch (error) {
    if (error instanceof AppError && error.code === "TOONIES_PROCUREMENT_MAINTENANCE") throw error;
    const code = error instanceof TooniesError ? error.code : error instanceof AppError ? 40001 : 50001;
    const retryable = [42901, 50001].includes(code);
    await lock.query(
      `UPDATE toonies_procurement_attempts
          SET state=CASE WHEN $1 AND retry_count+1 < max_attempts THEN 'retry_wait' ELSE 'failed' END,
              retry_count=retry_count+1,next_poll_at=CASE WHEN $1 AND retry_count+1 < max_attempts THEN now()+interval '2 seconds' ELSE NULL END,
              failure_code=$2,failure_message=$3,updated_at=now()
        WHERE id=$4`,
      [retryable, code, publicFailure[code] ?? "The supplier precheck failed.", attemptId],
    );
    supplierFailure(error);
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [`toonies-precheck:${attemptId}`]).catch(() => undefined);
    lock.release();
  }
}

export async function pollTooniesProcurementAttempt(attemptId: string, maxPolls = 5) {
  await assertTooniesProcurementEnabled();
  return pollTooniesProcurementAttemptInternal(attemptId, maxPolls, false);
}

async function pollTooniesProcurementAttemptInternal(attemptId: string, maxPolls = 5, workerAuthorized = false) {
  const pool = getDatabasePool();
  const bounded = Math.max(1, Math.min(10, Math.floor(maxPolls)));
  const lock = await pool.connect();
  await lock.query("BEGIN");
  const attempt = (await lock.query<any>("SELECT * FROM toonies_procurement_attempts WHERE id=$1 FOR UPDATE", [attemptId])).rows[0];
  if (!attempt) { await lock.query("ROLLBACK"); lock.release(); throw new AppError(404, "TOONIES_ATTEMPT_NOT_FOUND", "The Toonies procurement attempt was not found."); }
  if (attempt.order_id && !workerAuthorized) {
    await lock.query("ROLLBACK");
    lock.release();
    throw new AppError(403, "ORDER_PROCUREMENT_WORKER_ONLY", "Paid order procurement is worker-only.");
  }
  if (!attempt.task_id || !["task_pending", "retry_wait"].includes(attempt.state)) {
    await lock.query("ROLLBACK");
    lock.release();
    return getTooniesProcurementAttempt(attemptId);
  }
  try {
    await assertTooniesProcurementEnabled();
  } catch (error) {
    await lock.query("ROLLBACK");
    lock.release();
    throw error;
  }
  const leaseToken = randomUUID();
  if (attempt.lease_until && new Date(attempt.lease_until).getTime() > Date.now()) { await lock.query("ROLLBACK"); lock.release(); return getTooniesProcurementAttempt(attemptId); }
  if (attempt.retry_count >= attempt.max_attempts) { await lock.query("ROLLBACK"); lock.release(); return getTooniesProcurementAttempt(attemptId); }
  await lock.query("UPDATE toonies_procurement_attempts SET lease_token=$1,lease_until=now()+interval '60 seconds' WHERE id=$2", [leaseToken, attemptId]);
  await lock.query("COMMIT"); lock.release();
  let data: any;
  const expected = (await pool.query<any>("SELECT product_code AS \"productCode\",sku_code AS \"skuCode\",requested_quantity AS \"requestedQuantity\" FROM toonies_procurement_lines WHERE attempt_id=$1", [attemptId])).rows;
  const expectedKeys = new Set(expected.map((line: any) => `${line.productCode}\u0000${line.skuCode}`));
  for (let poll = 0; poll < bounded; poll += 1) {
    try {
      await assertTooniesProcurementEnabled();
      if (attempt.order_id) await assertOrderBoundIoIntegrity(attemptId, undefined, leaseToken);
      data = await getTooniesClient().task({ task_id: attempt.task_id });
      if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") console.info(`Procurement attempt ${attemptId}: supplier task received`);
    } catch (error) {
      if (error instanceof TooniesError && error.code === 40040) {
        const persist = await pool.connect();
        try {
          await persist.query("BEGIN");
          const owned = (await persist.query("SELECT state,lease_token,poll_count,max_polls FROM toonies_procurement_attempts WHERE id=$1 FOR UPDATE", [attemptId])).rows[0];
          if (!owned || owned.lease_token !== leaseToken || !["task_pending", "retry_wait"].includes(owned.state)) {
            await persist.query("ROLLBACK");
            return getTooniesProcurementAttempt(attemptId);
          }
          await persist.query(
          `UPDATE toonies_procurement_attempts
              SET poll_count=poll_count+1,
                  state=CASE WHEN poll_count+1 >= max_polls THEN 'failed' ELSE 'task_pending' END,
                  next_poll_at=CASE WHEN poll_count+1 >= max_polls THEN NULL ELSE now()+LEAST(interval '30 seconds', interval '1 second' * power(2, LEAST(poll_count, 5))) END,
                  failure_code=CASE WHEN poll_count+1 >= max_polls THEN 40040 ELSE NULL END,
                  failure_message=CASE WHEN poll_count+1 >= max_polls THEN $2 ELSE NULL END,
                  lease_token=NULL,lease_until=NULL,updated_at=now()
            WHERE id=$1`,
            [attemptId, publicFailure[40040]],
          );
          await recordEvent(persist, attemptId, attempt.actor_admin_id ?? null, owned.state, Number(owned.poll_count) + 1 >= Number(owned.max_polls) ? "failed" : "task_pending", "task_not_ready", undefined, 40040);
          await persist.query("COMMIT");
        } catch (persistError) {
          await persist.query("ROLLBACK").catch(() => undefined);
          throw persistError;
        } finally {
          persist.release();
        }
        return getTooniesProcurementAttempt(attemptId);
      }
      const code = error instanceof TooniesError ? error.code : error instanceof AppError ? 40001 : 50001;
      const retryable = [42901, 50001].includes(code);
      const persist = await pool.connect();
      try {
        await persist.query("BEGIN");
        const owned = (await persist.query("SELECT state,lease_token,retry_count,max_attempts FROM toonies_procurement_attempts WHERE id=$1 FOR UPDATE", [attemptId])).rows[0];
        if (!owned || owned.lease_token !== leaseToken || !["task_pending", "retry_wait"].includes(owned.state)) {
          await persist.query("ROLLBACK");
          return getTooniesProcurementAttempt(attemptId);
        }
        const nextState = retryable && Number(owned.retry_count) + 1 < Number(owned.max_attempts) ? "retry_wait" : "failed";
        await persist.query(
          "UPDATE toonies_procurement_attempts SET state=$1,retry_count=retry_count+1,next_poll_at=CASE WHEN $1='retry_wait' THEN now()+interval '2 seconds' ELSE NULL END,failure_code=$2,failure_message=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$4 AND lease_token=$5",
          [nextState, code, publicFailure[code] ?? "The supplier task could not be read.", attemptId, leaseToken],
        );
        await recordEvent(persist, attemptId, attempt.actor_admin_id ?? null, owned.state, nextState, "task_poll_failed", undefined, code);
        await persist.query("COMMIT");
      } catch (persistError) {
        await persist.query("ROLLBACK").catch(() => undefined);
        throw persistError;
      } finally {
        persist.release();
      }
      supplierFailure(error);
    }
    if (!data || typeof data !== "object" || typeof data.status !== "string" || !Array.isArray(data.items) && ["ready", "completed", "success"].includes(String(data.status).toLowerCase())) {
      const persist = await pool.connect();
      try {
        await persist.query("BEGIN");
        const owned = (await persist.query("SELECT state,lease_token,actor_admin_id FROM toonies_procurement_attempts WHERE id=$1 FOR UPDATE", [attemptId])).rows[0];
        if (owned?.lease_token === leaseToken) {
          await persist.query("UPDATE toonies_procurement_attempts SET state='failed',failure_code=50001,failure_message=$1,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$2 AND lease_token=$3", ["The supplier returned an invalid precheck snapshot.", attemptId, leaseToken]);
          await recordEvent(persist, attemptId, owned.actor_admin_id ?? null, owned.state, "failed", "malformed_snapshot", undefined, 50001);
        }
        await persist.query("COMMIT");
      } catch (persistError) {
        await persist.query("ROLLBACK").catch(() => undefined);
        throw persistError;
      } finally {
        persist.release();
      }
      return getTooniesProcurementAttempt(attemptId);
    }
    const status = String(data?.status ?? "").toLowerCase();
    const terminal = ["ready", "failed", "expired", "used", "completed", "success"].includes(status);
    const expiresAt = expiry(data?.date_expire, data?.expire_in);
    const items = Array.isArray(data?.items) ? data.items : [];
    const seen = new Set<string>();
    const exactRows = items.length === expected.length && items.every((item: any) => {
      const key = `${item?.product_code}\u0000${item?.sku_code}`;
      const stock = Number(item?.stock);
      const moq = Number(item?.moq);
      const num = Number(item?.num);
      if (seen.has(key) || !expectedKeys.has(key)) return false;
      seen.add(key);
      const wanted = expected.find((line: any) => `${line.productCode}\u0000${line.skuCode}` === key);
      return item?.ok === true && Number.isSafeInteger(num) && num === wanted?.requestedQuantity &&
        Number.isSafeInteger(moq) && moq > 0 && Number.isInteger(stock) && stock >= 0 &&
        strictDecimal(item?.charge) !== null;
    }) && seen.size === expectedKeys.size;
    // A paid order carries an immutable expected CNY subtotal and must receive
    // a valid supplier subtotal before it can become ready. Legacy/manual
    // prechecks have no order-time cost baseline, so preserve their existing
    // charge-only validation boundary.
    const monetaryValid = items.every((item: any) =>
      strictDecimal(item?.charge) !== null
      && (!attempt.order_id || strictDecimal(item?.subtotal) !== null),
    );
    const allPassed = terminal && status === "ready" && exactRows && monetaryValid && Boolean(expiresAt) && expiresAt!.getTime() > Date.now();
    const nextState = allPassed ? "ready" : status === "expired" || (expiresAt && expiresAt.getTime() <= Date.now()) ? "expired" : terminal ? "failed" : "task_pending";
    const pollExhausted = nextState === "task_pending" && Number(attempt.poll_count) + 1 >= Number(attempt.max_polls);
    const persistedState = pollExhausted ? "failed" : nextState;
    const persist = await pool.connect();
    try {
      await persist.query("BEGIN");
      const owned = (await persist.query<any>("SELECT state,lease_token,actor_admin_id,poll_count,max_polls FROM toonies_procurement_attempts WHERE id=$1 FOR UPDATE", [attemptId])).rows[0];
      if (!owned || owned.lease_token !== leaseToken || !["task_pending", "retry_wait"].includes(owned.state)) {
        await persist.query("ROLLBACK");
        return getTooniesProcurementAttempt(attemptId);
      }
      const nextPollAt = persistedState === "task_pending" ? new Date(Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(Number(owned.poll_count), 5))) : null;
      await persist.query(
        "UPDATE toonies_procurement_attempts SET state=$1,raw_snapshot=$2,snapshot_expires_at=$3,poll_count=poll_count+1,next_poll_at=$4,failure_code=$5,failure_message=$6,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$7 AND lease_token=$8",
        [persistedState, boundedEvidence(data), expiresAt, nextPollAt, allPassed ? null : terminal || pollExhausted ? (items.find((item: any) => item?.ok === false)?.fail_code ?? 40042) : null, allPassed ? null : terminal || pollExhausted ? "The complete intended Toonies basket did not pass precheck." : null, attemptId, leaseToken],
      );
      await recordEvent(persist, attemptId, owned.actor_admin_id ?? null, owned.state, persistedState, "task_polled", { status, itemCount: items.length });
      for (const item of items) {
        await persist.query(
          `UPDATE toonies_procurement_lines SET returned_quantity=$1,returned_moq=$2,returned_stock=$3,returned_charge_cny=($4::text)::numeric,returned_subtotal_cny=($5::text)::numeric,returned_cost_variance_cny=CASE WHEN expected_subtotal_cny IS NOT NULL AND $5::text IS NOT NULL THEN ($5::text)::numeric-expected_subtotal_cny ELSE NULL END,returned_weight_kg=$6,orderable=$7,failure_code=$8,failure_message=$9,raw_snapshot=$10,updated_at=now()
           WHERE attempt_id=$11 AND product_code=$12 AND sku_code=$13`,
          [item.num ?? null, item.moq ?? null, item.stock ?? null, item.charge ?? null, item.subtotal ?? null, item.weight ?? null, item.ok === true, item.fail_code ?? null, publicFailure[item.fail_code] ?? (item.ok === false ? "The supplier rejected this line." : null), boundedEvidence(item), attemptId, item.product_code, item.sku_code],
        );
      }
      const variance = await persist.query(
        `SELECT EXISTS (
           SELECT 1 FROM toonies_procurement_lines
            WHERE attempt_id=$1 AND expected_subtotal_cny IS NOT NULL AND returned_subtotal_cny IS NOT NULL
              AND returned_subtotal_cny > expected_subtotal_cny * (1 + COALESCE(cost_threshold_percent,0) / 100)
         ) AS held`,
        [attemptId],
      );
      const arithmetic = await persist.query(
        `SELECT EXISTS (SELECT 1 FROM toonies_procurement_lines
          WHERE attempt_id=$1 AND returned_charge_cny IS NOT NULL AND returned_subtotal_cny IS NOT NULL
            AND returned_subtotal_cny <> returned_charge_cny * requested_quantity) AS invalid`,
        [attemptId],
      );
      if (arithmetic.rows[0]?.invalid === true) {
        await persist.query("UPDATE toonies_procurement_attempts SET state='failed',failure_code=40001,failure_message=$1,next_poll_at=NULL WHERE id=$2", ["The supplier returned an inconsistent CNY subtotal.", attemptId]);
        await recordEvent(persist, attemptId, owned.actor_admin_id ?? null, persistedState, "failed", "subtotal_mismatch", undefined, 40001);
      }
      if (arithmetic.rows[0]?.invalid !== true && variance.rows[0]?.held === true) {
        await persist.query("UPDATE toonies_procurement_attempts SET state='cost_hold',failure_code=40043,failure_message=$1,next_poll_at=NULL WHERE id=$2", ["The supplier returned a cost above the approved variance threshold.", attemptId]);
        await recordEvent(persist, attemptId, owned.actor_admin_id ?? null, persistedState, "cost_hold", "cost_variance_hold", undefined, 40043);
      }
      await persist.query("COMMIT");
      if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") console.info(`Procurement attempt ${attemptId}: task result committed`);
    } catch (persistError) {
      await persist.query("ROLLBACK").catch(() => undefined);
      throw persistError;
    } finally {
      persist.release();
    }
    if (terminal || pollExhausted || persistedState === "task_pending") break;
  }
  const finished = await getTooniesProcurementAttempt(attemptId);
  if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") console.info(`Procurement attempt ${attemptId}: attempt result loaded`);
  // Automatic reversal is intentionally wired only to an explicit structured
  // supplier decision. Generic failed/expired/retry-exhausted outcomes never
  // enter the financial saga.
  if (finished.state === "failed" && attempt.order_id) {
    const evidence = (await pool.query(
      "SELECT raw_snapshot AS \"rawSnapshot\" FROM toonies_procurement_attempts WHERE id=$1",
      [attemptId],
    )).rows[0]?.rawSnapshot as any;
    const documentedReason = mapDocumentedSupplierFailure(evidence?.supplierCode ?? evidence?.failure_code ?? finished.failureCode);
    if (documentedReason) {
      if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") console.info(`Procurement attempt ${attemptId}: creating supplier-failure reversal`);
      await createSupplierFailureReversal(pool, {
        orderId: attempt.order_id, attemptId, reasonCode: documentedReason,
      });
      if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") console.info(`Procurement attempt ${attemptId}: supplier-failure reversal created`);
    }
  }
  return finished;
}

export async function getTooniesProcurementAttempt(id: string) {
  const pool = getDatabasePool();
  const expiryDb = await pool.connect();
  try {
    await expiryDb.query("BEGIN");
    const expiring = (await expiryDb.query<any>("SELECT id,actor_admin_id AS \"actorAdminId\" FROM toonies_procurement_attempts WHERE id=$1 AND state='ready' AND snapshot_expires_at IS NOT NULL AND snapshot_expires_at <= now() FOR UPDATE", [id])).rows[0];
    if (expiring) {
      await expiryDb.query("UPDATE toonies_procurement_attempts SET state='expired',failure_code=40041,failure_message=$1,updated_at=now() WHERE id=$2", [publicFailure[40041], id]);
      await recordEvent(expiryDb, id, expiring.actorAdminId ?? null, "ready", "expired", "snapshot_expired", undefined, 40041);
    }
    await expiryDb.query("COMMIT");
  } catch (error) {
    await expiryDb.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    expiryDb.release();
  }
  const attempt = (await pool.query<any>("SELECT a.id,a.order_id AS \"orderId\",o.order_number AS \"orderNumber\",o.payment_status AS \"paymentStatus\",a.supplier_id AS \"supplierId\",a.client_task_no AS \"clientTaskNo\",a.generation,a.task_id AS \"taskId\",a.state,a.failure_code AS \"failureCode\",a.failure_message AS \"failureMessage\",a.snapshot_expires_at AS \"snapshotExpiresAt\",a.next_poll_at AS \"nextPollAt\",a.poll_count AS \"pollCount\",a.max_polls AS \"maxPolls\",a.retry_count AS \"retryCount\",a.max_attempts AS \"maxAttempts\",a.toonies_order_sn AS \"tooniesOrderSn\",a.settlement_status AS \"settlementStatus\",c.state AS \"commandState\",c.attempts AS \"commandAttempts\",c.max_attempts AS \"commandMaxAttempts\",a.created_at AS \"createdAt\",a.updated_at AS \"updatedAt\" FROM toonies_procurement_attempts a LEFT JOIN orders o ON o.id=a.order_id LEFT JOIN toonies_procurement_commands c ON c.order_id=a.order_id WHERE a.id=$1", [id])).rows[0];
  if (!attempt) throw new AppError(404, "TOONIES_ATTEMPT_NOT_FOUND", "The Toonies procurement attempt was not found.");
  attempt.lines = (await pool.query<any>("SELECT id,product_id AS \"productId\",variant_id AS \"variantId\",product_code AS \"productCode\",sku_code AS \"skuCode\",requested_quantity AS \"requestedQuantity\",expected_unit_cost_cny AS \"expectedUnitCostCny\",expected_subtotal_cny AS \"expectedSubtotalCny\",cost_threshold_percent AS \"costThresholdPercent\",returned_quantity AS \"returnedQuantity\",returned_moq AS \"returnedMoq\",returned_stock AS \"returnedStock\",returned_charge_cny AS \"returnedChargeCny\",returned_subtotal_cny AS \"returnedSubtotalCny\",returned_cost_variance_cny AS \"returnedCostVarianceCny\",orderable,failure_code AS \"failureCode\",failure_message AS \"failureMessage\" FROM toonies_procurement_lines WHERE attempt_id=$1 ORDER BY id", [id])).rows;
  attempt.events = (await pool.query<any>("SELECT from_state AS \"fromState\",to_state AS \"toState\",event_type AS \"eventType\",error_code AS \"errorCode\",details,created_at AS \"createdAt\" FROM toonies_procurement_events WHERE attempt_id=$1 ORDER BY created_at,id", [id])).rows;
  return attempt;
}

export async function listTooniesProcurementAttempts(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const pool = getDatabasePool();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const expiring = (await db.query<any>("SELECT id,actor_admin_id AS \"actorAdminId\" FROM toonies_procurement_attempts WHERE state='ready' AND snapshot_expires_at IS NOT NULL AND snapshot_expires_at <= now() FOR UPDATE")).rows;
    for (const attempt of expiring) {
      await db.query("UPDATE toonies_procurement_attempts SET state='expired',failure_code=40041,failure_message=$1,updated_at=now() WHERE id=$2", [publicFailure[40041], attempt.id]);
      await recordEvent(db, attempt.id, attempt.actorAdminId ?? null, "ready", "expired", "snapshot_expired", undefined, 40041);
    }
     const rows = (await db.query("SELECT a.id,a.order_id AS \"orderId\",o.order_number AS \"orderNumber\",o.payment_status AS \"paymentStatus\",a.client_task_no AS \"clientTaskNo\",a.task_id AS \"taskId\",a.generation,a.state,a.failure_code AS \"failureCode\",a.failure_message AS \"failureMessage\",a.snapshot_expires_at AS \"snapshotExpiresAt\",a.poll_count AS \"pollCount\",a.max_polls AS \"maxPolls\",a.retry_count AS \"retryCount\",a.max_attempts AS \"maxAttempts\",c.state AS \"commandState\",c.attempts AS \"commandAttempts\",c.max_attempts AS \"commandMaxAttempts\",a.created_at AS \"createdAt\",a.updated_at AS \"updatedAt\" FROM toonies_procurement_attempts a LEFT JOIN orders o ON o.id=a.order_id LEFT JOIN toonies_procurement_commands c ON c.order_id=a.order_id ORDER BY a.created_at DESC LIMIT $1", [safeLimit])).rows;
    await db.query("COMMIT");
    return rows;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

/** Claims a bounded batch for the existing background cycle. */
export async function runTooniesProcurementPollingCycle(
  batchSize = 20,
  options: { skipSettlementPhase?: boolean } = {},
) {
  if (options.skipSettlementPhase && process.env.NODE_ENV !== "test") {
    throw new Error("Skipping the Toonies settlement phase is test-only.");
  }
  const gate = await getTooniesProcurementGateStatus({ forceRefresh: true });
  if (gate.effective !== "enabled") return { claimed: 0, failed: 0 };
  const limit = Math.max(1, Math.min(100, Math.floor(batchSize)));
  const pool = getDatabasePool();
  const db = await pool.connect();
  const due: string[] = [];
  const commands: Array<{ id: string; orderId: string; token: string }> = [];
  let failed = 0;
  try {
    await db.query("BEGIN");
    const rows = (await db.query<{ id: string }>(
      `SELECT id FROM toonies_procurement_attempts
        WHERE state IN ('precheck_pending','task_pending','retry_wait') AND next_poll_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY next_poll_at,id
        FOR UPDATE SKIP LOCKED LIMIT $1`,
      [limit],
    )).rows;
    due.push(...rows.map((row) => row.id));
    const commandRows = (await db.query<{ id: string; orderId: string }>(
      `SELECT id,order_id AS "orderId" FROM toonies_procurement_commands
        WHERE (state='pending' OR (state='processing' AND lease_until < now())) AND attempts < max_attempts AND next_attempt_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit],
    )).rows;
    await db.query("UPDATE toonies_procurement_commands SET state='failed',last_error='Maximum command attempts exhausted.',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE state='processing' AND lease_until < now() AND attempts >= max_attempts");
    for (const command of commandRows) {
      const token = randomUUID();
      await db.query("UPDATE toonies_procurement_commands SET state='processing',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$2", [token, command.id]);
      commands.push({ id: command.id, orderId: command.orderId, token });
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
  for (const command of commands) {
    const { id: commandId, orderId, token } = command;
    try {
      await assertTooniesProcurementEnabled();
      const integrity = (await pool.query<any>(
        `SELECT c.order_total_fingerprint AS "commandFingerprint",o.total_fingerprint AS "orderFingerprint",
                o.payment_status AS "paymentStatus",p.order_total_fingerprint AS "paymentFingerprint",
                p.amount,p.currency,o.grand_total AS "grandTotal",(p.amount=o.grand_total) AS "amountMatches"
           FROM toonies_procurement_commands c JOIN orders o ON o.id=c.order_id
           LEFT JOIN payments p ON p.order_id=o.id AND p.status='paid'
          WHERE c.id=$1 ORDER BY p.created_at DESC LIMIT 1`, [commandId],
      )).rows[0];
      if (!integrity || integrity.paymentStatus !== "paid" || integrity.commandFingerprint !== integrity.orderFingerprint || integrity.paymentFingerprint !== integrity.orderFingerprint || integrity.currency !== "EUR" || integrity.amountMatches !== true) {
        await pool.query("UPDATE toonies_procurement_commands SET state='failed',last_error=$1,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$2 AND lease_token=$3", ["Paid order fingerprint or amount integrity mismatch.", commandId, token]);
        failed += 1;
        continue;
      }
      const currentFingerprint = await loadTooniesSupplierSnapshotFingerprint(pool, orderId);
      const commandFingerprint = (await pool.query<{ supplierSnapshotFingerprint: string }>("SELECT supplier_snapshot_fingerprint AS \"supplierSnapshotFingerprint\" FROM toonies_procurement_commands WHERE id=$1", [commandId])).rows[0]?.supplierSnapshotFingerprint;
      if (!currentFingerprint || currentFingerprint !== commandFingerprint) {
        await pool.query("UPDATE toonies_procurement_commands SET state='failed',last_error=$1,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$2 AND lease_token=$3", ["Supplier snapshot fingerprint mismatch.", commandId, token]);
        failed += 1;
        continue;
      }
      await createOrderBoundTooniesProcurementAttempt(orderId, { commandId, leaseToken: token });
      await pool.query("UPDATE toonies_procurement_commands SET state='completed',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2", [commandId, token]);
    } catch (error: any) {
      if (error instanceof AppError && error.code === "TOONIES_PROCUREMENT_MAINTENANCE") {
        await pool.query(
          "UPDATE toonies_procurement_commands SET state='pending',next_attempt_at=now()+interval '1 minute',lease_token=NULL,lease_until=NULL,last_error=$1,attempts=GREATEST(attempts-1,0),updated_at=now() WHERE id=$2 AND lease_token=$3",
          [error.message, commandId, token],
        );
        continue;
      }
      const handoff = (await pool.query<{ state: string }>("SELECT state FROM toonies_procurement_attempts WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1", [orderId])).rows[0];
      if (handoff && ["precheck_pending", "retry_wait", "task_pending", "ready", "cost_hold"].includes(handoff.state)) {
        await pool.query("UPDATE toonies_procurement_commands SET state='completed',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2", [commandId, token]);
        continue;
      }
      const retryable = error?.details?.retryable === true || (typeof error?.code === "string" && /TOONIES_(42901|50001|40040)/.test(error.code));
      await pool.query(
        "UPDATE toonies_procurement_commands SET state=CASE WHEN $4 AND attempts < max_attempts THEN 'pending' ELSE 'failed' END,next_attempt_at=now()+interval '5 seconds',lease_token=NULL,lease_until=NULL,last_error=$1,updated_at=now() WHERE id=$2 AND lease_token=$3",
        [String(error?.message ?? error).slice(0, 1000), commandId, token, retryable],
      );
      failed += 1;
    }
  }
  for (const id of due) {
    try {
      const state = (await pool.query<{ state: string; taskId: string | null; actorAdminId: string | null }>("SELECT state,task_id AS \"taskId\",actor_admin_id AS \"actorAdminId\" FROM toonies_procurement_attempts WHERE id=$1", [id])).rows[0];
      if (state && !state.taskId && ["precheck_pending", "retry_wait"].includes(state.state)) await submitPrecheck(id, state.actorAdminId);
      else if (state?.taskId) await pollTooniesProcurementAttemptInternal(id, 1, true);
    } catch {
      failed += 1;
    }
  }
  if (options.skipSettlementPhase) return { claimed: due.length + commands.length, failed };
  // Stage 3 is independently gated; when disabled this query is harmless and
  // no supplier create request can be reached.
  if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") console.info("Procurement cycle: reading settlement gate");
  const settlementGate = await getTooniesSettlementGateStatus();
  if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") console.info(`Procurement cycle: settlement gate ${settlementGate.effective}`);
  if (settlementGate.effective === "enabled") {
    if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") {
      console.info(`Procurement cycle: before settlement recovery total=${(pool as any).totalCount} idle=${(pool as any).idleCount} waiting=${(pool as any).waitingCount}`);
    }
    await recoverExpiredTooniesSubmittingSettlements(limit);
    if (process.env.NEON_REVERSAL_MATRIX_DIAGNOSTICS === "1") console.info("Procurement cycle: expired settlements recovered");
    const ready = (await pool.query<{ id: string }>(
      `SELECT id FROM toonies_procurement_attempts
        WHERE state='ready' AND order_id IS NOT NULL
          AND (snapshot_expires_at IS NULL OR snapshot_expires_at > now())
        ORDER BY updated_at,id LIMIT $1`, [limit],
    )).rows;
    for (const attempt of ready) {
      try { await settleTooniesProcurementAttempt(attempt.id); } catch { failed += 1; }
    }
    const unknown = (await pool.query<{ id: string }>(
      `SELECT id FROM toonies_settlements
        WHERE state IN ('transmitted_unknown','reconciling') AND (next_reconciliation_at IS NULL OR next_reconciliation_at <= now())
        ORDER BY updated_at,id LIMIT $1`, [limit],
    )).rows;
    for (const settlement of unknown) {
      try {
        await reconcileTooniesSettlement(settlement.id);
      } catch { failed += 1; }
    }
  }
  return { claimed: due.length + commands.length, failed };
}