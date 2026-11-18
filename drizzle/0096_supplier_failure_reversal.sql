DO $$ BEGIN
  CREATE TYPE supplier_failure_reversal_state AS ENUM
    ('eligible','reserved','transmitting','ambiguous','manual_review','completed','failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE supplier_failure_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES toonies_procurement_attempts(id) ON DELETE RESTRICT,
  operation_reservation_id uuid REFERENCES financial_operation_reservations(id) ON DELETE RESTRICT,
  refund_id uuid REFERENCES refunds(id) ON DELETE RESTRICT,
  state supplier_failure_reversal_state NOT NULL DEFAULT 'eligible',
  reason_code varchar(64) NOT NULL,
  evidence_snapshot jsonb NOT NULL,
  evidence_hash varchar(64) NOT NULL,
  payment_amount numeric(12,2) NOT NULL,
  payment_currency varchar(3) NOT NULL,
  provider_refund_identity varchar(200) NOT NULL,
  provider_refund_reference varchar(200),
  lease_token varchar(64),
  lease_until timestamptz,
  version integer NOT NULL DEFAULT 0,
  transmission_started_at timestamptz,
  completed_at timestamptz,
  last_error varchar(2000),
  recovery_evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_failure_reversals_amount_nonnegative CHECK (payment_amount >= 0),
  CONSTRAINT supplier_failure_reversals_version_nonnegative CHECK (version >= 0),
  CONSTRAINT supplier_failure_reversals_currency_valid CHECK (length(payment_currency) = 3)
);
CREATE UNIQUE INDEX supplier_failure_reversals_refund_identity_unique
  ON supplier_failure_reversals(provider_refund_identity);
CREATE INDEX supplier_failure_reversals_due_idx
  ON supplier_failure_reversals(state, lease_until);

CREATE OR REPLACE FUNCTION supplier_failure_reversal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.order_id::text,0));
  IF TG_TABLE_NAME = 'supplier_failure_reversals' THEN
    IF TG_OP = 'UPDATE' AND (
      NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.payment_id IS DISTINCT FROM OLD.payment_id OR
      NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR
      NEW.evidence_snapshot IS DISTINCT FROM OLD.evidence_snapshot OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash OR
      NEW.payment_amount IS DISTINCT FROM OLD.payment_amount OR NEW.payment_currency IS DISTINCT FROM OLD.payment_currency OR
      NEW.provider_refund_identity IS DISTINCT FROM OLD.provider_refund_identity
    ) THEN RAISE EXCEPTION 'supplier failure reversal authority is immutable'; END IF;
    IF NOT (
      (OLD.state='eligible' AND NEW.state IN ('eligible','reserved','manual_review','failed')) OR
      (OLD.state='reserved' AND NEW.state IN ('reserved','transmitting','manual_review','failed')) OR
      (OLD.state='transmitting' AND NEW.state IN ('transmitting','ambiguous','completed','manual_review')) OR
      (OLD.state='ambiguous' AND NEW.state IN ('ambiguous','transmitting','completed','manual_review')) OR
      (OLD.state IN ('manual_review','failed') AND NEW.state IN ('manual_review','failed','reserved')) OR
      (OLD.state='completed' AND NEW.state='completed')
    ) THEN RAISE EXCEPTION 'illegal supplier failure reversal transition'; END IF;
  ELSE
    IF NEW.operation_type='supplier_settlement' AND EXISTS (
      SELECT 1 FROM supplier_failure_reversals r
       WHERE r.order_id=NEW.order_id AND r.state IN ('reserved','transmitting','ambiguous','completed')
    ) THEN RAISE EXCEPTION 'supplier settlement blocked by reversal authority'; END IF;
    IF NEW.operation_type='payment_refund' AND EXISTS (
      SELECT 1 FROM toonies_settlements s
       WHERE s.order_id=NEW.order_id AND s.state IN ('submitting','transmitted_unknown','reconciling','replay_pending','confirmed','manual_review')
    ) THEN RAISE EXCEPTION 'payment refund blocked by supplier settlement authority'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_failure_reversal_guard
  BEFORE INSERT OR UPDATE ON supplier_failure_reversals
  FOR EACH ROW EXECUTE FUNCTION supplier_failure_reversal_guard();
CREATE TRIGGER financial_reservation_supplier_failure_interlock
  BEFORE INSERT OR UPDATE ON financial_operation_reservations
  FOR EACH ROW EXECUTE FUNCTION supplier_failure_reversal_guard();

CREATE OR REPLACE FUNCTION toonies_settlement_supplier_failure_interlock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.order_id::text,0));
  IF NEW.state IN ('submitting','transmitted_unknown','reconciling','replay_pending','confirmed','manual_review')
     AND EXISTS (
       SELECT 1 FROM financial_operation_reservations f
        WHERE f.order_id=NEW.order_id
          AND f.operation_type='payment_refund'
          AND f.state IN ('active','ambiguous','completed')
     ) THEN
    RAISE EXCEPTION 'supplier settlement blocked by payment refund authority';
  END IF;
  IF NEW.state IN ('submitting','transmitted_unknown','reconciling','replay_pending','confirmed','manual_review')
     AND EXISTS (
       SELECT 1 FROM supplier_failure_reversals r
        WHERE r.order_id=NEW.order_id AND r.state IN ('reserved','transmitting','ambiguous','completed')
     ) THEN
    RAISE EXCEPTION 'supplier settlement blocked by supplier failure reversal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER toonies_settlement_supplier_failure_interlock
  BEFORE INSERT OR UPDATE ON toonies_settlements
  FOR EACH ROW EXECUTE FUNCTION toonies_settlement_supplier_failure_interlock();

CREATE OR REPLACE FUNCTION order_supplier_failure_reversal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status IN ('processing','completed') OR NEW.fulfillment_status IS DISTINCT FROM OLD.fulfillment_status
      OR NEW.fulfillment_stage IS DISTINCT FROM OLD.fulfillment_stage)
     AND NOT (NEW.status='cancelled' AND NEW.payment_status='refunded' AND NEW.fulfillment_status='cancelled') 
     AND (
       EXISTS (SELECT 1 FROM financial_operation_reservations f WHERE f.order_id=NEW.id AND f.operation_type='payment_refund' AND f.state IN ('active','ambiguous','completed'))
       OR EXISTS (SELECT 1 FROM supplier_failure_reversals r JOIN financial_operation_reservations f ON f.operation_reference_id=r.id
                   WHERE r.order_id=NEW.id AND r.state IN ('reserved','transmitting','ambiguous','completed')
                     AND f.operation_type='payment_refund' AND f.state IN ('active','ambiguous','completed'))
     ) THEN
    RAISE EXCEPTION 'order fulfillment transition blocked by financial reversal authority';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_supplier_failure_reversal_guard
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION order_supplier_failure_reversal_guard();