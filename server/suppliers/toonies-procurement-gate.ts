import type { Pool, PoolClient } from "pg";
import { databaseConfigured, env } from "../config/env.js";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";

export type TooniesProcurementGateStatus = {
  configured: "enabled" | "disabled";
  databaseAttestation: "pass" | "fail" | "not_checked";
  effective: "enabled" | "disabled";
  checkedAt: string | null;
  reason: "configured_disabled" | "database_not_configured" | "database_attestation_failed" | "ready";
};

export type TooniesSettlementGateStatus = {
  configured: "enabled" | "disabled";
  effective: "enabled" | "disabled";
  databaseAttestation: "pass" | "fail" | "not_checked";
  reason: TooniesProcurementGateStatus["reason"] | "settlement_disabled" | "settlement_schema_missing";
};

type AttestationFacts = {
  columnsOk: boolean;
  commandsTableOk: boolean;
  stateConstraintDefinition: string | null;
  triggerCountOk: boolean;
  triggerDefinitionOk: boolean;
  functionOk: boolean;
};

const EXPECTED_ATTEMPT_STATES = [
  "created", "validating", "precheck_pending", "task_pending", "ready",
  "cost_hold", "failed", "expired", "retry_wait",
].sort();

export function validTooniesAttemptStateConstraint(definition: string | null): boolean {
  if (!definition) return false;
  const match = definition.match(
    /^CHECK\s*\(\s*(\()?\s*state\s*::\s*text\s*=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]+?)\]\s*(?:::\s*text\s*\[\s*\])?\s*\)\s*(\))?\s*\)\s*$/,
  );
  if (!match) return false;
  if (Boolean(match[1]) !== Boolean(match[3])) return false;

  const states = match[2]!.split(",").map((literal) => {
    const literalMatch = literal.match(
      /^\s*'([a-z_]+)'\s*(?:::\s*character\s+varying(?:\s*::\s*text)?|::\s*text)?\s*$/,
    );
    return literalMatch?.[1];
  });
  if (states.some((state) => state === undefined)) return false;

  const actualStates = new Set(states as string[]);
  return states.length === EXPECTED_ATTEMPT_STATES.length
    && actualStates.size === EXPECTED_ATTEMPT_STATES.length
    && EXPECTED_ATTEMPT_STATES.every((state) => actualStates.has(state));
}

const SETTLEMENT_STATES = ["not_submitted", "submitting", "transmitted_unknown", "reconciling", "replay_pending", "confirmed", "manual_review"];
export function validTooniesSettlementPartialPredicate(predicate: string | null): boolean {
  if (!predicate) return false;
  const normalized = predicate.replace(/\s+/g, " ").trim();
  const expression = normalized.match(/^\(*state\s*=\s*ANY\s*\(\s*ARRAY\[(.*?)\]\s*(?:::\s*[a-z_]+\[\])?\s*\)\)*$/i);
  if (!expression) return false;
  const matches = [...expression[1]!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  return matches.length === SETTLEMENT_STATES.length
    && new Set(matches).size === SETTLEMENT_STATES.length
    && SETTLEMENT_STATES.every((state) => matches.includes(state))
    && /\bIN\b|\bANY\b/.test(normalized);
}

const FINANCIAL_ACTIVE_STATES = ["active", "ambiguous", "completed"];
export function validFinancialOperationPartialPredicate(predicate: string | null): boolean {
  if (!predicate) return false;
  const normalized = predicate.replace(/\s+/g, " ").trim();
  const expression = normalized.match(/^\(*state\s*=\s*ANY\s*\(\s*ARRAY\[(.*?)\]\s*(?:::\s*[a-z_]+\[\])?\s*\)\)*$/i);
  if (!expression) return false;
  const states = expression[1]!.split(",").map((literal) => {
    const literalMatch = literal.match(/^\s*'([a-z_]+)'\s*::\s*financial_operation_state\s*$/);
    return literalMatch?.[1];
  });
  return states.every((state) => state !== undefined)
    && states.length === FINANCIAL_ACTIVE_STATES.length
    && new Set(states as string[]).size === FINANCIAL_ACTIVE_STATES.length
    && FINANCIAL_ACTIVE_STATES.every((state) => states.includes(state));
}

const FINANCIAL_PHASES = ["reserved", "transmitting", "ambiguous", "terminal"];
export function validFinancialOperationPhaseConstraint(definition: string | null): boolean {
  if (!definition) return false;
  const match = definition.match(
    /^CHECK\s*\(\s*phase\s*::\s*text\s*=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]+?)\]\s*(?:::\s*text\s*\[\s*\])?\s*\)\s*\)\s*$/,
  );
  if (!match) return false;
  const phases = match[1]!.split(",").map((literal) => {
    const literalMatch = literal.match(/^\s*'([a-z_]+)'\s*(?:::\s*character\s+varying(?:\s*::\s*text)?|::\s*text)?\s*$/);
    return literalMatch?.[1];
  });
  return phases.every((phase) => phase !== undefined)
    && phases.length === FINANCIAL_PHASES.length
    && new Set(phases as string[]).size === FINANCIAL_PHASES.length
    && FINANCIAL_PHASES.every((phase) => phases.includes(phase));
}

