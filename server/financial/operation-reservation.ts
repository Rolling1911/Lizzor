import { randomUUID } from "node:crypto";
import { AppError } from "../middleware/error-handler.js";

export type FinancialOperationType = "supplier_settlement" | "payment_refund" | "payment_invalidation" | "payment_cancellation";
export type FinancialOperationDb = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> };
let financialOperationTestPause: (() => Promise<void>) | undefined;
export function setFinancialOperationTestPause(pause: (() => Promise<void>) | undefined): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Financial operation pause seam is test-only.");
  financialOperationTestPause = pause;
}
export async function pauseAfterFinancialOperationReservation(): Promise<void> {
  if (process.env.NODE_ENV === "test" && financialOperationTestPause) await financialOperationTestPause();
}

export async function acquireFinancialOperation(db: FinancialOperationDb, input: { orderId: string; operationType: FinancialOperationType; operationReferenceId: string; leaseSeconds?: number; allowReleasedRetry?: boolean }) {
  const token = randomUUID();
  const seconds = Math.max(30, Math.min(3600, input.leaseSeconds ?? 120));
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [input.orderId]);
  const existing = await db.query(
    `SELECT id,order_id AS "orderId",operation_type AS "operationType",operation_reference_id AS "operationReferenceId",
            state,phase,transmission_started_at AS "transmissionStartedAt",lease_token AS "leaseToken",lease_until AS "leaseUntil",version
       FROM financial_operation_reservations WHERE operation_type=$1::financial_operation_type AND operation_reference_id=$2 FOR UPDATE`,
    [input.operationType, input.operationReferenceId],
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (row.state === "released" && input.allowReleasedRetry) {
      const retried = await db.query(
        `UPDATE financial_operation_reservations SET state='active',phase='reserved',transmission_started_at=NULL,
           lease_token=$1,lease_until=now()+($2 || ' seconds')::interval,version=version+1,completed_at=NULL,updated_at=now()
         WHERE id=$3 AND state='released' AND version=$4
         RETURNING id,order_id AS "orderId",operation_type AS "operationType",operation_reference_id AS "operationReferenceId",
           state,phase,transmission_started_at AS "transmissionStartedAt",lease_token AS "leaseToken",lease_until AS "leaseUntil",version`,
        [token, seconds, row.id, row.version],
      );
      if (retried.rowCount) return retried.rows[0];
    }
    if (row.state === "ambiguous" || row.phase === "transmitting" || row.transmissionStartedAt) {
      throw new AppError(409, "FINANCIAL_OPERATION_AMBIGUOUS", "An ambiguous external financial effect must be reconciled before retrying.");
    }
    if (row.state !== "active") throw new AppError(409, "FINANCIAL_OPERATION_ALREADY_TERMINAL", "This idempotent financial operation already has a terminal outcome.");
    if (row.leaseToken && row.leaseUntil && new Date(row.leaseUntil).getTime() > Date.now()) {
      throw new AppError(409, "FINANCIAL_OPERATION_OWNED", "This financial operation is owned by another live worker.");
    }
    const renewed = await db.query(
      `UPDATE financial_operation_reservations SET lease_token=$1,lease_until=now()+($2 || ' seconds')::interval,version=version+1,updated_at=now()
        WHERE id=$3 AND state='active' AND phase='reserved' AND transmission_started_at IS NULL AND version=$4
        RETURNING id,order_id AS "orderId",operation_type AS "operationType",operation_reference_id AS "operationReferenceId",
          state,phase,transmission_started_at AS "transmissionStartedAt",lease_token AS "leaseToken",lease_until AS "leaseUntil",version`,
      [token, seconds, row.id, row.version],
    );
    if (!renewed.rowCount) throw new AppError(409, "FINANCIAL_OPERATION_AMBIGUOUS", "The expired reservation cannot be safely reclaimed.");
    return renewed.rows[0];
  }
  const result = await db.query(
    `INSERT INTO financial_operation_reservations
       (order_id,operation_type,operation_reference_id,state,phase,lease_token,lease_until,version)
     VALUES ($1,$2::financial_operation_type,$3,'active','reserved',$4,now()+($5 || ' seconds')::interval,0)
     ON CONFLICT (order_id) WHERE state IN ('active','ambiguous','completed') DO NOTHING
     RETURNING id,order_id AS "orderId",operation_type AS "operationType",operation_reference_id AS "operationReferenceId",
       state,phase,transmission_started_at AS "transmissionStartedAt",lease_token AS "leaseToken",lease_until AS "leaseUntil",version`,
    [input.orderId, input.operationType, input.operationReferenceId, token, seconds],
  );
  if (!result.rowCount) throw new AppError(409, "FINANCIAL_OPERATION_CONFLICT", "Another financial operation is already active for this order.");
  return result.rows[0];
}

export async function markFinancialOperationTransmitting(db: FinancialOperationDb, input: { id: string; leaseToken: string; version: number }) {
  const result = await db.query(
    `UPDATE financial_operation_reservations SET phase='transmitting',transmission_started_at=now(),version=version+1,updated_at=now()
      WHERE id=$1 AND state='active' AND phase='reserved' AND lease_token=$2 AND version=$3 RETURNING id,version`,
    [input.id, input.leaseToken, input.version],
  );
  if (!result.rowCount) throw new AppError(409, "FINANCIAL_OPERATION_LEASE_LOST", "The reservation is no longer owned before external I/O.");
  return result.rows[0];
}

export async function transitionFinancialOperation(db: FinancialOperationDb, input: { id: string; leaseToken: string; version: number; state: "active" | "ambiguous" | "completed" | "failed" | "released"; failureCode?: string; failureMessage?: string; recoveryEvidence?: unknown }) {
  const result = await db.query(
    `UPDATE financial_operation_reservations SET state=$1::financial_operation_state,
       phase=CASE WHEN $1='ambiguous' THEN 'ambiguous' WHEN $1 IN ('completed','failed','released') THEN 'terminal' ELSE phase END,
       failure_code=$2,failure_message=$3,recovery_evidence=$4,
       completed_at=CASE WHEN $1 IN ('completed','failed','released') THEN COALESCE(completed_at,now()) ELSE completed_at END,
       lease_token=CASE WHEN $1 IN ('ambiguous','completed') THEN lease_token ELSE NULL END,
       lease_until=CASE WHEN $1 IN ('ambiguous','completed') THEN lease_until ELSE NULL END,
       version=version+1,updated_at=now()
     WHERE id=$5 AND state IN ('active','ambiguous') AND lease_token=$6 AND version=$7 RETURNING *`,
    [input.state, input.failureCode ?? null, input.failureMessage?.slice(0, 2000) ?? null, input.recoveryEvidence ?? null, input.id, input.leaseToken, input.version],
  );
  if (!result.rowCount) {
    const terminal = await db.query("SELECT state FROM financial_operation_reservations WHERE id=$1", [input.id]);
    if (terminal.rowCount && ["completed", "failed", "released"].includes(terminal.rows[0].state)) return terminal.rows[0];
    throw new AppError(409, "FINANCIAL_OPERATION_LEASE_LOST", "The financial operation reservation is no longer owned.");
  }
  return result.rows[0];
}