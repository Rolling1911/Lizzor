ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "seo_title" varchar(70);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "seo_description" varchar(170);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "seo_title" varchar(70);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "seo_description" varchar(170);
--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "seo_title" varchar(70);
--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "seo_description" varchar(170);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slug_redirects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_type" varchar(20) NOT NULL,
  "entity_id" uuid NOT NULL,
  "old_slug" varchar(280) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "slug_redirects_entity_type_check" CHECK ("entity_type" IN ('product', 'category', 'brand'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slug_redirects_entity_type_old_slug_unique" ON "slug_redirects" USING btree ("entity_type", "old_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slug_redirects_entity_idx" ON "slug_redirects" USING btree ("entity_type", "entity_id");