const ATTESTATION_CACHE_MS = 30_000;
let cached: { status: TooniesProcurementGateStatus; checkedAtMs: number } | undefined;
let refresh: Promise<TooniesProcurementGateStatus> | undefined;

export function resetTooniesProcurementGateCacheForTests(): void {
  cached = undefined;
  refresh = undefined;
}

export function resolveTooniesProcurementGateStatus(
  configured: boolean,
  attested: boolean,
  checkedAt: string | null = null,
): TooniesProcurementGateStatus {
  if (!configured) {
    return {
      configured: "disabled",
      databaseAttestation: "not_checked",
      effective: "disabled",
      checkedAt: null,
      reason: "configured_disabled",
    };
  }
  if (!attested) {
    return {
      configured: "enabled",
      databaseAttestation: "fail",
      effective: "disabled",
      checkedAt,
      reason: databaseConfigured ? "database_attestation_failed" : "database_not_configured",
    };
  }
  return {
    configured: "enabled",
    databaseAttestation: "pass",
    effective: "enabled",
    checkedAt,
    reason: "ready",
  };
}

async function readAttestationFacts(): Promise<AttestationFacts> {
  const result = await getDatabasePool().query<AttestationFacts>(`
    SELECT
      (SELECT count(*) = 10
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='order_items'
          AND column_name IN (
            'supplier_product_link_id','supplier_id','supplier_catalogue_item_id','supplier_catalogue_variant_id',
            'supplier_product_code','supplier_sku_code','supplier_cost_eur','supplier_cost_cny',
            'supplier_cost_provenance','supplier_cost_threshold_percent'
          )) AS "columnsOk",
      to_regclass('public.toonies_procurement_commands') IS NOT NULL AS "commandsTableOk",
      (SELECT pg_get_constraintdef(c.oid, true) FROM pg_constraint c
        JOIN pg_class r ON r.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname='public' AND r.relname='toonies_procurement_attempts'
          AND c.conname='toonies_procurement_attempts_state_valid_v2' AND c.contype='c'
        LIMIT 1
      ) AS "stateConstraintDefinition",
      (SELECT count(*) = 1 FROM pg_trigger t
        JOIN pg_class r ON r.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname='public' AND r.relname='order_items'
          AND t.tgname='order_items_toonies_snapshot_immutable' AND NOT t.tgisinternal
      ) AS "triggerCountOk",
      EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class r ON r.oid=t.tgrelid
        JOIN pg_namespace rn ON rn.oid=r.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid
        JOIN pg_namespace pn ON pn.oid=p.pronamespace
        WHERE rn.nspname='public' AND r.relname='order_items'
          AND t.tgname='order_items_toonies_snapshot_immutable' AND NOT t.tgisinternal
          AND t.tgenabled='O'
          AND t.tgtype=19
          AND pn.nspname='public' AND p.proname='prevent_toonies_snapshot_mutation'
          AND p.prorettype='pg_catalog.trigger'::regtype
      ) AS "triggerDefinitionOk",
      EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='prevent_toonies_snapshot_mutation'
          AND pg_get_function_identity_arguments(p.oid)='' AND p.prorettype='pg_catalog.trigger'::regtype
       ) AS "functionOk"
  `);
  return result.rows[0]!;
}

