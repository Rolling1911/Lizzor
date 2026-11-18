ALTER TABLE products
  ADD COLUMN vat_classified_at timestamp with time zone;
--> statement-breakpoint

CREATE TABLE supplier_price_change_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  catalogue_item_id uuid NOT NULL REFERENCES supplier_catalogue_items(id) ON DELETE CASCADE,
  catalogue_variant_id uuid REFERENCES supplier_catalogue_variants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  history_id uuid NOT NULL UNIQUE REFERENCES supplier_cost_price_history(id) ON DELETE RESTRICT,
  pricing_rule_id uuid REFERENCES supplier_pricing_rules(id) ON DELETE SET NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  previous_cost_eur numeric(14,4) NOT NULL,
  proposed_cost_eur numeric(14,4) NOT NULL,
  previous_price_eur numeric(14,4) NOT NULL,
  proposed_price_eur numeric(14,4) NOT NULL,
  increase_percent numeric(12,4) NOT NULL,
  threshold_percent numeric(6,2) NOT NULL,
  reason varchar(80) NOT NULL DEFAULT 'significant_supplier_cost_increase',
  fx_rate_snapshot_id uuid REFERENCES fx_rate_snapshots(id) ON DELETE SET NULL,
  detected_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone,
  resolved_by_admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decision_note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT supplier_price_change_reviews_status
    CHECK (status IN ('pending','accepted','rejected','superseded')),
  CONSTRAINT supplier_price_change_reviews_scope
    CHECK ((catalogue_variant_id IS NULL AND variant_id IS NULL)
       OR (catalogue_variant_id IS NOT NULL AND variant_id IS NOT NULL)),
  CONSTRAINT supplier_price_change_reviews_values
    CHECK (previous_cost_eur >= 0 AND proposed_cost_eur >= 0
       AND previous_price_eur >= 0 AND proposed_price_eur >= 0
       AND increase_percent >= 0 AND threshold_percent >= 0)
);
--> statement-breakpoint

CREATE INDEX supplier_price_change_reviews_pending_idx
  ON supplier_price_change_reviews(supplier_id,status,detected_at DESC);
--> statement-breakpoint

CREATE UNIQUE INDEX supplier_price_change_reviews_one_pending_scope
  ON supplier_price_change_reviews(
    catalogue_item_id,
    COALESCE(catalogue_variant_id,'00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status='pending';