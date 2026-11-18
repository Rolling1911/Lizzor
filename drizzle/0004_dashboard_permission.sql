INSERT INTO "admin_permissions" ("permission_key", "description")
VALUES ('dashboard.view', 'View the administration dashboard')
ON CONFLICT ("permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r
JOIN "admin_permissions" p ON p."permission_key" = 'dashboard.view'
WHERE r."name" = 'Super Admin'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;