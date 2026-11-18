-- Supports the bounded, newest-first combined sitemap query without changing
-- catalog data or caching price/inventory state.
CREATE INDEX IF NOT EXISTS "products_sitemap_updated_idx"
  ON "products" USING btree ("updated_at" DESC)
  WHERE "status" = 'active' AND "published_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categories_sitemap_updated_idx"
  ON "categories" USING btree ("updated_at" DESC)
  WHERE "active" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brands_sitemap_updated_idx"
  ON "brands" USING btree ("updated_at" DESC)
  WHERE "active" = true;