import { eq, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { closeDatabase, getDatabase } from "../db/client.js";
import {
  adminPermissions,
  adminRolePermissions,
  adminRoles,
  adminUserRoles,
  users,
} from "../db/schema.js";
import { hashPassword } from "./password.js";
import { permissionKeys } from "./permission-catalog.js";

async function bootstrapAdmin(): Promise<void> {
  if (!env.ADMIN_BOOTSTRAP_EMAIL || !env.ADMIN_BOOTSTRAP_PASSWORD) {
    throw new Error("ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD must be provided through environment secrets.");
  }

  const email = env.ADMIN_BOOTSTRAP_EMAIL.trim().toLowerCase();
  const passwordHash = await hashPassword(env.ADMIN_BOOTSTRAP_PASSWORD);
  await getDatabase().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('lizzor:first-admin-bootstrap'))`);
    const [existingAdmin] = await tx.select({ userId: adminUserRoles.userId }).from(adminUserRoles).limit(1);
    if (existingAdmin) {
      throw new Error("Bootstrap is disabled because an administrator already exists.");
    }

    const [existingUser] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existingUser) {
      throw new Error("Bootstrap email already belongs to a customer account.");
    }

    const [user] = await tx.insert(users).values({
      email,
      passwordHash,
      firstName: "Super",
      lastName: "Admin",
      accountType: "personal",
      status: "active",
      emailVerifiedAt: new Date(),
    }).returning();
    if (!user) throw new Error("Administrator creation failed.");

    const [role] = await tx.insert(adminRoles).values({
      name: "Super Admin",
      description: "Initial full-access administrator role.",
      systemKey: "super_admin",
    }).returning();
    if (!role) throw new Error("Administrator role creation failed.");

    await tx.insert(adminPermissions).values(
      permissionKeys.map((permissionKey) => ({ permissionKey })),
    ).onConflictDoNothing();
    const permissions = await tx.select({ id: adminPermissions.id }).from(adminPermissions);
    await tx.insert(adminRolePermissions).values(
      permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
    );
    await tx.insert(adminUserRoles).values({ userId: user.id, roleId: role.id });
  });

  console.info("Initial administrator created. Remove the bootstrap secrets now.");
}

bootstrapAdmin()
  .catch((error: unknown) => {
    console.error("Administrator bootstrap failed.", error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  })
  .finally(closeDatabase);