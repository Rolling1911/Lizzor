INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('products.create', 'Create products'),
  ('products.edit', 'Edit products'),
  ('products.archive', 'Archive and restore products'),
  ('products.import', 'Import products'),
  ('products.export', 'Export products'),
  ('categories.create', 'Create categories'),
  ('categories.edit', 'Edit and archive categories'),
  ('brands.create', 'Create brands'),
  ('brands.edit', 'Edit and deactivate brands'),
  ('product_cost.view', 'View product cost prices')
ON CONFLICT ("permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r
CROSS JOIN "admin_permissions" p
WHERE r."name" = 'Super Admin'
  AND p."permission_key" IN (
    'products.create', 'products.edit', 'products.archive', 'products.import',
    'products.export', 'categories.create', 'categories.edit', 'brands.create',
    'brands.edit', 'product_cost.view'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;