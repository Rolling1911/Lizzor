CREATE TYPE toonies_settlement_state AS ENUM (
  'not_submitted','submitting','transmitted_unknown','reconciling',
  'replay_pending','confirmed','documented_rejection','manual_review'
);
CREATE TYPE toonies_settlement_confirmation_kind AS ENUM ('original','duplicate');

CREATE TABLE toonies_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL REFERENCES toonies_procurement_commands(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES toonies_procurement_attempts(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK (generation > 0),
  task_id varchar(32) NOT NULL,
  api_order_sn varchar(64) NOT NULL CHECK (api_order_sn ~ '^[A-Za-z0-9_-]{1,64}$'),
  canonical_request jsonb NOT NULL,
  canonical_basket jsonb NOT NULL,
  expected_product_sum numeric(20,6) NOT NULL,
  expected_shipping_fee numeric(20,6) NOT NULL,
  expected_total_sum numeric(20,6) NOT NULL,
  request_hash varchar(64) NOT NULL,
  basket_fingerprint varchar(64) NOT NULL,
  destination_fingerprint varchar(64) NOT NULL,
  order_total_fingerprint varchar(64) NOT NULL,
  supplier_snapshot_fingerprint varchar(64) NOT NULL,
  state toonies_settlement_state NOT NULL DEFAULT 'not_submitted',
  confirmation_kind toonies_settlement_confirmation_kind,
  lease_token varchar(64), lease_until timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  first_submission_at timestamptz, last_transmission_at timestamptz, confirmed_at timestamptz,
  transmission_count integer NOT NULL DEFAULT 0 CHECK (transmission_count >= 0),
  reconciliation_count integer NOT NULL DEFAULT 0 CHECK (reconciliation_count >= 0),
  next_reconciliation_at timestamptz,
  reconciliation_source varchar(32), reconciliation_page integer,
  reconciliation_date_start timestamptz, reconciliation_date_end timestamptz,
  reconciliation_exhausted boolean NOT NULL DEFAULT false,
  order_sn varchar(128), trade_order_sn varchar(128),
  supplier_status varchar(64), pay_status varchar(64), currency varchar(3),
  product_sum numeric(20,6), shipping_fee numeric(20,6), total_sum numeric(20,6),
  total_weight numeric(20,6), response_evidence jsonb,
  failure_code integer, failure_message varchar(2000),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT toonies_settlements_confirmed_facts CHECK (
    state <> 'confirmed' OR (order_sn IS NOT NULL AND currency = 'CNY' AND confirmation_kind IS NOT NULL)
  ),
  CONSTRAINT toonies_settlements_expected_amounts_nonnegative CHECK (
    expected_product_sum >= 0 AND expected_shipping_fee >= 0 AND expected_total_sum >= 0
  )
);
CREATE UNIQUE INDEX toonies_settlements_attempt_generation_unique ON toonies_settlements(attempt_id,generation);
CREATE UNIQUE INDEX toonies_settlements_supplier_api_order_unique ON toonies_settlements(supplier_id,api_order_sn);
CREATE UNIQUE INDEX toonies_settlements_order_unresolved_unique ON toonies_settlements(order_id)
  WHERE state IN ('not_submitted','submitting','transmitted_unknown','reconciling','replay_pending','confirmed','manual_review');
CREATE INDEX toonies_settlements_order_state_idx ON toonies_settlements(order_id,state);
CREATE INDEX toonies_settlements_recovery_idx ON toonies_settlements(state,next_reconciliation_at);

CREATE TABLE toonies_settlement_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES toonies_settlements(id) ON DELETE RESTRICT,
  event_type varchar(64) NOT NULL,
  from_state toonies_settlement_state,
  to_state toonies_settlement_state,
  request_hash varchar(64), response_hash varchar(64), error_code integer,
  details jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX toonies_settlement_evidence_settlement_idx ON toonies_settlement_evidence(settlement_id,created_at);

CREATE OR REPLACE FUNCTION prevent_toonies_settlement_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Toonies settlement evidence is append-only';
END;
$$;
CREATE TRIGGER toonies_settlement_evidence_append_only
  BEFORE UPDATE OR DELETE ON toonies_settlement_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_toonies_settlement_evidence_mutation();

CREATE OR REPLACE FUNCTION prevent_toonies_settlement_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.api_order_sn IS DISTINCT FROM OLD.api_order_sn
     OR NEW.canonical_request IS DISTINCT FROM OLD.canonical_request
     OR NEW.canonical_basket IS DISTINCT FROM OLD.canonical_basket
     OR NEW.expected_product_sum IS DISTINCT FROM OLD.expected_product_sum
     OR NEW.expected_shipping_fee IS DISTINCT FROM OLD.expected_shipping_fee
     OR NEW.expected_total_sum IS DISTINCT FROM OLD.expected_total_sum
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.basket_fingerprint IS DISTINCT FROM OLD.basket_fingerprint
     OR NEW.destination_fingerprint IS DISTINCT FROM OLD.destination_fingerprint
     OR NEW.order_total_fingerprint IS DISTINCT FROM OLD.order_total_fingerprint
     OR NEW.supplier_snapshot_fingerprint IS DISTINCT FROM OLD.supplier_snapshot_fingerprint
     OR NEW.generation IS DISTINCT FROM OLD.generation
  THEN RAISE EXCEPTION 'Toonies settlement authority is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER toonies_settlement_identity_immutable
  BEFORE UPDATE ON toonies_settlements
  FOR EACH ROW EXECUTE FUNCTION prevent_toonies_settlement_identity_mutation();

CREATE OR REPLACE FUNCTION prevent_toonies_settlement_terminal_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'confirmed' AND NEW.state <> 'confirmed' THEN
    RAISE EXCEPTION 'A confirmed Toonies settlement is terminal';
  END IF;
  IF OLD.state IN ('transmitted_unknown','reconciling','replay_pending','manual_review')
     AND NEW.state = 'not_submitted' THEN
    RAISE EXCEPTION 'An unresolved Toonies settlement cannot return to not_submitted';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER toonies_settlement_terminal_transition
  BEFORE UPDATE ON toonies_settlements
  FOR EACH ROW EXECUTE FUNCTION prevent_toonies_settlement_terminal_transition();