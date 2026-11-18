-- Additive Phase 2 supplier boundary. No credentials are stored in this schema.
DO $enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='supplier_sync_state') THEN
    CREATE TYPE "supplier_sync_state" AS ENUM ('Synced','Changed','Out of stock','Supplier unavailable','Error','Needs review');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='supplier_sync_run_status') THEN
    CREATE TYPE "supplier_sync_run_status" AS ENUM ('running','completed','failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='supplier_pricing_rule_type') THEN
    CREATE TYPE "supplier_pricing_rule_type" AS ENUM ('markup_percent','markup_fixed','margin_percent');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='supplier_rounding_mode') THEN
    CREATE TYPE "supplier_rounding_mode" AS ENUM ('none','whole','99');
  END IF;
END;
$enum$;
--> statement-breakpoint
DO $supplier$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('supplier:toonies'));
  INSERT INTO suppliers(name, slug, active, publication_enabled, compliance_excluded)
  VALUES ('Toonies', 'toonies', true, false, true)
  ON CONFLICT (slug) DO NOTHING;
  IF EXISTS (SELECT 1 FROM suppliers WHERE slug='toonies' AND name <> 'Toonies') THEN
    RAISE EXCEPTION 'supplier slug toonies is owned by another supplier' USING ERRCODE='23505';
  END IF;
END;
$supplier$;
--> statement-breakpoint
DO $warehouse$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('warehouse:toonies'));
  IF EXISTS (SELECT 1 FROM warehouses WHERE code='TOONIES' AND name <> 'Toonies Supplier') THEN
    RAISE EXCEPTION 'warehouse code TOONIES is owned by another warehouse' USING ERRCODE='23505';
  END IF;
  INSERT INTO warehouses(name,code,country_code,active)
  VALUES ('Toonies Supplier','TOONIES','CN',true)
  ON CONFLICT(code) DO UPDATE SET active=true;
END;
$warehouse$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_catalogue_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  external_product_id varchar(255) NOT NULL,
  external_category_id varchar(255),
  title varchar(500) NOT NULL,
  description text,
  image_urls jsonb,
  original_amount numeric(14,4) NOT NULL,
  original_currency varchar(3) NOT NULL,
  normalized_eur numeric(14,4),
  manual_selling_price_eur numeric(14,4),
  stock integer DEFAULT 0 NOT NULL,
  state supplier_sync_state DEFAULT 'Needs review' NOT NULL,
  needs_review boolean DEFAULT true NOT NULL,
  manual_cost_override_eur numeric(14,4),
  raw_payload jsonb,
  last_seen_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_catalogue_items_supplier_external_unique UNIQUE(supplier_id, external_product_id),
  CONSTRAINT supplier_catalogue_items_supplier_id_unique UNIQUE(supplier_id,id),
  CONSTRAINT supplier_catalogue_items_amount_nonnegative CHECK(original_amount >= 0),
  CONSTRAINT supplier_catalogue_items_stock_nonnegative CHECK(stock >= 0),
  CONSTRAINT supplier_catalogue_items_manual_price_nonnegative CHECK(manual_selling_price_eur IS NULL OR manual_selling_price_eur >= 0),
  CONSTRAINT supplier_catalogue_items_currency_valid CHECK(length(original_currency)=3)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_catalogue_items_supplier_state_idx ON supplier_catalogue_items(supplier_id,state);
