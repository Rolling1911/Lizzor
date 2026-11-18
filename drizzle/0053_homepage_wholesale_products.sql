ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "homepage_wholesale" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_homepage_wholesale_idx" ON "products" ("homepage_wholesale");