async function refreshStatus(): Promise<TooniesProcurementGateStatus> {
  if (!env.TOONIES_ORDER_BOUND_PROCUREMENT_ENABLED) {
    const status = resolveTooniesProcurementGateStatus(false, false);
    cached = { status, checkedAtMs: Date.now() };
    return status;
  }
  if (!databaseConfigured) {
    const status = resolveTooniesProcurementGateStatus(true, false);
    cached = { status, checkedAtMs: Date.now() };
    return status;
  }
  const checkedAt = new Date().toISOString();
  try {
    const facts = await readAttestationFacts();
    const attested = facts.columnsOk
      && facts.commandsTableOk
      && validTooniesAttemptStateConstraint(facts.stateConstraintDefinition)
      && facts.triggerCountOk
      && facts.triggerDefinitionOk
      && facts.functionOk;
    const status = resolveTooniesProcurementGateStatus(true, attested, checkedAt);
    cached = { status, checkedAtMs: Date.now() };
    return status;
  } catch {
    const status = resolveTooniesProcurementGateStatus(true, false, checkedAt);
    cached = { status, checkedAtMs: Date.now() };
    return status;
  }
}

export async function getTooniesProcurementGateStatus(options: { forceRefresh?: boolean } = {}) {
  if (!env.TOONIES_ORDER_BOUND_PROCUREMENT_ENABLED) {
    return resolveTooniesProcurementGateStatus(false, false);
  }
  if (!options.forceRefresh && cached && Date.now() - cached.checkedAtMs < ATTESTATION_CACHE_MS) return cached.status;
  refresh ??= refreshStatus().finally(() => { refresh = undefined; });
  return refresh;
}

export async function assertTooniesProcurementEnabled(): Promise<void> {
  const status = await getTooniesProcurementGateStatus({ forceRefresh: true });
  if (status.effective !== "enabled") {
    throw new AppError(503, "TOONIES_PROCUREMENT_MAINTENANCE", "Toonies procurement is temporarily unavailable.", { retryable: true });
  }
}

