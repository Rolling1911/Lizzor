CREATE OR REPLACE FUNCTION prevent_toonies_settlement_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.api_order_sn IS DISTINCT FROM OLD.api_order_sn
     OR NEW.canonical_request IS DISTINCT FROM OLD.canonical_request OR NEW.canonical_basket IS DISTINCT FROM OLD.canonical_basket
     OR NEW.expected_product_sum IS DISTINCT FROM OLD.expected_product_sum OR NEW.expected_shipping_fee IS DISTINCT FROM OLD.expected_shipping_fee
     OR NEW.expected_total_sum IS DISTINCT FROM OLD.expected_total_sum OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.basket_fingerprint IS DISTINCT FROM OLD.basket_fingerprint OR NEW.destination_fingerprint IS DISTINCT FROM OLD.destination_fingerprint
     OR NEW.order_total_fingerprint IS DISTINCT FROM OLD.order_total_fingerprint OR NEW.supplier_snapshot_fingerprint IS DISTINCT FROM OLD.supplier_snapshot_fingerprint
     OR NEW.generation IS DISTINCT FROM OLD.generation
  THEN RAISE EXCEPTION 'Toonies settlement authority is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION prevent_toonies_settlement_terminal_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'confirmed' AND NEW.state <> 'confirmed' THEN RAISE EXCEPTION 'A confirmed Toonies settlement is terminal'; END IF;
  IF OLD.state IN ('transmitted_unknown','reconciling','replay_pending','manual_review') AND NEW.state='not_submitted' THEN RAISE EXCEPTION 'An unresolved Toonies settlement cannot return to not_submitted'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS toonies_settlement_terminal_transition ON toonies_settlements;
CREATE TRIGGER toonies_settlement_terminal_transition
  BEFORE UPDATE ON toonies_settlements
  FOR EACH ROW EXECUTE FUNCTION prevent_toonies_settlement_terminal_transition();