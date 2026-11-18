import { createPasswordResetToken, revokeUserSessions } from "./service.js";
import { getDatabasePool } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { env } from "../config/env.js";

type StaffFilters = { search?: string; status?: string; page?: number; pageSize?: number };

const staffSelect = `
  SELECT u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName",
         u.phone, u.status, u.email_verified_at AS "emailVerifiedAt",
         u.created_at AS "createdAt", u.updated_at AS "updatedAt",
          COALESCE(json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name, 'active', r.active, 'systemKey', r.system_key, 'staffAssignable', r.staff_assignable))
           FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS roles
    FROM users u
    LEFT JOIN admin_user_roles ur ON ur.user_id = u.id
    LEFT JOIN admin_roles r ON r.id = ur.role_id
`;

function pagination(page = 1, pageSize = 25) {
  return { page: Math.max(1, Math.floor(page)), pageSize: Math.min(100, Math.max(1, Math.floor(pageSize))) };
}

function statusClause(status: string | undefined, values: unknown[]) {
  if (!status) return "1=1";
  values.push(status);
  return `u.status = $${values.length}::user_status`;
}

function serializeStaff(row: any) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone ?? null,
    status: row.status,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    roles: Array.isArray(row.roles) ? row.roles : [],
  };
}

export async function listAdminStaff(filters: StaffFilters = {}) {
  const values: unknown[] = [];
  const clauses = ["EXISTS (SELECT 1 FROM admin_user_roles staff_role WHERE staff_role.user_id=u.id)", statusClause(filters.status, values)];
  if (filters.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    const parameter = `$${values.length}`;
    clauses.push(`(u.email ILIKE ${parameter} OR u.first_name ILIKE ${parameter} OR u.last_name ILIKE ${parameter} OR u.id::text ILIKE ${parameter})`);
  }
  const { page, pageSize } = pagination(filters.page, filters.pageSize);
  const where = `WHERE ${clauses.join(" AND ")}`;
  const pool = getDatabasePool();
  const count = await pool.query(`SELECT count(*)::text AS count FROM users u ${where}`, values);
  const rowValues = [...values, pageSize, (page - 1) * pageSize];
  const rows = await pool.query(`${staffSelect} ${where} GROUP BY u.id ORDER BY u.created_at DESC, u.id DESC LIMIT $${rowValues.length - 1} OFFSET $${rowValues.length}`, rowValues);
  const total = Number(count.rows[0]?.count ?? 0);
  return { items: rows.rows.map(serializeStaff), meta: { page, pageSize, total, hasNext: (page - 1) * pageSize + rows.rows.length < total } };
}

export async function getAdminStaff(userId: string) {
  return getAdminIdentity(userId, true);
}

async function getAdminIdentity(userId: string, requireStaff: boolean) {
  const pool = getDatabasePool();
  const staff = await pool.query(`${staffSelect} WHERE u.id=$1${requireStaff ? " AND EXISTS (SELECT 1 FROM admin_user_roles staff_role WHERE staff_role.user_id=u.id)" : ""} GROUP BY u.id`, [userId]);
  if (!staff.rows[0]) throw new AppError(404, "STAFF_NOT_FOUND", "The staff account was not found.");
  const [sessions, invitations] = await Promise.all([
    pool.query(`SELECT count(*)::int AS count FROM auth_sessions WHERE user_id=$1 AND type='admin' AND revoked_at IS NULL AND expires_at>now()`, [userId]),
    pool.query(`SELECT count(*)::int AS count FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL AND expires_at>now()`, [userId]),
  ]);
  return {
    staff: serializeStaff(staff.rows[0]),
    activeAdminSessions: Number(sessions.rows[0]?.count ?? 0),
    pendingInvitations: Number(invitations.rows[0]?.count ?? 0),
  };
}

async function lockRbacSafety(client: any) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('lizzor-admin-rbac-safety'))");
}

async function assertAccessAfterRemovingUser(client: any, userId: string) {
  const activeAdmins = await client.query(
    `SELECT count(*)::int AS count
       FROM users u
      WHERE u.status='active' AND u.id<>$1
        AND EXISTS (SELECT 1 FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id AND r.active=true WHERE ur.user_id=u.id)`,
    [userId],
  );
  if (Number(activeAdmins.rows[0]?.count ?? 0) < 1) throw new AppError(409, "LAST_ADMIN_PROTECTED", "This change would leave no active administrator.");
  const superAdmins = await client.query(
    `SELECT count(*)::int AS count
      FROM users u JOIN admin_user_roles ur ON ur.user_id=u.id JOIN admin_roles r ON r.id=ur.role_id
      WHERE u.status='active' AND r.system_key='super_admin' AND r.active=true AND u.id<>$1`,
    [userId],
  );
  if (Number(superAdmins.rows[0]?.count ?? 0) < 1) throw new AppError(409, "LAST_SUPER_ADMIN_PROTECTED", "The final active Super Admin cannot be removed or deactivated.");
}

