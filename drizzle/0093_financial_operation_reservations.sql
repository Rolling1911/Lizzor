CREATE TYPE financial_operation_type AS ENUM (
  'supplier_settlement','payment_refund','payment_invalidation','payment_cancellation'
);
CREATE TYPE financial_operation_state AS ENUM (
  'active','ambiguous','completed','failed','released'
);
CREATE TABLE financial_operation_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  operation_type financial_operation_type NOT NULL,
  operation_reference_id varchar(128) NOT NULL,
  state financial_operation_state NOT NULL DEFAULT 'active',
  lease_token varchar(64),
  lease_until timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  failure_code varchar(80),
  failure_message varchar(2000),
  recovery_evidence jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX financial_operation_reservations_reference_unique
  ON financial_operation_reservations(operation_type, operation_reference_id);
CREATE UNIQUE INDEX financial_operation_reservations_order_active_unique
  ON financial_operation_reservations(order_id)
  WHERE state IN ('active','ambiguous','completed');
CREATE INDEX financial_operation_reservations_order_idx
  ON financial_operation_reservations(order_id, created_at);