ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS supplier_product_link_id uuid,
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS supplier_catalogue_item_id uuid REFERENCES supplier_catalogue_items(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS supplier_catalogue_variant_id uuid REFERENCES supplier_catalogue_variants(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS supplier_product_code varchar(255),
  ADD COLUMN IF NOT EXISTS supplier_sku_code varchar(255),
  ADD COLUMN IF NOT EXISTS supplier_cost_eur numeric(20,6),
  ADD COLUMN IF NOT EXISTS supplier_cost_cny numeric(20,6),
  ADD COLUMN IF NOT EXISTS supplier_cost_provenance jsonb,
  ADD COLUMN IF NOT EXISTS supplier_cost_threshold_percent numeric(12,6);
DO $$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT order_items_supplier_product_link_fk FOREIGN KEY (supplier_product_link_id) REFERENCES supplier_product_links(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_supplier_snapshot_all_or_none;
ALTER TABLE order_items ADD CONSTRAINT order_items_supplier_snapshot_all_or_none CHECK (
  (supplier_product_link_id IS NULL AND supplier_id IS NULL AND supplier_catalogue_item_id IS NULL AND supplier_catalogue_variant_id IS NULL
   AND supplier_product_code IS NULL AND supplier_sku_code IS NULL AND supplier_cost_eur IS NULL
   AND supplier_cost_cny IS NULL AND supplier_cost_provenance IS NULL AND supplier_cost_threshold_percent IS NULL)
  OR
  (supplier_product_link_id IS NOT NULL AND supplier_id IS NOT NULL AND supplier_catalogue_item_id IS NOT NULL AND supplier_catalogue_variant_id IS NOT NULL
   AND supplier_product_code IS NOT NULL AND supplier_sku_code IS NOT NULL AND supplier_cost_eur IS NOT NULL
   AND supplier_cost_cny IS NOT NULL AND supplier_cost_provenance IS NOT NULL AND supplier_cost_threshold_percent IS NOT NULL)
);
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_supplier_snapshot_values_valid;
ALTER TABLE order_items ADD CONSTRAINT order_items_supplier_snapshot_values_valid CHECK (
  (supplier_cost_eur IS NULL OR supplier_cost_eur > 0)
  AND (supplier_cost_cny IS NULL OR supplier_cost_cny > 0)
  AND (supplier_cost_threshold_percent IS NULL OR supplier_cost_threshold_percent >= 0)
);
ALTER TABLE toonies_procurement_lines
  ADD COLUMN IF NOT EXISTS expected_unit_cost_cny numeric(30,12),
  ADD COLUMN IF NOT EXISTS expected_subtotal_cny numeric(30,12),
  ADD COLUMN IF NOT EXISTS cost_threshold_percent numeric(12,6),
  ADD COLUMN IF NOT EXISTS returned_cost_variance_cny numeric(30,12);
ALTER TABLE toonies_procurement_attempts DROP CONSTRAINT IF EXISTS toonies_procurement_attempts_state_valid;
ALTER TABLE toonies_procurement_attempts ADD CONSTRAINT toonies_procurement_attempts_state_valid
  CHECK (state IN ('created','validating','precheck_pending','task_pending','ready','cost_hold','failed','expired','retry_wait'));

CREATE TABLE IF NOT EXISTS toonies_procurement_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  order_total_fingerprint varchar(64) NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token varchar(64),
  last_error varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT toonies_procurement_commands_state_valid CHECK (state IN ('pending','processing','completed','failed')),
  CONSTRAINT toonies_procurement_commands_attempts_valid CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts)
);
ALTER TABLE toonies_procurement_commands ADD COLUMN IF NOT EXISTS order_total_fingerprint varchar(64);
UPDATE toonies_procurement_commands c SET order_total_fingerprint=o.total_fingerprint FROM orders o WHERE o.id=c.order_id AND c.order_total_fingerprint IS NULL;
ALTER TABLE toonies_procurement_commands ALTER COLUMN order_total_fingerprint SET NOT NULL;
UPDATE toonies_procurement_commands SET state='completed' WHERE state='queued';
CREATE INDEX IF NOT EXISTS toonies_procurement_commands_due_idx
  ON toonies_procurement_commands(state, next_attempt_at);