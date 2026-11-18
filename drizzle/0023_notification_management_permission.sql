INSERT INTO admin_permissions (permission_key,description)
VALUES ('notifications.manage','Retry and manage transactional notification deliveries')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO admin_role_permissions (role_id,permission_id)
SELECT arp.role_id, manage.id
FROM admin_role_permissions arp
JOIN admin_permissions view_permission ON view_permission.id=arp.permission_id AND view_permission.permission_key='notifications.view'
JOIN admin_permissions manage ON manage.permission_key='notifications.manage'
ON CONFLICT DO NOTHING;