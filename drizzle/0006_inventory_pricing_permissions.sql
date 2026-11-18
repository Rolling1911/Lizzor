INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('inventory.view', 'View inventory and stock availability'),
  ('inventory.edit', 'Edit stock thresholds and inventory records'),
  ('inventory.adjust', 'Adjust stock and create inventory movements'),
  ('inventory.transfer', 'Transfer stock between warehouses'),
  ('inventory.import', 'Import inventory adjustments'),
  ('inventory.export', 'Export inventory records'),
  ('warehouse.view', 'View warehouses'),
  ('warehouse.manage', 'Create, edit, and deactivate warehouses'),
  ('pricing.view', 'View wholesale pricing'),
  ('pricing.edit', 'Edit wholesale pricing tiers'),
  ('pricing.import', 'Import wholesale pricing'),
  ('pricing.export', 'Export wholesale pricing'),
  ('pricing.bulk', 'Run bulk wholesale pricing operations')
ON CONFLICT ("permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r
CROSS JOIN "admin_permissions" p
WHERE r."name" = 'Super Admin'
  AND p."permission_key" IN (
    'inventory.view', 'inventory.edit', 'inventory.adjust', 'inventory.transfer',
    'inventory.import', 'inventory.export', 'warehouse.view', 'warehouse.manage',
    'pricing.view', 'pricing.edit', 'pricing.import', 'pricing.export', 'pricing.bulk'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;