async function assertAccessAfterRemovingRole(client: any, roleId: string) {
  const activeAdmins = await client.query(
    `SELECT count(DISTINCT u.id)::int AS count
       FROM users u JOIN admin_user_roles ur ON ur.user_id=u.id AND ur.role_id<>$1
       JOIN admin_roles r ON r.id=ur.role_id AND r.active=true
      WHERE u.status='active'`,
    [roleId],
  );
  if (Number(activeAdmins.rows[0]?.count ?? 0) < 1) throw new AppError(409, "LAST_ADMIN_PROTECTED", "This change would leave no active administrator.");
  const role = (await client.query("SELECT system_key AS \"systemKey\" FROM admin_roles WHERE id=$1", [roleId])).rows[0];
  if (role?.systemKey === "super_admin") {
    const superAdmins = await client.query(
      `SELECT count(DISTINCT u.id)::int AS count
         FROM users u JOIN admin_user_roles ur ON ur.user_id=u.id AND ur.role_id<>$1
         JOIN admin_roles r ON r.id=ur.role_id AND r.system_key='super_admin' AND r.active=true
        WHERE u.status='active'`,
      [roleId],
    );
    if (Number(superAdmins.rows[0]?.count ?? 0) < 1) throw new AppError(409, "LAST_SUPER_ADMIN_PROTECTED", "The final active Super Admin role cannot be deactivated.");
  }
}

export async function createAdminStaff(input: { email: string; firstName: string; lastName: string; phone?: string | null; roleIds: string[] }, actorUserId: string) {
  const client = await getDatabasePool().connect();
  let userId = "";
  try {
    await client.query("BEGIN");
    await lockRbacSafety(client);
    const roles = (await client.query(`SELECT id,name,active,staff_assignable AS "staffAssignable",system_key AS "systemKey" FROM admin_roles WHERE id=ANY($1::uuid[]) FOR UPDATE`, [input.roleIds])).rows;
    if (roles.length !== input.roleIds.length || roles.some((role: any) => !role.active || !role.staffAssignable || role.systemKey === "super_admin")) {
      throw new AppError(400, "ROLE_NOT_STAFF_ASSIGNABLE", "Every assigned role must be active and approved for staff assignment.");
    }
    const inserted = await client.query(
      `INSERT INTO users (email,first_name,last_name,phone,account_type,status)
       VALUES ($1,$2,$3,$4,'personal','pending') RETURNING id`,
      [input.email, input.firstName, input.lastName, input.phone || null],
    );
    userId = inserted.rows[0].id;
    if (input.roleIds.length) await client.query("INSERT INTO admin_user_roles (user_id,role_id) SELECT $1,id FROM admin_roles WHERE id=ANY($2::uuid[])", [userId, input.roleIds]);
    await client.query(
      `INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,new_values_json)
       VALUES ($1,'admin.staff_created','user',$2,$3)`,
      [actorUserId, userId, JSON.stringify({ email: input.email, firstName: input.firstName, lastName: input.lastName, roleIds: input.roleIds })],
    );
    await createPasswordResetToken(userId, input.email, client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as any)?.code === "23505") throw new AppError(409, "EMAIL_IN_USE", "An account with this email already exists.");
    throw error;
  } finally {
    client.release();
  }
  return { ...(await getAdminStaff(userId)), invitation: { status: "queued", providerConfigured: env.NODE_ENV !== "production", message: env.NODE_ENV === "production" ? "The invitation is recorded, but email delivery is not configured in this environment." : "The invitation was queued in the development email outbox." } };
}

