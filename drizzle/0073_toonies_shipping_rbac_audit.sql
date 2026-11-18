-- Dedicated least-privilege access for Toonies temporary shipping rules.
INSERT INTO admin_permissions(permission_key,description) VALUES
  ('supplier_shipping.view','View Toonies supplier shipping rules'),
  ('supplier_shipping.manage','Manage Toonies supplier shipping rules')
ON CONFLICT(permission_key) DO UPDATE SET description=EXCLUDED.description;
--> statement-breakpoint
INSERT INTO admin_role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM admin_roles r
CROSS JOIN admin_permissions p
WHERE r.system_key='super_admin'
  AND p.permission_key IN ('supplier_shipping.view','supplier_shipping.manage')
ON CONFLICT(role_id,permission_id) DO NOTHING;