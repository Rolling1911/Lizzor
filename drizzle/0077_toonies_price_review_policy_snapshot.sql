ALTER TABLE supplier_price_change_reviews
  ADD COLUMN pricing_rule_type varchar(30),
  ADD COLUMN pricing_rule_value numeric(14,4),
  ADD COLUMN pricing_rounding_mode varchar(20),
  ADD COLUMN pricing_min_cost_eur numeric(14,4),
  ADD COLUMN pricing_max_cost_eur numeric(14,4);
--> statement-breakpoint

ALTER TABLE supplier_price_change_reviews
  ADD CONSTRAINT supplier_price_change_reviews_rule_type
    CHECK (pricing_rule_type IS NULL OR pricing_rule_type IN ('markup_percent','markup_fixed','margin_percent')),
  ADD CONSTRAINT supplier_price_change_reviews_rounding_mode
    CHECK (pricing_rounding_mode IS NULL OR pricing_rounding_mode IN ('none','whole','99'));