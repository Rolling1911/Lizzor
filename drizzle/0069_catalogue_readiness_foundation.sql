-- Catalogue-readiness foundation: authoritative MOQ, nullable display weight,
-- and auditable Toonies media rehosting. Existing supplier payloads remain
-- untouched so raw supplier values are preserved independently.
ALTER TABLE supplier_catalogue_items
  ADD COLUMN IF NOT EXISTS minimum_order_quantity integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS supplier_raw_moq jsonb;
ALTER TABLE supplier_catalogue_variants
  ADD COLUMN IF NOT EXISTS minimum_order_quantity integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS supplier_raw_moq jsonb;
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS minimum_order_quantity integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS display_weight_kg numeric(10,3);
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS minimum_order_quantity integer DEFAULT 1 NOT NULL;
ALTER TABLE product_media
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_sha256 varchar(64),
  ADD COLUMN IF NOT EXISTS source_workflow varchar(80),
  ADD COLUMN IF NOT EXISTS source_supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_catalogue_item_id uuid REFERENCES supplier_catalogue_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_catalogue_variant_id uuid REFERENCES supplier_catalogue_variants(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE supplier_catalogue_items
  DROP CONSTRAINT IF EXISTS supplier_catalogue_items_moq_positive;
ALTER TABLE supplier_catalogue_items
  ADD CONSTRAINT supplier_catalogue_items_moq_positive CHECK (minimum_order_quantity > 0);
ALTER TABLE supplier_catalogue_variants
  DROP CONSTRAINT IF EXISTS supplier_catalogue_variants_moq_positive;
ALTER TABLE supplier_catalogue_variants
  ADD CONSTRAINT supplier_catalogue_variants_moq_positive CHECK (minimum_order_quantity > 0);
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_moq_positive,
  DROP CONSTRAINT IF EXISTS products_display_weight_nonnegative,
  DROP CONSTRAINT IF EXISTS products_display_weight_positive;
ALTER TABLE products
  ADD CONSTRAINT products_moq_positive CHECK (minimum_order_quantity > 0),
  ADD CONSTRAINT products_display_weight_positive CHECK (display_weight_kg IS NULL OR display_weight_kg > 0);
ALTER TABLE product_variants
  DROP CONSTRAINT IF EXISTS product_variants_moq_positive;
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_moq_positive CHECK (minimum_order_quantity > 0);
--> statement-breakpoint
-- Safe backfill: imported rows are authoritative only when they contain a
-- valid positive integer; all other legacy rows retain the default of one.
WITH toonies_products AS (
  SELECT DISTINCT ON (r.product_id) r.product_id, c.minimum_order_quantity
    FROM supplier_import_records r
    JOIN suppliers s ON s.id=r.supplier_id AND s.slug='toonies'
    JOIN supplier_catalogue_items c ON c.id=r.catalogue_item_id
   WHERE r.external_variant_id IS NULL AND c.minimum_order_quantity > 0
   ORDER BY r.product_id, r.created_at DESC, r.id DESC
)
UPDATE products p
   SET minimum_order_quantity = toonies_products.minimum_order_quantity
  FROM toonies_products
 WHERE toonies_products.product_id = p.id;
WITH toonies_variants AS (
  SELECT DISTINCT ON (r.variant_id) r.variant_id, c.minimum_order_quantity
    FROM supplier_import_records r
    JOIN suppliers s ON s.id=r.supplier_id AND s.slug='toonies'
    JOIN supplier_catalogue_variants c ON c.id=r.catalogue_variant_id
   WHERE r.external_variant_id IS NOT NULL AND c.minimum_order_quantity > 0
   ORDER BY r.variant_id, r.created_at DESC, r.id DESC
)
UPDATE product_variants pv
   SET minimum_order_quantity = toonies_variants.minimum_order_quantity
  FROM toonies_variants
 WHERE toonies_variants.variant_id = pv.id;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_media_rehosting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  catalogue_item_id uuid REFERENCES supplier_catalogue_items(id) ON DELETE CASCADE,
  catalogue_variant_id uuid REFERENCES supplier_catalogue_variants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  status varchar(20) NOT NULL,
  failure_reason varchar(120),
  managed_url text,
  content_type varchar(80),
  source_sha256 varchar(64),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_media_rehosting_status_check CHECK (status IN ('stored','rejected')),
  CONSTRAINT supplier_media_rehosting_stored_url_check CHECK (status = 'rejected' OR managed_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS supplier_media_rehosting_product_idx
  ON supplier_media_rehosting(product_id, variant_id);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_media_rehosting_parent_source_unique
  ON supplier_media_rehosting(supplier_id, catalogue_item_id, source_url)
  WHERE catalogue_variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_media_rehosting_variant_source_unique
  ON supplier_media_rehosting(supplier_id, catalogue_variant_id, source_url)
  WHERE catalogue_variant_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS product_media_toonies_source_unique;
CREATE UNIQUE INDEX IF NOT EXISTS product_media_toonies_parent_source_unique
  ON product_media(product_id, source_workflow, source_url)
  WHERE variant_id IS NULL AND source_workflow IS NOT NULL AND source_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS product_media_toonies_variant_source_unique
  ON product_media(product_id, variant_id, source_workflow, source_url)
  WHERE variant_id IS NOT NULL AND source_workflow IS NOT NULL AND source_url IS NOT NULL;