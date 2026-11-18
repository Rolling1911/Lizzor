ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "published_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN IF NOT EXISTS "archived_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_pages_published_idx" ON "content_pages" ("status","published_at");
--> statement-breakpoint
INSERT INTO "admin_permissions" ("permission_key","description") VALUES
 ('content.view','View content pages'),
 ('content.manage','Manage content pages')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id","permission_id")
SELECT r."id",p."id" FROM "admin_roles" r CROSS JOIN "admin_permissions" p
WHERE r."system_key"='super_admin' AND p."permission_key" IN ('content.view','content.manage')
ON CONFLICT ("role_id","permission_id") DO NOTHING;