export async function getTooniesSettlementGateStatus(options: { forceRefresh?: boolean } = {}): Promise<TooniesSettlementGateStatus> {
  const procurement = await getTooniesProcurementGateStatus(options);
  if (!env.TOONIES_ORDER_SETTLEMENT_ENABLED) {
    return { configured: "disabled", effective: "disabled", databaseAttestation: procurement.databaseAttestation, reason: "settlement_disabled" };
  }
  if (procurement.effective !== "enabled") {
    return { configured: "enabled", effective: "disabled", databaseAttestation: procurement.databaseAttestation, reason: procurement.reason };
  }
  if (!databaseConfigured) {
    return { configured: "enabled", effective: "disabled", databaseAttestation: "fail", reason: "settlement_schema_missing" };
  }
  try {
    const result = await getDatabasePool().query<any>(`
      SELECT
        (SELECT count(*) = 48 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='toonies_settlements'
            AND column_name IN ('id','order_id','command_id','attempt_id','supplier_id','generation','task_id','api_order_sn','canonical_request','canonical_basket','expected_product_sum','expected_shipping_fee','expected_total_sum','request_hash','basket_fingerprint','destination_fingerprint','order_total_fingerprint','supplier_snapshot_fingerprint','state','confirmation_kind','lease_token','lease_until','version','first_submission_at','last_transmission_at','confirmed_at','transmission_count','reconciliation_count','next_reconciliation_at','reconciliation_source','reconciliation_page','reconciliation_date_start','reconciliation_date_end','reconciliation_exhausted','order_sn','trade_order_sn','supplier_status','pay_status','currency','product_sum','shipping_fee','total_sum','total_weight','response_evidence','failure_code','failure_message','created_at','updated_at')) AS columns_ok,
        to_regclass('public.toonies_settlements') IS NOT NULL AS settlements,
        to_regclass('public.toonies_settlement_evidence') IS NOT NULL AS evidence,
          (to_regclass('public.financial_operation_reservations') IS NOT NULL
           AND EXISTS (SELECT 1 FROM pg_index i
             WHERE i.indisunique AND i.indexrelid='public.financial_operation_reservations_order_active_unique'::regclass
                 AND ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
                          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)::text[]=ARRAY['order_id']::text[])
           AND EXISTS (SELECT 1 FROM pg_index i
             WHERE i.indisunique AND i.indexrelid='public.financial_operation_reservations_reference_unique'::regclass
                AND ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
                         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord)::text[]=ARRAY['operation_type','operation_reference_id']::text[])
            AND (SELECT count(*) = 6 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='financial_operation_reservations'
                    AND column_name IN ('order_id','operation_type','operation_reference_id','state','phase','transmission_started_at'))
            AND (SELECT count(*) = 5 AND bool_and(is_nullable='NO') FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='financial_operation_reservations'
                     AND column_name IN ('order_id','operation_type','operation_reference_id','state','phase'))
           AND (SELECT count(*) = 5 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                  WHERE t.typname='financial_operation_state' AND e.enumlabel IN ('active','ambiguous','completed','failed','released'))) AS financial_interlock_ok,
          (SELECT pg_get_expr(i.indpred,i.indrelid,true) FROM pg_index i
            WHERE i.indexrelid='public.financial_operation_reservations_order_active_unique'::regclass) AS financial_partial_predicate,
          (SELECT pg_get_constraintdef(c.oid,true) FROM pg_constraint c
            WHERE c.conrelid='public.financial_operation_reservations'::regclass
              AND c.conname='financial_operation_reservations_phase_check' AND c.contype='c') AS financial_phase_constraint,
         (SELECT count(*) = 2 AND bool_and(
             (c.conname='toonies_settlements_confirmed_facts' AND pg_get_constraintdef(c.oid,true) LIKE '%state%confirmed%order_sn%IS NOT NULL%currency%''CNY''%confirmation_kind%IS NOT NULL%')
             OR (c.conname='toonies_settlements_expected_amounts_nonnegative' AND pg_get_constraintdef(c.oid,true) LIKE '%expected_product_sum%>=%0%expected_shipping_fee%>=%0%expected_total_sum%>=%0%')
           )
           FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
           WHERE n.nspname='public' AND r.relname='toonies_settlements' AND c.conname IN ('toonies_settlements_confirmed_facts','toonies_settlements_expected_amounts_nonnegative')) AS constraints_ok,
        (SELECT count(*) = 1 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
          WHERE n.nspname='public' AND r.relname='toonies_settlements' AND r.relkind='r') AS table_kind_ok,
        (SELECT count(*) = 1 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
          WHERE n.nspname='public' AND r.relname='toonies_settlement_evidence' AND r.relkind='r') AS evidence_kind_ok,
        (SELECT pg_get_expr(i.indpred, i.indrelid, true)
           FROM pg_index i JOIN pg_class r ON r.oid=i.indexrelid JOIN pg_namespace n ON n.oid=r.relnamespace
           JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum,n) ON true
           JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=x.attnum
          WHERE n.nspname='public' AND r.relname='toonies_settlements_order_unresolved_unique'
          GROUP BY i.indisunique,i.indpred,i.indrelid) AS partial_predicate,
        (SELECT i.indisunique AND array_agg(a.attname::text ORDER BY x.n) = ARRAY['order_id']
           FROM pg_index i JOIN pg_class r ON r.oid=i.indexrelid JOIN pg_namespace n ON n.oid=r.relnamespace
           JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum,n) ON true
           JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=x.attnum
          WHERE n.nspname='public' AND r.relname='toonies_settlements_order_unresolved_unique'
          GROUP BY i.indisunique,i.indrelid) AS partial_index_columns_ok,
         (SELECT i.indisunique AND array_agg(a.attname::text ORDER BY x.n) = ARRAY['supplier_id','api_order_sn']
            FROM pg_index i JOIN pg_class r ON r.oid=i.indexrelid JOIN pg_namespace n ON n.oid=r.relnamespace
            JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum,n) ON true
            JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=x.attnum
           WHERE n.nspname='public' AND r.relname='toonies_settlements_supplier_api_order_unique'
           GROUP BY i.indisunique,i.indrelid) AS supplier_api_index_columns_ok,
        (SELECT count(*) = 2 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
          WHERE n.nspname='public' AND r.relname IN ('toonies_settlements_order_unresolved_unique','toonies_settlements_supplier_api_order_unique')) AS indexes_ok,
         EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='public' AND r.relname='toonies_settlement_evidence' AND t.tgname='toonies_settlement_evidence_append_only' AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=27 AND pn.nspname='public' AND p.proname='prevent_toonies_settlement_evidence_mutation' AND p.prorettype='pg_catalog.trigger'::regtype AND pg_get_functiondef(p.oid) LIKE '%append-only%') AS evidence_trigger_ok,
         EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='public' AND r.relname='toonies_settlements' AND t.tgname='toonies_settlement_identity_immutable' AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=19 AND pn.nspname='public' AND p.proname='prevent_toonies_settlement_identity_mutation' AND p.prorettype='pg_catalog.trigger'::regtype AND pg_get_functiondef(p.oid) LIKE '%settlement authority is immutable%') AS identity_trigger_ok,
         EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='public' AND r.relname='toonies_settlements' AND t.tgname='toonies_settlement_terminal_transition' AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=19 AND pn.nspname='public' AND p.proname='prevent_toonies_settlement_terminal_transition' AND p.prorettype='pg_catalog.trigger'::regtype AND pg_get_functiondef(p.oid) LIKE '%confirmed Toonies settlement is terminal%' AND pg_get_functiondef(p.oid) LIKE '%unresolved Toonies settlement%') AS terminal_trigger_ok,
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='prevent_toonies_settlement_evidence_mutation' AND pg_get_function_identity_arguments(p.oid)='' AND p.prorettype='pg_catalog.trigger'::regtype AND pg_get_functiondef(p.oid) LIKE '%RAISE EXCEPTION%') AS evidence_function_ok,
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='prevent_toonies_settlement_identity_mutation' AND pg_get_function_identity_arguments(p.oid)='' AND p.prorettype='pg_catalog.trigger'::regtype AND pg_get_functiondef(p.oid) LIKE '%NEW.order_id IS DISTINCT FROM OLD.order_id%') AS identity_function_ok
    `);
    const row = result.rows[0];
     const valid = row?.columns_ok === true && row.settlements === true && row.evidence === true
       && row.financial_interlock_ok === true
       && validFinancialOperationPartialPredicate(row.financial_partial_predicate)
       && validFinancialOperationPhaseConstraint(row.financial_phase_constraint)
      && row.constraints_ok === true && row.table_kind_ok === true && row.evidence_kind_ok === true
      && row.indexes_ok === true && row.evidence_trigger_ok === true && row.identity_trigger_ok === true
      && row.evidence_function_ok === true && row.identity_function_ok === true
      && row.terminal_trigger_ok === true
       && row.partial_index_columns_ok === true
       && row.supplier_api_index_columns_ok === true
      && validTooniesSettlementPartialPredicate(row.partial_predicate);
    return { configured: "enabled", effective: valid ? "enabled" : "disabled", databaseAttestation: valid ? "pass" : "fail", reason: valid ? "ready" : "settlement_schema_missing" };
  } catch {
    return { configured: "enabled", effective: "disabled", databaseAttestation: "fail", reason: "settlement_schema_missing" };
  }
}