export async function updateAdminStaffStatus(userId: string, status: "active" | "suspended" | "deactivated", actorUserId: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await lockRbacSafety(client);
    const old = (await client.query("SELECT id,status FROM users WHERE id=$1 AND EXISTS (SELECT 1 FROM admin_user_roles WHERE user_id=users.id) FOR UPDATE", [userId])).rows[0];
    if (!old) throw new AppError(404, "STAFF_NOT_FOUND", "The staff account was not found.");
    if (old.status === "active" && status !== "active") await assertAccessAfterRemovingUser(client, userId);
    await client.query("UPDATE users SET status=$1::user_status,updated_at=now() WHERE id=$2", [status, userId]);
    if (status !== "active") await client.query("UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND type='admin' AND revoked_at IS NULL", [userId]);
    await client.query(
      `INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json)
       VALUES ($1,'admin.staff_status_updated','user',$2,$3,$4)`,
      [actorUserId, userId, JSON.stringify({ status: old.status }), JSON.stringify({ status })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  return getAdminStaff(userId);
}

export async function setAdminStaffRoles(userId: string, roleIds: string[], actorUserId: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await lockRbacSafety(client);
    const user = (await client.query("SELECT id,status FROM users WHERE id=$1 AND EXISTS (SELECT 1 FROM admin_user_roles WHERE user_id=users.id) FOR UPDATE", [userId])).rows[0];
    if (!user) throw new AppError(404, "STAFF_NOT_FOUND", "The staff account was not found.");
    const oldRoles = (await client.query(`SELECT r.id,r.name,r.system_key AS "systemKey" FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id WHERE ur.user_id=$1`, [userId])).rows;
    const newRoles = roleIds.length
      ? (await client.query(`SELECT id,name,active,staff_assignable AS "staffAssignable",system_key AS "systemKey" FROM admin_roles WHERE id=ANY($1::uuid[]) FOR UPDATE`, [roleIds])).rows
      : [];
    if (newRoles.length !== roleIds.length) {
      throw new AppError(400, "ROLE_NOT_STAFF_ASSIGNABLE", "Every assigned role must exist.");
    }
    const oldRoleIds = new Set(oldRoles.map((role: any) => role.id));
    if (newRoles.some((role: any) => !oldRoleIds.has(role.id) && (!role.active || !role.staffAssignable || role.systemKey === "super_admin"))) {
      throw new AppError(400, "ROLE_NOT_STAFF_ASSIGNABLE", "New roles must be approved for staff assignment.");
    }
    if (user.status === "active" && !roleIds.length) await assertAccessAfterRemovingUser(client, userId);
    if (oldRoles.some((role: any) => role.systemKey === "super_admin" && !roleIds.includes(role.id)) && user.status === "active") await assertAccessAfterRemovingUser(client, userId);
    await client.query("DELETE FROM admin_user_roles WHERE user_id=$1", [userId]);
    if (roleIds.length) await client.query("INSERT INTO admin_user_roles (user_id,role_id) SELECT $1,id FROM admin_roles WHERE id=ANY($2::uuid[])", [userId, roleIds]);
    await client.query("UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND type='admin' AND revoked_at IS NULL", [userId]);
    await client.query(
      `INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json)
       VALUES ($1,'admin.staff_roles_updated','user',$2,$3,$4)`,
      [actorUserId, userId, JSON.stringify({ roles: oldRoles.map((role: any) => ({ id: role.id, name: role.name })) }), JSON.stringify({ roles: newRoles.map((role: any) => ({ id: role.id, name: role.name })) })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  return getAdminIdentity(userId, false);
}

export async function listAdminPermissions() {
  const rows = await getDatabasePool().query("SELECT id,permission_key AS \"permissionKey\",description FROM admin_permissions ORDER BY permission_key", []);
  const groups = rows.rows.reduce((result: Record<string, any[]>, permission: any) => {
    const [group] = String(permission.permissionKey).split(".");
    (result[group] ??= []).push(permission);
    return result;
  }, {});
  return { items: rows.rows, groups };
}

export async function listAdminRoles() {
  const rows = await getDatabasePool().query(
    `SELECT r.id,r.name,r.description,r.active,r.system_key AS "systemKey",r.staff_assignable AS "staffAssignable",r.created_at AS "createdAt",r.updated_at AS "updatedAt",
            count(DISTINCT ur.user_id)::int AS "staffCount",
            count(DISTINCT rp.permission_id)::int AS "permissionCount"
       FROM admin_roles r
       LEFT JOIN admin_user_roles ur ON ur.role_id=r.id
       LEFT JOIN admin_role_permissions rp ON rp.role_id=r.id
      GROUP BY r.id ORDER BY lower(r.name)`,
    [],
  );
  return { items: rows.rows };
}

export async function listStaffAssignableRoles() {
  const rows = await getDatabasePool().query(
    `SELECT id,name,description,active,system_key AS "systemKey",staff_assignable AS "staffAssignable"
       FROM admin_roles
      WHERE active=true AND staff_assignable=true AND system_key IS DISTINCT FROM 'super_admin'
      ORDER BY lower(name)`,
    [],
  );
  return { items: rows.rows };
}

export async function getAdminRole(roleId: string) {
  const pool = getDatabasePool();
  const role = (await pool.query(`SELECT id,name,description,active,system_key AS "systemKey",staff_assignable AS "staffAssignable",created_at AS "createdAt",updated_at AS "updatedAt" FROM admin_roles WHERE id=$1`, [roleId])).rows[0];
  if (!role) throw new AppError(404, "ROLE_NOT_FOUND", "The role was not found.");
  const permissions = await pool.query("SELECT p.id,p.permission_key AS \"permissionKey\",p.description FROM admin_role_permissions rp JOIN admin_permissions p ON p.id=rp.permission_id WHERE rp.role_id=$1 ORDER BY p.permission_key", [roleId]);
  return { role, permissions: permissions.rows };
}

export async function createAdminRole(input: { name: string; description?: string | null }, actorUserId: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("INSERT INTO admin_roles (name,description) VALUES ($1,$2) RETURNING id", [input.name, input.description || null]);
    const roleId = result.rows[0].id;
    await client.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,new_values_json) VALUES ($1,'admin.role_created','admin_role',$2,$3)", [actorUserId, roleId, JSON.stringify({ name: input.name, description: input.description || null })]);
    await client.query("COMMIT");
    return getAdminRole(roleId);
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as any)?.code === "23505") throw new AppError(409, "ROLE_NAME_IN_USE", "A role with this name already exists.");
    throw error;
  } finally { client.release(); }
}

