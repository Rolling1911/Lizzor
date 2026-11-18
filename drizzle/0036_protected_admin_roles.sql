ALTER TABLE "admin_roles" ADD COLUMN IF NOT EXISTS "system_key" varchar(50);
--> statement-breakpoint
WITH canonical AS (
  SELECT "id"
  FROM "admin_roles"
  WHERE lower("name")='super admin'
  ORDER BY "created_at", "id"
  LIMIT 1
)
UPDATE "admin_roles"
SET "system_key"='super_admin'
WHERE "id"=(SELECT "id" FROM canonical)
  AND NOT EXISTS (SELECT 1 FROM "admin_roles" WHERE "system_key"='super_admin');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_roles_system_key_unique" ON "admin_roles" ("system_key") WHERE "system_key" IS NOT NULL;