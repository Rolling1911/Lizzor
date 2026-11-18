ALTER TABLE financial_operation_reservations
  ADD COLUMN phase varchar(24) NOT NULL DEFAULT 'reserved',
  ADD COLUMN transmission_started_at timestamptz;
ALTER TABLE financial_operation_reservations
  ADD CONSTRAINT financial_operation_reservations_phase_check
  CHECK (phase IN ('reserved','transmitting','ambiguous','terminal'));