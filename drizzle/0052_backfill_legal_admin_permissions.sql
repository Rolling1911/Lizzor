INSERT INTO admin_permissions (permission_key, description)
VALUES
  ('legal.view', 'View legal documents, versions, previews, and readiness'),
  ('legal.manage', 'Manage legal profile, drafts, readiness, and publication')
ON CONFLICT (permission_key) DO NOTHING;
--> statement-breakpoint

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM admin_roles role
JOIN admin_permissions permission
  ON permission.permission_key IN ('legal.view', 'legal.manage')
WHERE role.system_key = 'super_admin'
  AND role.active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;