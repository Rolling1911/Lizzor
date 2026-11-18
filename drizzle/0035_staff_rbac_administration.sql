INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('staff.manage', 'Manage staff accounts and role assignments'),
  ('roles.manage', 'Manage roles and role permissions')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r
CROSS JOIN "admin_permissions" p
WHERE lower(r."name") = 'super admin'
  AND p."permission_key" IN ('staff.manage', 'roles.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;