CREATE INDEX IF NOT EXISTS supplier_catalogue_items_category_idx ON supplier_catalogue_items(supplier_id,external_category_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_catalogue_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  catalogue_item_id uuid NOT NULL REFERENCES supplier_catalogue_items(id) ON DELETE CASCADE,
  external_variant_id varchar(255) NOT NULL,
  sku_code varchar(255) NOT NULL,
  title varchar(500),
  attributes jsonb,
  original_amount numeric(14,4) NOT NULL,
  original_currency varchar(3) NOT NULL,
  normalized_eur numeric(14,4),
  manual_selling_price_eur numeric(14,4),
  stock integer DEFAULT 0 NOT NULL,
  weight_kg numeric(10,3),
  image_url text,
  state supplier_sync_state DEFAULT 'Needs review' NOT NULL,
  needs_review boolean DEFAULT true NOT NULL,
  manual_cost_override_eur numeric(14,4),
  raw_payload jsonb,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_catalogue_variants_item_external_unique UNIQUE(catalogue_item_id,external_variant_id),
  CONSTRAINT supplier_catalogue_variants_supplier_item_unique UNIQUE(supplier_id,catalogue_item_id,id),
  CONSTRAINT supplier_catalogue_variants_item_sku_unique UNIQUE(catalogue_item_id,sku_code),
  CONSTRAINT supplier_catalogue_variants_amount_nonnegative CHECK(original_amount >= 0),
  CONSTRAINT supplier_catalogue_variants_stock_nonnegative CHECK(stock >= 0),
  CONSTRAINT supplier_catalogue_variants_weight_nonnegative CHECK(weight_kg IS NULL OR weight_kg >= 0),
  CONSTRAINT supplier_catalogue_variants_manual_price_nonnegative CHECK(manual_selling_price_eur IS NULL OR manual_selling_price_eur >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_catalogue_variants_state_idx ON supplier_catalogue_variants(state);
ALTER TABLE supplier_catalogue_variants
  ADD CONSTRAINT supplier_catalogue_variants_supplier_item_fk
  FOREIGN KEY(supplier_id,catalogue_item_id) REFERENCES supplier_catalogue_items(supplier_id,id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_id_product_unique ON product_variants(id,product_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_product_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  catalogue_item_id uuid NOT NULL REFERENCES supplier_catalogue_items(id) ON DELETE CASCADE,
  catalogue_variant_id uuid REFERENCES supplier_catalogue_variants(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  manual_selling_price_eur numeric(14,4),
  manual_override boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_product_links_catalogue_variant_unique UNIQUE(catalogue_variant_id),
  CONSTRAINT supplier_product_links_target_check CHECK(product_id IS NOT NULL),
  CONSTRAINT supplier_product_links_manual_price_nonnegative CHECK(manual_selling_price_eur IS NULL OR manual_selling_price_eur >= 0),
  CONSTRAINT supplier_product_links_scope_check CHECK((catalogue_variant_id IS NULL AND variant_id IS NULL AND product_id IS NOT NULL) OR (catalogue_variant_id IS NOT NULL AND variant_id IS NOT NULL AND product_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_product_links_catalogue_item_product_unique ON supplier_product_links(catalogue_item_id,product_id) WHERE catalogue_variant_id IS NULL;
ALTER TABLE supplier_product_links
  ADD CONSTRAINT supplier_product_links_supplier_item_fk
  FOREIGN KEY(supplier_id,catalogue_item_id) REFERENCES supplier_catalogue_items(supplier_id,id) ON DELETE CASCADE;
ALTER TABLE supplier_product_links
  ADD CONSTRAINT supplier_product_links_supplier_variant_fk
  FOREIGN KEY(supplier_id,catalogue_item_id,catalogue_variant_id) REFERENCES supplier_catalogue_variants(supplier_id,catalogue_item_id,id) ON DELETE CASCADE;
ALTER TABLE supplier_product_links
  ADD CONSTRAINT supplier_product_links_variant_product_fk
  FOREIGN KEY(variant_id,product_id) REFERENCES product_variants(id,product_id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_product_links_product_idx ON supplier_product_links(product_id,variant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_import_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  catalogue_item_id uuid REFERENCES supplier_catalogue_items(id) ON DELETE SET NULL,
  catalogue_variant_id uuid,
  external_product_id varchar(255) NOT NULL,
  external_variant_id varchar(255),
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  status varchar(30) DEFAULT 'draft' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_import_records_scope_check CHECK((external_variant_id IS NULL AND catalogue_variant_id IS NULL AND product_id IS NOT NULL AND variant_id IS NULL) OR (external_variant_id IS NOT NULL AND catalogue_variant_id IS NOT NULL AND product_id IS NOT NULL AND variant_id IS NOT NULL))
);
ALTER TABLE supplier_import_records
  ADD CONSTRAINT supplier_import_records_supplier_item_fk
  FOREIGN KEY(supplier_id,catalogue_item_id) REFERENCES supplier_catalogue_items(supplier_id,id) ON DELETE CASCADE;
ALTER TABLE supplier_import_records
  ADD CONSTRAINT supplier_import_records_catalogue_variant_fk
  FOREIGN KEY(supplier_id,catalogue_item_id,catalogue_variant_id) REFERENCES supplier_catalogue_variants(supplier_id,catalogue_item_id,id) ON DELETE CASCADE;
ALTER TABLE supplier_import_records
  ADD CONSTRAINT supplier_import_records_variant_product_fk
  FOREIGN KEY(variant_id,product_id) REFERENCES product_variants(id,product_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_import_records_supplier_external_parent_unique ON supplier_import_records(supplier_id,external_product_id) WHERE external_variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_import_records_supplier_external_variant_unique ON supplier_import_records(supplier_id,external_product_id,external_variant_id) WHERE external_variant_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_import_records_product_idx ON supplier_import_records(product_id,variant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  operation varchar(40) NOT NULL,
  status supplier_sync_run_status DEFAULT 'running' NOT NULL,
  page_count integer DEFAULT 0 NOT NULL,
  item_count integer DEFAULT 0 NOT NULL,
  error_count integer DEFAULT 0 NOT NULL,
  error_message text,
  started_at timestamptz DEFAULT now() NOT NULL,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_sync_runs_counts_nonnegative CHECK(page_count >= 0 AND item_count >= 0 AND error_count >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_sync_runs_supplier_started_idx ON supplier_sync_runs(supplier_id,started_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_sync_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  run_id uuid REFERENCES supplier_sync_runs(id) ON DELETE SET NULL,
  catalogue_item_id uuid NOT NULL REFERENCES supplier_catalogue_items(id) ON DELETE CASCADE,
  catalogue_variant_id uuid REFERENCES supplier_catalogue_variants(id) ON DELETE CASCADE,
  previous_state supplier_sync_state,
  next_state supplier_sync_state NOT NULL,
  previous_payload jsonb,
  next_payload jsonb,
  change_reason varchar(100),
  created_at timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_sync_history_supplier_created_idx ON supplier_sync_history(supplier_id,created_at);
CREATE INDEX IF NOT EXISTS supplier_sync_history_item_idx ON supplier_sync_history(catalogue_item_id,catalogue_variant_id,created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_cost_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  catalogue_item_id uuid NOT NULL REFERENCES supplier_catalogue_items(id) ON DELETE CASCADE,
  catalogue_variant_id uuid REFERENCES supplier_catalogue_variants(id) ON DELETE CASCADE,
  previous_cost_eur numeric(14,4),
  next_cost_eur numeric(14,4),
  previous_price_eur numeric(14,4),
  next_price_eur numeric(14,4),
  reason varchar(80) NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS supplier_cost_price_history_item_idx ON supplier_cost_price_history(catalogue_item_id,catalogue_variant_id,created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_precheck_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  task_id varchar(32) NOT NULL,
  client_task_no varchar(64) NOT NULL,
  status varchar(20) NOT NULL,
  expires_at timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_precheck_snapshots_supplier_task_unique UNIQUE(supplier_id,task_id),
  CONSTRAINT supplier_precheck_snapshots_supplier_client_unique UNIQUE(supplier_id,client_task_no)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_precheck_snapshots_expiry_idx ON supplier_precheck_snapshots(expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name varchar(150) NOT NULL,
  rule_type supplier_pricing_rule_type NOT NULL,
  min_cost_eur numeric(14,4) DEFAULT 0 NOT NULL,
  max_cost_eur numeric(14,4),
  value numeric(12,4) NOT NULL,
  rounding_mode supplier_rounding_mode DEFAULT 'none' NOT NULL,
  priority integer DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  significant_cost_increase_percent numeric(6,2) DEFAULT 20 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_pricing_rules_value_nonnegative CHECK(value >= 0),
  CONSTRAINT supplier_pricing_rules_cost_band_valid CHECK(min_cost_eur >= 0 AND (max_cost_eur IS NULL OR max_cost_eur > min_cost_eur)),
  CONSTRAINT supplier_pricing_rules_significant_increase_valid CHECK(significant_cost_increase_percent >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_pricing_rules_supplier_active_idx ON supplier_pricing_rules(supplier_id,active,priority);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_shipping_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  country_code varchar(2) NOT NULL,
  zone varchar(80),
  min_weight_kg numeric(10,3) DEFAULT 0 NOT NULL,
  max_weight_kg numeric(10,3),
  amount_eur numeric(12,2) NOT NULL,
  min_delivery_days integer,
  max_delivery_days integer,
  temporary boolean DEFAULT true NOT NULL,
  active boolean DEFAULT true NOT NULL,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_shipping_rules_weight_valid CHECK(min_weight_kg >= 0 AND (max_weight_kg IS NULL OR max_weight_kg >= min_weight_kg)),
  CONSTRAINT supplier_shipping_rules_amount_nonnegative CHECK(amount_eur >= 0),
  CONSTRAINT supplier_shipping_rules_temporary_only CHECK(temporary=true),
  CONSTRAINT supplier_shipping_rules_delivery_valid CHECK(max_delivery_days IS NULL OR min_delivery_days IS NULL OR max_delivery_days >= min_delivery_days)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_shipping_rules_lookup_idx ON supplier_shipping_rules(supplier_id,country_code,active,min_weight_kg);
--> statement-breakpoint
INSERT INTO admin_permissions(permission_key,description) VALUES
 ('supplier_integrations.view','View supplier integrations'),
 ('supplier_integrations.manage','Manage supplier integrations'),
 ('supplier_integrations.import','Import supplier catalogue products'),
 ('supplier_integrations.pricing','Manage supplier pricing rules'),
 ('supplier_integrations.sync','Run supplier synchronizations')
ON CONFLICT(permission_key) DO NOTHING;
--> statement-breakpoint
INSERT INTO admin_role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM admin_roles r CROSS JOIN admin_permissions p
WHERE r.system_key='super_admin'
AND p.permission_key IN ('supplier_integrations.view','supplier_integrations.manage','supplier_integrations.import','supplier_integrations.pricing','supplier_integrations.sync')
ON CONFLICT(role_id,permission_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO supplier_pricing_rules(supplier_id,name,rule_type,min_cost_eur,max_cost_eur,value,rounding_mode,priority,active)
SELECT s.id,b.name,'markup_percent',b.min_cost,b.max_cost,b.markup,'none',b.priority,true
FROM suppliers s
CROSS JOIN (VALUES
  ('Toonies cost 0-5',0::numeric,5::numeric,100::numeric,10),
  ('Toonies cost 5-15',5::numeric,15::numeric,70::numeric,20),
  ('Toonies cost 15-30',15::numeric,30::numeric,50::numeric,30),
  ('Toonies cost 30-75',30::numeric,75::numeric,35::numeric,40),
  ('Toonies cost 75+',75::numeric,NULL::numeric,25::numeric,50)
) AS b(name,min_cost,max_cost,markup,priority)
WHERE s.slug='toonies'
  AND NOT EXISTS (SELECT 1 FROM supplier_pricing_rules existing WHERE existing.supplier_id=s.id);