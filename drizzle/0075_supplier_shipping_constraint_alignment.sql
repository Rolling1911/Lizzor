-- Retire any structurally invalid legacy draft before tightening the database
-- boundary. Values are cleared rather than guessed, and the rule stays inactive
-- until an administrator explicitly supplies a valid replacement.
UPDATE supplier_shipping_rules
   SET active=false,
       max_weight_kg=NULL,
       updated_at=now()
 WHERE max_weight_kg IS NOT NULL
   AND max_weight_kg <= min_weight_kg;
--> statement-breakpoint

UPDATE supplier_shipping_rules
   SET active=false,
       min_delivery_days=CASE WHEN min_delivery_days < 0 THEN NULL ELSE min_delivery_days END,
       max_delivery_days=CASE WHEN max_delivery_days < 0 THEN NULL ELSE max_delivery_days END,
       updated_at=now()
 WHERE min_delivery_days < 0 OR max_delivery_days < 0;
--> statement-breakpoint

ALTER TABLE supplier_shipping_rules
  DROP CONSTRAINT IF EXISTS supplier_shipping_rules_weight_valid,
  DROP CONSTRAINT IF EXISTS supplier_shipping_rules_delivery_valid,
  ADD CONSTRAINT supplier_shipping_rules_weight_valid
    CHECK (min_weight_kg >= 0 AND (max_weight_kg IS NULL OR max_weight_kg > min_weight_kg)),
  ADD CONSTRAINT supplier_shipping_rules_delivery_valid
    CHECK ((min_delivery_days IS NULL OR min_delivery_days >= 0)
       AND (max_delivery_days IS NULL OR max_delivery_days >= 0)
       AND (max_delivery_days IS NULL OR min_delivery_days IS NULL OR max_delivery_days >= min_delivery_days));