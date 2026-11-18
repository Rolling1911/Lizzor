INSERT INTO "admin_permissions" ("permission_key", "description")
VALUES ('products.delete', 'Permanently delete eligible archived products')
ON CONFLICT ("permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r
CROSS JOIN "admin_permissions" p
WHERE r."name" = 'Super Admin'
  AND p."permission_key" = 'products.delete'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;