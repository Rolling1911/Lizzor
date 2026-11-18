-- Replit Publish applies schema changes before the new application starts.
-- Keep these indexes absent for the cleanup release; the idempotent startup
-- reconciliation repairs historical flags before a later migration restores
-- the constraints.
DROP INDEX IF EXISTS product_media_primary_product_unique;
--> statement-breakpoint
DROP INDEX IF EXISTS product_media_primary_variant_unique;