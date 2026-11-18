-- Preserve exact supplier decimal values and make each fetched FX snapshot immutable.
--> statement-breakpoint
ALTER TABLE supplier_catalogue_items
  ALTER COLUMN original_amount TYPE numeric(30,12) USING original_amount::numeric(30,12);
ALTER TABLE supplier_catalogue_variants
  ALTER COLUMN original_amount TYPE numeric(30,12) USING original_amount::numeric(30,12);
ALTER TABLE supplier_cost_price_history
  ALTER COLUMN previous_cost_cny TYPE numeric(30,12) USING previous_cost_cny::numeric(30,12),
  ALTER COLUMN next_cost_cny TYPE numeric(30,12) USING next_cost_cny::numeric(30,12);
--> statement-breakpoint
ALTER TABLE fx_rate_snapshots
  DROP CONSTRAINT IF EXISTS fx_rate_snapshots_provider_series_observed_unique;
DROP INDEX IF EXISTS fx_rate_snapshots_provider_series_observed_unique;
CREATE UNIQUE INDEX IF NOT EXISTS fx_rate_snapshots_provider_series_observed_fetched_unique
  ON fx_rate_snapshots(provider,series,observed_at,fetched_at);