-- Persisted, bounded Toonies search runs. A run is only completed after the
-- provider has told us where its result set ends; partial runs are resumable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'supplier_sync_run_status') THEN
    ALTER TYPE supplier_sync_run_status ADD VALUE IF NOT EXISTS 'partial' BEFORE 'completed';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE supplier_sync_runs
  ADD COLUMN IF NOT EXISTS keyword varchar(100),
  ADD COLUMN IF NOT EXISTS category_id varchar(255),
  ADD COLUMN IF NOT EXISTS page_size integer DEFAULT 20 NOT NULL,
  ADD COLUMN IF NOT EXISTS next_page integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS next_cursor text,
  ADD COLUMN IF NOT EXISTS processed_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS expected_count integer,
  ADD COLUMN IF NOT EXISTS expected_pages integer,
  ADD COLUMN IF NOT EXISTS error_code varchar(80),
  ADD COLUMN IF NOT EXISTS provider_end_authoritative boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE supplier_sync_runs
   SET page_size = COALESCE(page_size, 20),
       next_page = COALESCE(next_page, page_count + 1),
       processed_count = COALESCE(processed_count, item_count);
--> statement-breakpoint
ALTER TABLE supplier_sync_runs
  DROP CONSTRAINT IF EXISTS supplier_sync_runs_counts_nonnegative;
ALTER TABLE supplier_sync_runs
  ADD CONSTRAINT supplier_sync_runs_counts_nonnegative
  CHECK (page_count >= 0 AND item_count >= 0 AND processed_count >= 0
         AND error_count >= 0 AND next_page >= 1);
CREATE INDEX IF NOT EXISTS supplier_sync_runs_resume_idx
  ON supplier_sync_runs(supplier_id, status, started_at);