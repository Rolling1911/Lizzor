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
     OR (OLD.reconciliation_source IS NOT NULL AND NEW.reconciliation_source IS DISTINCT FROM OLD.reconciliation_source)
     OR (OLD.reconciliation_date_start IS NOT NULL AND NEW.reconciliation_date_start IS DISTINCT FROM OLD.reconciliation_date_start)
     OR (OLD.reconciliation_date_end IS NOT NULL AND NEW.reconciliation_date_end IS DISTINCT FROM OLD.reconciliation_date_end)
  THEN
    RAISE EXCEPTION 'Toonies settlement authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;