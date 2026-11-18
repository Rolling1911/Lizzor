ALTER TABLE order_items ALTER COLUMN supplier_cost_cny TYPE numeric(30,12) USING supplier_cost_cny::numeric(30,12);
ALTER TABLE toonies_procurement_commands ADD COLUMN IF NOT EXISTS supplier_snapshot_fingerprint varchar(64);
UPDATE toonies_procurement_commands c SET supplier_snapshot_fingerprint=s.fingerprint
FROM (SELECT o.id, ''::varchar AS fingerprint FROM orders o) s WHERE c.order_id=s.id AND c.supplier_snapshot_fingerprint IS NULL;
ALTER TABLE toonies_procurement_commands ALTER COLUMN supplier_snapshot_fingerprint SET NOT NULL;
ALTER TABLE toonies_procurement_lines ALTER COLUMN expected_unit_cost_cny TYPE numeric(30,12) USING expected_unit_cost_cny::numeric(30,12);
ALTER TABLE toonies_procurement_lines ALTER COLUMN expected_subtotal_cny TYPE numeric(30,12) USING expected_subtotal_cny::numeric(30,12);
ALTER TABLE toonies_procurement_lines ALTER COLUMN returned_cost_variance_cny TYPE numeric(30,12) USING returned_cost_variance_cny::numeric(30,12);

CREATE OR REPLACE FUNCTION prevent_toonies_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.supplier_product_link_id,OLD.supplier_id,OLD.supplier_catalogue_item_id,OLD.supplier_catalogue_variant_id,
      OLD.supplier_product_code,OLD.supplier_sku_code,OLD.supplier_cost_eur,OLD.supplier_cost_cny,
      OLD.supplier_cost_provenance,OLD.supplier_cost_threshold_percent)
     IS DISTINCT FROM
     (NEW.supplier_product_link_id,NEW.supplier_id,NEW.supplier_catalogue_item_id,NEW.supplier_catalogue_variant_id,
      NEW.supplier_product_code,NEW.supplier_sku_code,NEW.supplier_cost_eur,NEW.supplier_cost_cny,
      NEW.supplier_cost_provenance,NEW.supplier_cost_threshold_percent)
     THEN
    RAISE EXCEPTION 'immutable Toonies supplier snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_items_toonies_snapshot_immutable ON order_items;
CREATE TRIGGER order_items_toonies_snapshot_immutable BEFORE UPDATE ON order_items
FOR EACH ROW EXECUTE FUNCTION prevent_toonies_snapshot_mutation();