export async function updateAdminRole(roleId: string, input: { name?: string; description?: string | null; active?: boolean; staffAssignable?: boolean }, actorUserId: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await lockRbacSafety(client);
    const old = (await client.query(`SELECT id,name,description,active,system_key AS "systemKey",staff_assignable AS "staffAssignable" FROM admin_roles WHERE id=$1 FOR UPDATE`, [roleId])).rows[0];
    if (!old) throw new AppError(404, "ROLE_NOT_FOUND", "The role was not found.");
    if (old.systemKey && input.name !== undefined && input.name !== old.name) throw new AppError(409, "SYSTEM_ROLE_NAME_PROTECTED", "The name of a protected system role cannot be changed.");
    if (old.systemKey === "super_admin" && input.staffAssignable === true) throw new AppError(409, "SYSTEM_ROLE_STAFF_ASSIGNMENT_PROTECTED", "The protected Super Admin role cannot be assigned through Staff administration.");
    if (old.active && input.active === false) await assertAccessAfterRemovingRole(client, roleId);
    const next = { name: input.name ?? old.name, description: input.description === undefined ? old.description : input.description, active: input.active ?? old.active, staffAssignable: old.systemKey === "super_admin" ? false : input.staffAssignable ?? old.staffAssignable };
    await client.query("UPDATE admin_roles SET name=$1,description=$2,active=$3,staff_assignable=$4,updated_at=now() WHERE id=$5", [next.name, next.description, next.active, next.staffAssignable, roleId]);
    await client.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,'admin.role_updated','admin_role',$2,$3,$4)", [actorUserId, roleId, JSON.stringify({ name: old.name, description: old.description, active: old.active, staffAssignable: old.staffAssignable }), JSON.stringify(next)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as any)?.code === "23505") throw new AppError(409, "ROLE_NAME_IN_USE", "A role with this name already exists.");
    throw error;
  } finally { client.release(); }
  return getAdminRole(roleId);
}

export async function setAdminRolePermissions(roleId: string, permissionIds: string[], actorUserId: string) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await lockRbacSafety(client);
    const role = (await client.query("SELECT id,name,active,system_key AS \"systemKey\" FROM admin_roles WHERE id=$1 FOR UPDATE", [roleId])).rows[0];
    if (!role) throw new AppError(404, "ROLE_NOT_FOUND", "The role was not found.");
    const permissions = (await client.query("SELECT id,permission_key AS \"permissionKey\" FROM admin_permissions WHERE id=ANY($1::uuid[])", [permissionIds])).rows;
    if (permissions.length !== permissionIds.length) throw new AppError(400, "INVALID_PERMISSION", "Every selected permission must exist.");
    if (role.systemKey === "super_admin") {
      const allPermissionIds = (await client.query("SELECT id FROM admin_permissions")).rows.map((permission: any) => permission.id);
      const selectedIds = new Set(permissionIds);
      if (allPermissionIds.length !== permissionIds.length || !allPermissionIds.every((permissionId: string) => selectedIds.has(permissionId))) {
        throw new AppError(409, "SUPER_ADMIN_PERMISSIONS_PROTECTED", "Super Admin must retain every registered administration permission.");
      }
    }
    const old = (await client.query("SELECT p.id,p.permission_key AS \"permissionKey\" FROM admin_role_permissions rp JOIN admin_permissions p ON p.id=rp.permission_id WHERE rp.role_id=$1", [roleId])).rows;
    await client.query("DELETE FROM admin_role_permissions WHERE role_id=$1", [roleId]);
    if (permissionIds.length) await client.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE id=ANY($2::uuid[])", [roleId, permissionIds]);
    await client.query("INSERT INTO audit_logs (actor_admin_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,'admin.role_permissions_updated','admin_role',$2,$3,$4)", [actorUserId, roleId, JSON.stringify({ permissions: old }), JSON.stringify({ permissions })]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  return getAdminRole(roleId);
}