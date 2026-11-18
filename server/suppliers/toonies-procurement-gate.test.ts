import assert from "node:assert/strict";
import { parseExplicitEnabledFlag } from "../config/env.js";
import {
  resolveTooniesProcurementGateStatus,
  validFinancialOperationPartialPredicate,
  validFinancialOperationPhaseConstraint,
  validTooniesAttemptStateConstraint,
  validTooniesSettlementPartialPredicate,
} from "./toonies-procurement-gate.js";

assert.equal(parseExplicitEnabledFlag(undefined), false);
assert.equal(parseExplicitEnabledFlag(""), false);
assert.equal(parseExplicitEnabledFlag("TRUE"), false);
assert.equal(parseExplicitEnabledFlag("yes"), false);
assert.equal(parseExplicitEnabledFlag("false"), false);
assert.equal(parseExplicitEnabledFlag(false), false);
assert.equal(parseExplicitEnabledFlag(true), false);
assert.equal(parseExplicitEnabledFlag("true"), true);

assert.deepEqual(resolveTooniesProcurementGateStatus(false, false), {
  configured: "disabled",
  databaseAttestation: "not_checked",
  effective: "disabled",
  checkedAt: null,
  reason: "configured_disabled",
});
assert.equal(resolveTooniesProcurementGateStatus(true, false, "2026-09-17T00:00:00.000Z").effective, "disabled");
assert.equal(resolveTooniesProcurementGateStatus(true, false, "2026-09-17T00:00:00.000Z").databaseAttestation, "fail");
assert.equal(resolveTooniesProcurementGateStatus(true, true, "2026-09-17T00:00:00.000Z").effective, "enabled");
assert.equal(resolveTooniesProcurementGateStatus(true, true, "2026-09-17T00:00:00.000Z").databaseAttestation, "pass");
const canonicalStates = "'created','validating','precheck_pending','task_pending','ready','cost_hold','failed','expired','retry_wait'";
const productionStates = "'created'::character varying::text, 'validating'::character varying::text, 'precheck_pending'::character varying::text, 'task_pending'::character varying::text, 'ready'::character varying::text, 'cost_hold'::character varying::text, 'failed'::character varying::text, 'expired'::character varying::text, 'retry_wait'::character varying::text";
const developmentStates = "'created'::character varying, 'validating'::character varying, 'precheck_pending'::character varying, 'task_pending'::character varying, 'ready'::character varying, 'cost_hold'::character varying, 'failed'::character varying, 'expired'::character varying, 'retry_wait'::character varying";

assert.equal(validTooniesAttemptStateConstraint(`CHECK (state::text = ANY (ARRAY[${productionStates}]))`), true);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (state::text = ANY (ARRAY[${canonicalStates}]::text[]))`), true);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (state::text = ANY (ARRAY[${developmentStates}]::text[]))`), true);
assert.equal(validTooniesAttemptStateConstraint("CHECK (state::text = ANY (ARRAY['retry_wait','expired','failed','cost_hold','ready','task_pending','precheck_pending','validating','created']::text[]))"), true);
assert.equal(validTooniesAttemptStateConstraint("CHECK (state <> 'cost_hold')"), false);
assert.equal(validTooniesAttemptStateConstraint("CHECK (state::text = ANY (ARRAY['created','validating','precheck_pending','task_pending','ready','failed','expired','retry_wait']::text[]))"), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (state::text = ANY (ARRAY[${canonicalStates},'unexpected']::text[]))`), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (state::text = ANY (ARRAY[${canonicalStates},'created']::text[]))`), false);
assert.equal(validTooniesAttemptStateConstraint("CHECK (state::text = ANY (ARRAY['created',]::text[]))"), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (state::text = ANY (ARRAY['cre ated','validating','precheck_pending','task_pending','ready','cost_hold','failed','expired','retry_wait']::text[]))`), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (state::text = ANY (ARRAY['cre\nated','validating','precheck_pending','task_pending','ready','cost_hold','failed','expired','retry_wait']::text[]))`), false);
assert.equal(validTooniesAttemptStateConstraint(`CH ECK (state::text = ANY (ARRAY[${canonicalStates}]::text[]))`), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (sta te::text = ANY (ARRAY[${canonicalStates}]::text[]))`), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (other_state::text = ANY (ARRAY[${canonicalStates}]::text[]))`), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (NOT (state::text = ANY (ARRAY[${canonicalStates}]::text[])))`), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK ((state::text = ANY (ARRAY[${canonicalStates}]::text[])) AND false)`), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK ((state::text = ANY (ARRAY[${canonicalStates}]::text[]))`), false);
const settlementStates = "'not_submitted'::toonies_settlement_state,'submitting'::toonies_settlement_state,'transmitted_unknown'::toonies_settlement_state,'reconciling'::toonies_settlement_state,'replay_pending'::toonies_settlement_state,'confirmed'::toonies_settlement_state,'manual_review'::toonies_settlement_state";
assert.equal(validTooniesSettlementPartialPredicate(`(state = ANY (ARRAY[${settlementStates}]::toonies_settlement_state[]))`), true);
assert.equal(validTooniesSettlementPartialPredicate(`(state = ANY (ARRAY[${settlementStates}]::toonies_settlement_state[])) AND false`), false);
assert.equal(validTooniesSettlementPartialPredicate(`(state = ANY (ARRAY['confirmed'::toonies_settlement_state]::toonies_settlement_state[]))`), false);
const financialStates = "'active'::financial_operation_state,'ambiguous'::financial_operation_state,'completed'::financial_operation_state";
assert.equal(validFinancialOperationPartialPredicate(`state = ANY (ARRAY[${financialStates}]::financial_operation_state[])`), true);
assert.equal(validFinancialOperationPartialPredicate(`(state = ANY (ARRAY[${financialStates}]::financial_operation_state[])) AND false`), false);
assert.equal(validFinancialOperationPartialPredicate("state = ANY (ARRAY['active'::financial_operation_state,'completed'::financial_operation_state])"), false);
assert.equal(validFinancialOperationPartialPredicate("state = ANY (ARRAY[CASE WHEN false THEN 'active'::financial_operation_state END,'ambiguous'::financial_operation_state,'completed'::financial_operation_state])"), false);
const financialPhases = "'reserved'::character varying,'transmitting'::character varying,'ambiguous'::character varying,'terminal'::character varying";
assert.equal(validFinancialOperationPhaseConstraint(`CHECK (phase::text = ANY (ARRAY[${financialPhases}]::text[]))`), true);
assert.equal(validFinancialOperationPhaseConstraint(`CHECK ((phase::text = ANY (ARRAY[${financialPhases}]::text[])) AND false)`), false);
assert.equal(validTooniesAttemptStateConstraint(`CHECK (state::text = ANY (ARRAY[${canonicalStates}]::text[])))`), false);

console.log("Toonies procurement deployment gate parsing and status checks passed.");