import { getDatabasePool } from "../db/client.js";
import { permissionDescriptions, permissionKeys } from "./permission-catalog.js";

interface PermissionReconciliationResult {
  permissionsAdded: number;
  grantsAdded: number;
}

/**
 * The canonical Super Admin is the only role that automatically receives every
 * registered permission. This keeps new permission keys deploy-safe without
 * broadening any user-managed or lower-privileged role.
 */
export async function reconcileSuperAdminPermissions(): Promise<PermissionReconciliationResult> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lizzor:super-admin-permissions'))");
    const permissionsResult = await client.query(
      `INSERT INTO admin_permissions (permission_key, description)
       SELECT *
         FROM unnest($1::text[], $2::text[])
       ON CONFLICT (permission_key) DO UPDATE
         SET description=EXCLUDED.description
       WHERE admin_permissions.description IS NULL
         AND EXCLUDED.description IS NOT NULL`,
      [
        [...permissionKeys],
        permissionKeys.map((permissionKey) => permissionDescriptions[permissionKey] ?? null),
      ],
    );
    const grantsResult = await client.query(
      `INSERT INTO admin_role_permissions (role_id, permission_id)
       SELECT role.id, permission.id
         FROM admin_roles role
         CROSS JOIN admin_permissions permission
        WHERE role.system_key='super_admin'
          AND role.active=true
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
    );
    await client.query("COMMIT");
    return {
      permissionsAdded: permissionsResult.rowCount ?? 0,
      grantsAdded: grantsResult.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}