export async function assertTooniesSettlementEnabled(): Promise<void> {
  const status = await getTooniesSettlementGateStatus({ forceRefresh: true });
  if (status.effective !== "enabled") {
    throw new AppError(503, "TOONIES_SETTLEMENT_MAINTENANCE", "Toonies order settlement is disabled.", { retryable: false });
  }
}

type QueryClient = Pick<Pool | PoolClient, "query">;

export async function orderRequiresTooniesProcurement(db: QueryClient, orderId: string): Promise<boolean> {
  const snapshotAvailable = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='order_items' AND column_name='supplier_id'
     ) AS available`,
  );
  if (snapshotAvailable.rows[0]?.available === true) {
    const snapshotResult = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM order_items oi
         LEFT JOIN suppliers snapshot_supplier ON snapshot_supplier.id=oi.supplier_id
         WHERE oi.order_id=$1
           AND (
             snapshot_supplier.slug='toonies'
             OR (
               oi.supplier_id IS NULL AND EXISTS (
                 SELECT 1 FROM supplier_product_links l
                 JOIN suppliers linked_supplier ON linked_supplier.id=l.supplier_id AND linked_supplier.slug='toonies'
                 WHERE l.product_id=oi.product_id AND l.variant_id IS NOT DISTINCT FROM oi.variant_id
               )
             )
           )
       ) AS required`,
      [orderId],
    );
    return snapshotResult.rows[0]?.required === true;
  }
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM order_items oi
       JOIN supplier_product_links l ON l.product_id=oi.product_id AND l.variant_id IS NOT DISTINCT FROM oi.variant_id
       JOIN suppliers s ON s.id=l.supplier_id AND s.slug='toonies'
       WHERE oi.order_id=$1
     ) AS required`,
    [orderId],
  );
  return result.rows[0]?.required === true;
}

export async function assertTooniesOrderPaymentEnabled(db: QueryClient, orderId: string): Promise<boolean> {
  const required = await orderRequiresTooniesProcurement(db, orderId);
  if (required) await assertTooniesProcurementEnabled();
  return required;
}