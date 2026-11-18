ALTER TABLE supplier_price_change_reviews
  ADD COLUMN formula_price_eur numeric(14,4),
  ADD COLUMN manual_override_eur numeric(14,4),
  ADD COLUMN manual_override_source varchar(20);
--> statement-breakpoint

ALTER TABLE supplier_price_change_reviews
  ADD CONSTRAINT supplier_price_change_reviews_override_source
    CHECK (manual_override_source IS NULL OR manual_override_source IN ('link','variant','item')),
  ADD CONSTRAINT supplier_price_change_reviews_override_pair
    CHECK ((manual_override_eur IS NULL AND manual_override_source IS NULL) OR (manual_override_eur IS NOT NULL AND manual_override_source IS NOT NULL)),
  ADD CONSTRAINT supplier_price_change_reviews_provenance_values
    CHECK ((formula_price_eur IS NULL OR formula_price_eur >= 0) AND (manual_override_eur IS NULL OR manual_override_eur >= 0));