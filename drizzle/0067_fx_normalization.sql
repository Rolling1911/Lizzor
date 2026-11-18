-- Provider-neutral CNY -> EUR FX provenance and normalization audit trail.
-- This migration is additive and intentionally contains no credentials.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fx_rate_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  provider varchar(80) NOT NULL,
  source varchar(80) NOT NULL,
  series varchar(160) NOT NULL,
  base_currency varchar(3) NOT NULL,
  quote_currency varchar(3) NOT NULL,
  rate numeric(20,12) NOT NULL,
  observed_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  fetch_cache_expires_at timestamptz NOT NULL,
  max_age_hours numeric(6,2) NOT NULL,
  response_hash varchar(128),
  raw_metadata jsonb,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT fx_rate_snapshots_rate_positive CHECK(rate > 0),
  CONSTRAINT fx_rate_snapshots_currency_pair CHECK(base_currency='EUR' AND quote_currency='CNY'),
  CONSTRAINT fx_rate_snapshots_expiry_order CHECK(expires_at >= observed_at AND fetch_cache_expires_at >= fetched_at),
  CONSTRAINT fx_rate_snapshots_max_age_bounded CHECK(max_age_hours >= 24 AND max_age_hours <= 168),
  CONSTRAINT fx_rate_snapshots_provider_series_observed_unique UNIQUE(provider,series,observed_at)
);
CREATE INDEX IF NOT EXISTS fx_rate_snapshots_lookup_idx ON fx_rate_snapshots(provider,series,base_currency,quote_currency,fetched_at);
--> statement-breakpoint
ALTER TABLE supplier_catalogue_items
  ADD COLUMN IF NOT EXISTS normalized_currency varchar(3),
  ADD COLUMN IF NOT EXISTS fx_rate_snapshot_id uuid REFERENCES fx_rate_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fx_rate_used numeric(20,12),
  ADD COLUMN IF NOT EXISTS fx_source varchar(80),
  ADD COLUMN IF NOT EXISTS fx_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS fx_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS fx_normalization_error varchar(80);
ALTER TABLE supplier_catalogue_variants
  ADD COLUMN IF NOT EXISTS normalized_currency varchar(3),
  ADD COLUMN IF NOT EXISTS fx_rate_snapshot_id uuid REFERENCES fx_rate_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fx_rate_used numeric(20,12),
  ADD COLUMN IF NOT EXISTS fx_source varchar(80),
  ADD COLUMN IF NOT EXISTS fx_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS fx_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS fx_normalization_error varchar(80);
CREATE INDEX IF NOT EXISTS supplier_catalogue_items_fx_snapshot_idx ON supplier_catalogue_items(fx_rate_snapshot_id);
CREATE INDEX IF NOT EXISTS supplier_catalogue_variants_fx_snapshot_idx ON supplier_catalogue_variants(fx_rate_snapshot_id);
--> statement-breakpoint
ALTER TABLE supplier_sync_runs
  ADD COLUMN IF NOT EXISTS fx_rate_snapshot_id uuid REFERENCES fx_rate_snapshots(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_fx_normalization_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_sync_run_id uuid REFERENCES supplier_sync_runs(id) ON DELETE SET NULL,
  fx_rate_snapshot_id uuid REFERENCES fx_rate_snapshots(id) ON DELETE SET NULL,
  status varchar(24) NOT NULL,
  item_count integer DEFAULT 0 NOT NULL,
  variant_count integer DEFAULT 0 NOT NULL,
  error_code varchar(80),
  error_message text,
  started_at timestamptz DEFAULT now() NOT NULL,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT supplier_fx_normalization_runs_status_valid CHECK(status IN ('running','completed','failed')),
  CONSTRAINT supplier_fx_normalization_runs_counts_nonnegative CHECK(item_count >= 0 AND variant_count >= 0)
);
CREATE INDEX IF NOT EXISTS supplier_fx_normalization_runs_supplier_started_idx ON supplier_fx_normalization_runs(supplier_id,started_at);
CREATE INDEX IF NOT EXISTS supplier_fx_normalization_runs_sync_idx ON supplier_fx_normalization_runs(supplier_sync_run_id);
--> statement-breakpoint
ALTER TABLE supplier_cost_price_history
  ADD COLUMN IF NOT EXISTS fx_rate_snapshot_id uuid REFERENCES fx_rate_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS previous_cost_cny numeric(14,4),
  ADD COLUMN IF NOT EXISTS next_cost_cny numeric(14,4),
  ADD COLUMN IF NOT EXISTS fx_rate_used numeric(20,12),
  ADD COLUMN IF NOT EXISTS fx_source varchar(80),
  ADD COLUMN IF NOT EXISTS fx_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS fx_fetched_at timestamptz;
CREATE INDEX IF NOT EXISTS supplier_cost_price_history_fx_snapshot_idx ON supplier_cost_price_history(fx_rate_snapshot_id);
--> statement-breakpoint
-- Existing normalized values have no provider provenance and are not
-- authoritative automatic FX results. They remain visible for review only.
UPDATE supplier_catalogue_items
SET state='Needs review', needs_review=true, fx_normalization_error=COALESCE(fx_normalization_error,'FX_PROVENANCE_REQUIRED')
WHERE fx_rate_snapshot_id IS NULL;
UPDATE supplier_catalogue_variants
SET state='Needs review', needs_review=true, fx_normalization_error=COALESCE(fx_normalization_error,'FX_PROVENANCE_REQUIRED')
WHERE fx_rate_snapshot_id IS NULL;