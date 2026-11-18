ALTER TABLE "refunds"
ADD COLUMN IF NOT EXISTS "reason" text;
--> statement-breakpoint
INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('refunds.manage', 'Initiate and reconcile refunds'),
  ('activity.export', 'Export redacted activity logs')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r
CROSS JOIN "admin_permissions" p
WHERE r."name" = 'Super Admin'
  AND p."permission_key" IN ('refunds.manage', 'activity.export')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;