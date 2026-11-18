CREATE INDEX IF NOT EXISTS "products_featured_public_homepage_idx"
  ON "products" ("updated_at" DESC, "id")
  WHERE "featured" = true AND "status" = 'active' AND "published_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_homepage_wholesale_public_idx"
  ON "products" ("updated_at" DESC, "id")
  WHERE "homepage_wholesale" = true AND "status" = 'active' AND "published_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_variants_active_product_idx"
  ON "product_variants" ("product_id", "id")
  WHERE "active" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_tiers_active_product_homepage_idx"
  ON "price_tiers" ("product_id", "min_quantity", "unit_price")
  WHERE "active" = true AND "variant_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_tiers_active_variant_homepage_idx"
  ON "price_tiers" ("variant_id", "min_quantity", "unit_price")
  WHERE "active" = true AND "variant_id" IS NOT NULL;