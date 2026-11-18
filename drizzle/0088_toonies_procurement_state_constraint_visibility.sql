ALTER TABLE toonies_procurement_attempts
  DROP CONSTRAINT IF EXISTS toonies_procurement_attempts_state_valid;

ALTER TABLE toonies_procurement_attempts
  ADD CONSTRAINT toonies_procurement_attempts_state_valid_v2
  CHECK (state IN ('created','validating','precheck_pending','task_pending','ready','cost_hold','failed','expired','retry_wait'));