-- Temporary supplier shipping destinations are either a concrete country or a
-- managed shipping zone.  The old free-form zone column is retained solely
-- for historical rows and is never read or written by the new API.
ALTER TABLE supplier_shipping_rules
  ALTER COLUMN country_code DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS destination_zone_id uuid;
--> statement-breakpoint

-- Legacy named zones cannot be trusted as a destination set.  Keep their
-- values for audit/debugging, but make those rules harmless until explicitly
-- recreated with a managed zone.
UPDATE supplier_shipping_rules
   SET active=false, updated_at=now()
 WHERE zone IS NOT NULL;
--> statement-breakpoint

ALTER TABLE supplier_shipping_rules
  DROP CONSTRAINT IF EXISTS supplier_shipping_rules_destination_xor,
  ADD CONSTRAINT supplier_shipping_rules_destination_zone_fk
    FOREIGN KEY (destination_zone_id) REFERENCES shipping_zones(id) ON DELETE RESTRICT,
  ADD CONSTRAINT supplier_shipping_rules_destination_xor
    CHECK ((country_code IS NOT NULL AND destination_zone_id IS NULL)
        OR (country_code IS NULL AND destination_zone_id IS NOT NULL));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS supplier_shipping_rules_country_active_idx
  ON supplier_shipping_rules(supplier_id,country_code,active,min_weight_kg);
CREATE INDEX IF NOT EXISTS supplier_shipping_rules_zone_active_idx
  ON supplier_shipping_rules(supplier_id,destination_zone_id,active,min_weight_kg);
--> statement-breakpoint

-- shipping_rule_id is deliberately a scalar historical value.  It is not a
-- live relationship and must remain readable after a supplier rule changes or
-- is removed.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_shipping_rule_id_fkey;