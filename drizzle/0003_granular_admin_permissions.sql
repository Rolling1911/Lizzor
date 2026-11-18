INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('orders.view', 'View orders in the administration center'),
  ('customers.view', 'View customer accounts'),
  ('companies.view', 'View business accounts and companies'),
  ('products.view', 'View products'),
  ('categories.view', 'View categories'),
  ('brands.view', 'View brands'),
  ('inventory.view', 'View inventory'),
  ('pricing.view', 'View pricing'),
  ('promotions.view', 'View promotions'),
  ('coupons.view', 'View coupons'),
  ('shipping.view', 'View shipping'),
  ('payments.view', 'View payments'),
  ('returns.view', 'View returns'),
  ('refunds.view', 'View refunds'),
  ('notifications.view', 'View notifications'),
  ('support.view', 'View support tickets'),
  ('chat.view', 'View live chat'),
  ('analytics.view', 'View analytics'),
  ('reports.view', 'View reports'),
  ('homepage.view', 'View homepage content'),
  ('content.view', 'View content'),
  ('staff.view', 'View staff administration'),
  ('roles.view', 'View roles and permissions'),
  ('activity.view', 'View activity logs'),
  ('settings.view', 'View administration settings')
ON CONFLICT ("permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r
CROSS JOIN "admin_permissions" p
WHERE r."name" = 'Super Admin'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;