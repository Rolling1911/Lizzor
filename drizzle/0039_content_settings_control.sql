ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "page_type" varchar(40) NOT NULL DEFAULT 'informational';
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "excerpt" text;
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "seo_title" varchar(70);
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "seo_description" varchar(170);
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "no_index" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_type_valid" CHECK ("page_type" IN ('about','help','faq','informational','legal'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_settings" (
  "key" varchar(120) PRIMARY KEY,
  "value_json" jsonb NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_settings_updated_idx" ON "site_settings" ("updated_at");
--> statement-breakpoint
INSERT INTO "homepage_sections" ("key","title","content_json","sort_order","active") VALUES
 ('hero','Hero','{}'::jsonb,10,true),
 ('best_sellers','Best Sellers','{}'::jsonb,20,true),
 ('deals','Deals','{}'::jsonb,30,true),
 ('categories','Categories','{}'::jsonb,40,true),
 ('why_lizzor','Why Lizzor','{}'::jsonb,50,true),
 ('app_banner','App Banner','{}'::jsonb,60,true),
 ('newsletter','Newsletter','{}'::jsonb,70,false)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_permissions" ("permission_key","description") VALUES
 ('homepage.manage','Manage homepage section visibility and ordering'),
 ('content.manage','Create, edit, publish, and archive content pages'),
 ('settings.manage','Manage validated non-secret site settings')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id","permission_id")
SELECT r."id",p."id" FROM "admin_roles" r CROSS JOIN "admin_permissions" p
WHERE r."system_key"='super_admin' AND p."permission_key" IN ('homepage.manage','content.manage','settings.manage')
ON CONFLICT ("role_id","permission_id") DO NOTHING;