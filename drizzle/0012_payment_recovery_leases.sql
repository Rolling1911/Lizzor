ALTER TABLE "payment_recovery_jobs" ADD COLUMN IF NOT EXISTS "lock_token" uuid;
INSERT INTO "admin_permissions" ("permission_key", "description")
VALUES ('payments.reconcile', 'Retry payment and refund recovery operations')
ON CONFLICT ("permission_key") DO NOTHING;
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r
JOIN "admin_permissions" p ON p."permission_key" = 'payments.reconcile'
WHERE r."name" = 'Super Admin'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;