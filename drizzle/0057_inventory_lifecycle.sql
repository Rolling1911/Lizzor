ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;

INSERT INTO "admin_permissions" ("permission_key", "description")
VALUES ('inventory.delete', 'Permanently delete eligible unused inventory records')
ON CONFLICT ("permission_key") DO UPDATE SET "description" = EXCLUDED."description";

INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id
FROM "admin_roles" r
JOIN "admin_permissions" p ON p.permission_key = 'inventory.delete'
WHERE r.system_key = 'super_admin' AND r.active = true
ON CONFLICT DO NOTHING;