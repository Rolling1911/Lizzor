INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('analytics.sales', 'View sales, order, and product analytics'),
  ('analytics.customers', 'View customer and company analytics'),
  ('analytics.inventory', 'View inventory analytics'),
  ('analytics.margin', 'View restricted cost and product contribution analytics'),
  ('analytics.promotions', 'View promotion and coupon analytics'),
  ('reports.export', 'Export authorized reports')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id","permission_id")
SELECT r."id", p."id" FROM "admin_roles" r CROSS JOIN "admin_permissions" p
WHERE r."name" = 'Super Admin'
  AND p."permission_key" IN ('analytics.sales','analytics.customers','analytics.inventory','analytics.margin','analytics.promotions','reports.export')
ON CONFLICT DO NOTHING;