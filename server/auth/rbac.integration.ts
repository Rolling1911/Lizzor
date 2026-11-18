import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { hashPassword } from "./password.js";
import { reconcileSuperAdminPermissions } from "./permission-reconciliation.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = "RbacIntegrationPassword1";

class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}
  async request(path: string, init: RequestInit = {}, csrf: "auto" | "none" = "auto") {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (csrf === "auto" && !["GET", "HEAD"].includes(init.method?.toUpperCase() ?? "GET")) {
      const token = this.cookies.get("lizzor_csrf");
      if (token) headers.set("x-csrf-token", decodeURIComponent(token));
    }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = getSetCookie ? getSetCookie.call(response.headers) : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value); else this.cookies.delete(name);
    }
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  }
}

async function run() {
  const pool = getDatabasePool();
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const anonymous = new Client(`http://127.0.0.1:${address.port}`);
  const manager = new Client(`http://127.0.0.1:${address.port}`);
  const viewer = new Client(`http://127.0.0.1:${address.port}`);
  let managerId = "", viewerId = "", customerId = "", invitedId = "";
  let managerRoleId = "", viewerRoleId = "", createdRoleId = "", legacyRoleId = "", inactiveRoleId = "", raceRoleId = "", protectedRoleId = "", futurePermissionId = "";
  try {
    const migrationFixture = await pool.connect();
    try {
      await migrationFixture.query("BEGIN");
      await migrationFixture.query("UPDATE admin_roles SET system_key=NULL WHERE system_key='super_admin'");
      await migrationFixture.query("INSERT INTO admin_roles (name,description) VALUES ($1,'Legacy case-variant fixture')", [`sUpEr AdMiN ${suffix}`.replace(` ${suffix}`, "")]);
      await migrationFixture.query(`WITH canonical AS (
        SELECT id FROM admin_roles WHERE lower(name)='super admin' ORDER BY created_at,id LIMIT 1
      ) UPDATE admin_roles SET system_key='super_admin'
        WHERE id=(SELECT id FROM canonical)
          AND NOT EXISTS (SELECT 1 FROM admin_roles WHERE system_key='super_admin')`);
      assert.equal(Number((await migrationFixture.query("SELECT count(*) AS count FROM admin_roles WHERE system_key='super_admin'")).rows[0].count), 1, "legacy case-variant Super Admin roles must backfill deterministically");
      await migrationFixture.query("ROLLBACK");
    } finally { migrationFixture.release(); }
    const passwordHash = await hashPassword(password);
    const permissionRows = (await pool.query(
      `INSERT INTO admin_permissions (permission_key,description) VALUES
        ('staff.view','View staff'),('staff.manage','Manage staff'),('roles.view','View roles'),('roles.manage','Manage roles')
       ON CONFLICT (permission_key) DO UPDATE SET description=EXCLUDED.description RETURNING id,permission_key`,
    )).rows;
    managerRoleId = (await pool.query("INSERT INTO admin_roles (name,description,staff_assignable) VALUES ($1,'RBAC integration manager',true) RETURNING id", [`RBAC manager ${suffix}`])).rows[0].id;
    viewerRoleId = (await pool.query("INSERT INTO admin_roles (name,description,staff_assignable) VALUES ($1,'RBAC integration viewer',true) RETURNING id", [`RBAC viewer ${suffix}`])).rows[0].id;
    legacyRoleId = (await pool.query("INSERT INTO admin_roles (name,description) VALUES ($1,'Existing non-assignable staff role') RETURNING id", [`RBAC legacy ${suffix}`])).rows[0].id;
    inactiveRoleId = (await pool.query("INSERT INTO admin_roles (name,description,active,staff_assignable) VALUES ($1,'Inactive assignment fixture',false,true) RETURNING id", [`RBAC inactive ${suffix}`])).rows[0].id;
    raceRoleId = (await pool.query("INSERT INTO admin_roles (name,description,staff_assignable) VALUES ($1,'Assignment race fixture',true) RETURNING id", [`RBAC race ${suffix}`])).rows[0].id;
    protectedRoleId = (await pool.query("SELECT id FROM admin_roles WHERE system_key='super_admin'")).rows[0]?.id;
    assert.ok(protectedRoleId, "the protected Super Admin role must exist after migration");
    await pool.query(
      "DELETE FROM admin_permissions WHERE permission_key=ANY($1::text[])",
      [["legal.view", "legal.manage"]],
    );
    futurePermissionId = (await pool.query(
      "INSERT INTO admin_permissions (permission_key,description) VALUES ($1,'Future permission reconciliation fixture') RETURNING id",
      [`future.permission.${suffix}`],
    )).rows[0].id;
    assert.deepEqual(
      await reconcileSuperAdminPermissions(),
      { permissionsAdded: 2, grantsAdded: 3 },
      "missing catalog permissions and existing future permissions must be reconciled to the canonical Super Admin",
    );
    assert.deepEqual(
      (await pool.query(
        "SELECT permission_key,description FROM admin_permissions WHERE permission_key=ANY($1::text[]) ORDER BY permission_key",
        [["legal.view", "legal.manage"]],
      )).rows,
      [
        { permission_key: "legal.manage", description: "Manage legal profile, drafts, readiness, and publication" },
        { permission_key: "legal.view", description: "View legal documents, versions, previews, and readiness" },
      ],
      "recreated legal permission catalog rows must retain their descriptions",
    );
    assert.equal(Number((await pool.query(
      "SELECT count(*) AS count FROM admin_role_permissions WHERE role_id=$1 AND permission_id=$2",
      [protectedRoleId, futurePermissionId],
    )).rows[0].count), 1, "future permission keys must reach the canonical Super Admin");
    assert.equal(Number((await pool.query(
      "SELECT count(*) AS count FROM admin_role_permissions WHERE role_id=ANY($1::uuid[]) AND permission_id=$2",
      [[managerRoleId, viewerRoleId], futurePermissionId],
    )).rows[0].count), 0, "future permission reconciliation must not grant lower roles");
    const protectedLegalPermissions = await pool.query(
      `SELECT p.permission_key
         FROM admin_role_permissions rp
         JOIN admin_permissions p ON p.id=rp.permission_id
        WHERE rp.role_id=$1 AND p.permission_key=ANY($2::text[])
        ORDER BY p.permission_key`,
      [protectedRoleId, ["legal.view", "legal.manage"]],
    );
    assert.deepEqual(protectedLegalPermissions.rows.map((row) => row.permission_key), ["legal.manage", "legal.view"], "canonical Super Admin must receive both legal permissions");
    assert.equal(Number((await pool.query(
      `SELECT count(*) AS count
         FROM admin_role_permissions rp
         JOIN admin_permissions p ON p.id=rp.permission_id
        WHERE rp.role_id=ANY($1::uuid[]) AND p.permission_key=ANY($2::text[])`,
      [[managerRoleId, viewerRoleId], ["legal.view", "legal.manage"]],
    )).rows[0].count), 0, "the legal permission backfill must not change lower-privileged roles");
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key=ANY($2::text[])", [managerRoleId, ["staff.view", "staff.manage", "roles.view", "roles.manage"]]);
    await pool.query("INSERT INTO admin_role_permissions (role_id,permission_id) SELECT $1,id FROM admin_permissions WHERE permission_key=ANY($2::text[])", [viewerRoleId, ["staff.view", "staff.manage", "roles.view", "roles.manage", "legal.view"]]);
    managerId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'RBAC','Manager','active',now()) RETURNING id", [`rbac-manager-${suffix}@example.test`, passwordHash])).rows[0].id;
    viewerId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'RBAC','Viewer','active',now()) RETURNING id", [`rbac-viewer-${suffix}@example.test`, passwordHash])).rows[0].id;
    customerId = (await pool.query("INSERT INTO users (email,password_hash,first_name,last_name,status,email_verified_at) VALUES ($1,$2,'Not','Staff','active',now()) RETURNING id", [`rbac-customer-${suffix}@example.test`, passwordHash])).rows[0].id;
    await pool.query("INSERT INTO admin_user_roles (user_id,role_id) VALUES ($1,$2),($1,$3),($4,$5),($4,$6)", [managerId, managerRoleId, protectedRoleId, viewerId, viewerRoleId, legacyRoleId]);

    assert.equal((await anonymous.request("/admin/staff")).response.status, 403);
    await manager.request("/auth/me");
    await viewer.request("/auth/me");
    const managerLogin = await manager.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `rbac-manager-${suffix}@example.test`, password }) });
    assert.equal(managerLogin.response.status, 200);
    assert.deepEqual(
      ["legal.manage", "legal.view"].filter((permission) => managerLogin.body.data.permissions.includes(permission)),
      ["legal.manage", "legal.view"],
      "a fresh canonical Super Admin login must receive both legal permissions",
    );
    assert.equal((await viewer.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `rbac-viewer-${suffix}@example.test`, password }) })).response.status, 200);
    assert.equal((await manager.request("/admin/staff")).response.status, 200);
    const initialRoleOptions = await manager.request("/admin/staff-role-options");
    assert.equal(initialRoleOptions.response.status, 200);
    const initialOptionIds = new Set(initialRoleOptions.body.data.items.map((role: any) => role.id));
    assert.equal(initialOptionIds.has(viewerRoleId), true, "active approved custom roles must be assignment options");
    assert.equal(initialOptionIds.has(legacyRoleId), false, "active non-assignable roles must not be assignment options");
    assert.equal(initialOptionIds.has(inactiveRoleId), false, "inactive roles must not be assignment options");
    assert.equal(initialOptionIds.has(protectedRoleId), false, "canonical Super Admin must not be an assignment option");
    assert.equal((await anonymous.request("/admin/legal")).response.status, 403, "users without legal.view must remain blocked");
    assert.equal((await viewer.request("/admin/legal")).response.status, 200, "legal.view must allow the Legal & Compliance workspace");
    assert.equal((await viewer.request("/admin/legal/profile", { method: "PUT", body: JSON.stringify({}) })).response.status, 403, "legal.view alone must not allow legal mutations");
    assert.equal((await manager.request("/admin/legal")).response.status, 200, "canonical Super Admin access must include legal.view");
    const managerSession = await manager.request("/auth/me");
    assert.deepEqual(
      ["legal.manage", "legal.view"].filter((permission) => managerSession.body.data.permissions.includes(permission)),
      ["legal.manage", "legal.view"],
      "a new authenticated session bootstrap must retain both legal permissions",
    );
    assert.equal((await manager.request(`/admin/staff/${customerId}`)).response.status, 404, "customer identities must not cross the staff boundary");
    assert.equal((await viewer.request(`/admin/staff/${viewerId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId, protectedRoleId] }) })).response.status, 403, "non-Super-Admins must not assign themselves the protected role");
    assert.equal((await viewer.request(`/admin/roles/${viewerRoleId}/permissions`, { method: "PUT", body: JSON.stringify({ permissionIds: permissionRows.map((permission: any) => permission.id) }) })).response.status, 403, "non-Super-Admins must not expand their own role authority");
    assert.equal((await viewer.request(`/admin/staff/${managerId}/status`, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) })).response.status, 403, "non-Super-Admins must not change privileged staff status");
    assert.equal((await viewer.request("/admin/staff", { method: "POST", body: JSON.stringify({ email: `blocked-${suffix}@example.test`, firstName: "Blocked", lastName: "Invite", roleIds: [viewerRoleId] }) })).response.status, 403);
    assert.equal((await manager.request("/admin/staff", { method: "POST", body: JSON.stringify({ email: `csrf-${suffix}@example.test`, firstName: "CSRF", lastName: "Blocked", roleIds: [viewerRoleId] }) }, "none")).response.status, 403);
    for (const [label, roleId] of [
      ["unknown", randomUUID()],
      ["inactive", inactiveRoleId],
      ["non-assignable", legacyRoleId],
      ["Super Admin", protectedRoleId],
    ] as const) {
      const rejected = await manager.request("/admin/staff", { method: "POST", body: JSON.stringify({ email: `${label.toLowerCase().replaceAll(" ", "-")}-${suffix}@example.test`, firstName: "Rejected", lastName: label, roleIds: [roleId] }) });
      assert.equal(rejected.response.status, 400, `${label} role must be rejected on manipulated staff creation`);
      assert.equal(rejected.body.error.code, "ROLE_NOT_STAFF_ASSIGNABLE");
    }

    const invited = await manager.request("/admin/staff", { method: "POST", body: JSON.stringify({ email: `invited-${suffix}@example.test`, firstName: "Invited", lastName: "Admin", roleIds: [viewerRoleId] }) });
    assert.equal(invited.response.status, 201);
    invitedId = invited.body.data.staff.id;
    assert.equal(invited.body.data.staff.status, "pending");
    assert.equal(invited.body.data.invitation.status, "queued");
    assert.doesNotMatch(JSON.stringify(invited.body), /resetToken|challengeToken|passwordHash|token=/i, "invitation secrets must never be returned");
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL", [invitedId])).rows[0].count), 1);

    const createdRole = await manager.request("/admin/roles", { method: "POST", body: JSON.stringify({ name: `Warehouse auditor ${suffix}`, description: "Read-only warehouse audit role" }) });
    assert.equal(createdRole.response.status, 201);
    createdRoleId = createdRole.body.data.role.id;
    assert.equal(createdRole.body.data.role.staffAssignable, false, "new custom roles must default to non-assignable");
    const protectedRole = await manager.request(`/admin/roles/${protectedRoleId}`);
    assert.equal(protectedRole.body.data.role.systemKey, "super_admin", "protected system identity must be exposed for safe administrative presentation");
    assert.equal(protectedRole.body.data.role.staffAssignable, false);
    const protectedAssignmentUpdate = await manager.request(`/admin/roles/${protectedRoleId}`, { method: "PATCH", body: JSON.stringify({ staffAssignable: true }) });
    assert.equal(protectedAssignmentUpdate.response.status, 409);
    assert.equal(protectedAssignmentUpdate.body.error.code, "SYSTEM_ROLE_STAFF_ASSIGNMENT_PROTECTED");
    await assert.rejects(
      pool.query("UPDATE admin_roles SET staff_assignable=true WHERE id=$1", [protectedRoleId]),
      (error: any) => error?.code === "23514",
      "the database must enforce that canonical Super Admin is never staff-assignable",
    );
    assert.equal((await manager.request(`/admin/roles/${protectedRoleId}/permissions`, { method: "PUT", body: JSON.stringify({ permissionIds: permissionRows.map((permission: any) => permission.id) }) })).response.status, 409, "Super Admin must retain every registered permission");
    const selectedPermissions = permissionRows.filter((permission: any) => ["staff.view", "roles.view"].includes(permission.permission_key)).map((permission: any) => permission.id);
    assert.equal((await manager.request(`/admin/roles/${createdRoleId}/permissions`, { method: "PUT", body: JSON.stringify({ permissionIds: selectedPermissions }) })).response.status, 200);
    for (const roleId of [randomUUID(), inactiveRoleId, legacyRoleId, protectedRoleId]) {
      const rejected = await manager.request(`/admin/staff/${invitedId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId, roleId] }) });
      assert.equal(rejected.response.status, 400, "manipulated role replacement must reject newly added non-assignable roles");
      assert.equal(rejected.body.error.code, "ROLE_NOT_STAFF_ASSIGNABLE");
    }
    const retainedLegacy = await manager.request(`/admin/staff/${viewerId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId, legacyRoleId] }) });
    assert.equal(retainedLegacy.response.status, 200, "an existing non-assignable assignment may remain");
    assert.deepEqual(new Set(retainedLegacy.body.data.staff.roles.map((role: any) => role.id)), new Set([viewerRoleId, legacyRoleId]));
    await pool.query("UPDATE admin_roles SET active=false WHERE id=$1", [legacyRoleId]);
    assert.equal((await manager.request(`/admin/staff/${viewerId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId, legacyRoleId] }) })).response.status, 200, "an existing inactive legacy assignment must survive an unchanged save");
    assert.equal((await manager.request(`/admin/staff/${viewerId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId] }) })).response.status, 200, "a legacy non-assignable assignment may be removed");
    const readdedLegacy = await manager.request(`/admin/staff/${viewerId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId, legacyRoleId] }) });
    assert.equal(readdedLegacy.response.status, 400, "a removed legacy assignment may not be re-added");
    assert.equal(readdedLegacy.body.error.code, "ROLE_NOT_STAFF_ASSIGNABLE");

    assert.equal((await manager.request(`/admin/roles/${createdRoleId}`, { method: "PATCH", body: JSON.stringify({ staffAssignable: true }) })).response.status, 200);
    assert.equal((await manager.request(`/admin/staff/${invitedId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId, createdRoleId] }) })).response.status, 200);
    assert.equal((await manager.request(`/admin/roles/${createdRoleId}`, { method: "PATCH", body: JSON.stringify({ staffAssignable: false }) })).response.status, 200);
    const retainedAfterDisable = await manager.request(`/admin/staff/${invitedId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId, createdRoleId] }) });
    assert.equal(retainedAfterDisable.response.status, 200, "disabling assignment must not remove or block retention of existing assignments");
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM admin_user_roles WHERE user_id=$1 AND role_id=$2", [invitedId, createdRoleId])).rows[0].count), 1);
    const assignmentAudits = await pool.query(
      `SELECT old_values_json,new_values_json FROM audit_logs
        WHERE actor_admin_id=$1 AND action='admin.role_updated' AND entity_id=$2
        ORDER BY created_at`,
      [managerId, createdRoleId],
    );
    assert.equal(assignmentAudits.rows.length, 2);
    assert.equal(assignmentAudits.rows[0].old_values_json.staffAssignable, false);
    assert.equal(assignmentAudits.rows[0].new_values_json.staffAssignable, true);
    assert.equal(assignmentAudits.rows[1].old_values_json.staffAssignable, true);
    assert.equal(assignmentAudits.rows[1].new_values_json.staffAssignable, false);
    const raceLock = await pool.connect();
    try {
      await raceLock.query("BEGIN");
      await raceLock.query("SELECT pg_advisory_xact_lock(hashtext('lizzor-admin-rbac-safety'))");
      await raceLock.query("UPDATE admin_roles SET staff_assignable=false WHERE id=$1", [raceRoleId]);
      const racedAssignment = manager.request(`/admin/staff/${invitedId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId, createdRoleId, raceRoleId] }) });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await raceLock.query("COMMIT");
      const racedResult = await racedAssignment;
      assert.equal(racedResult.response.status, 400, "assignment must re-check approval after waiting for the RBAC lock");
      assert.equal(racedResult.body.error.code, "ROLE_NOT_STAFF_ASSIGNABLE");
    } finally {
      await raceLock.query("ROLLBACK").catch(() => undefined);
      raceLock.release();
    }
    const removedAll = await manager.request(`/admin/staff/${invitedId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [] }) });
    assert.equal(removedAll.response.status, 200, "the sole remaining staff assignments may be removed");
    assert.deepEqual(removedAll.body.data.staff.roles, []);
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM admin_user_roles WHERE user_id=$1", [invitedId])).rows[0].count), 0);
    assert.equal((await viewer.request(`/admin/roles/${createdRoleId}`, { method: "PATCH", body: JSON.stringify({ active: false }) })).response.status, 403);
    assert.equal((await manager.request(`/admin/roles/${createdRoleId}`, { method: "PATCH", body: JSON.stringify({ active: false }) }, "none")).response.status, 403);
    assert.equal((await manager.request(`/admin/staff/${viewerId}/roles`, { method: "PUT", body: JSON.stringify({ roleIds: [viewerRoleId] }) })).response.status, 200);
    assert.equal((await viewer.request("/admin/staff")).response.status, 403, "role assignment changes must revoke existing admin sessions");

    const viewerRelogin = new Client(`http://127.0.0.1:${address.port}`);
    await viewerRelogin.request("/auth/me");
    assert.equal((await viewerRelogin.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: `rbac-viewer-${suffix}@example.test`, password }) })).response.status, 200);
    await pool.query("UPDATE admin_roles SET active=false WHERE id=$1", [viewerRoleId]);
    assert.equal((await viewerRelogin.request("/admin/staff")).response.status, 403, "inactive roles must grant no access");

    const audits = await pool.query("SELECT action FROM audit_logs WHERE actor_admin_id=$1 AND action IN ('admin.staff_created','admin.staff_roles_updated','admin.role_created','admin.role_permissions_updated')", [managerId]);
    assert.deepEqual(new Set(audits.rows.map((row) => row.action)), new Set(["admin.staff_created", "admin.staff_roles_updated", "admin.role_created", "admin.role_permissions_updated"]));
    console.log("staff and RBAC integration passed");
  } finally {
    const userIds = [managerId, viewerId, customerId, invitedId].filter(Boolean);
    const roleIds = [managerRoleId, viewerRoleId, createdRoleId, legacyRoleId, inactiveRoleId, raceRoleId].filter(Boolean);
    if (userIds.length) {
      await pool.query("DELETE FROM notification_deliveries WHERE user_id=ANY($1::uuid[])", [userIds]).catch(() => undefined);
      await pool.query("DELETE FROM audit_logs WHERE actor_admin_id=ANY($1::uuid[]) OR actor_user_id=ANY($1::uuid[]) OR entity_id=ANY($1::uuid[])", [userIds]).catch(() => undefined);
      await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]).catch(() => undefined);
    }
    if (roleIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE entity_id=ANY($1::uuid[])", [roleIds]).catch(() => undefined);
      await pool.query("DELETE FROM admin_roles WHERE id=ANY($1::uuid[])", [roleIds]).catch(() => undefined);
    }
    if (futurePermissionId) await pool.query("DELETE FROM admin_permissions WHERE id=$1", [futurePermissionId]).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});