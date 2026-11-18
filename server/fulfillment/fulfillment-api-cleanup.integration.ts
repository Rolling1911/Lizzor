import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeDatabase, getDatabasePool } from "../db/client.js";
import { assertMutableIntegrationTestDatabase } from "../testing/database-safety.js";

function runSuite(forceFailure = false) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "server/fulfillment/fulfillment-api.integration.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        RETURN_API_TEST_FORCE_FAILURE_AFTER_FIXTURES: forceFailure ? "1" : "",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Return API integration terminated by ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

async function databaseFixtureSnapshot() {
  const pool = getDatabasePool();
  const [roles, permissions, users, rolePermissions, userRoles] = await Promise.all([
    pool.query<{ id: string }>("SELECT id FROM admin_roles ORDER BY id"),
    pool.query<{ id: string }>("SELECT id FROM admin_permissions ORDER BY id"),
    pool.query<{ id: string }>("SELECT id FROM users ORDER BY id"),
    pool.query<{ relationship: string }>("SELECT role_id::text || ':' || permission_id::text AS relationship FROM admin_role_permissions ORDER BY role_id,permission_id"),
    pool.query<{ relationship: string }>("SELECT user_id::text || ':' || role_id::text AS relationship FROM admin_user_roles ORDER BY user_id,role_id"),
  ]);
  return {
    roleIds: roles.rows.map((row) => row.id),
    permissionIds: permissions.rows.map((row) => row.id),
    userIds: users.rows.map((row) => row.id),
    rolePermissionRelationships: rolePermissions.rows.map((row) => row.relationship),
    staffRoleAssignments: userRoles.rows.map((row) => row.relationship),
  };
}

async function run() {
  assertMutableIntegrationTestDatabase("fulfillment return API cleanup regression");
  const before = await databaseFixtureSnapshot();
  try {
    assert.equal(await runSuite(), 0, "first return API integration run must pass");
    assert.deepEqual(await databaseFixtureSnapshot(), before, "first return API integration run must restore all role and staff fixture sets");
    assert.equal(await runSuite(), 0, "second return API integration run must pass");
    assert.deepEqual(await databaseFixtureSnapshot(), before, "running the return API integration twice must restore all role and staff fixture sets");
    assert.notEqual(await runSuite(true), 0, "forced post-fixture failure must fail the child suite");
    assert.deepEqual(await databaseFixtureSnapshot(), before, "failed return API integration teardown must restore all role and staff fixture sets");
    console.info(`Return API cleanup regression passed: persistent roles ${before.roleIds.length} before, ${before.roleIds.length} after two successful runs and one forced failure.`);
  } finally {
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});