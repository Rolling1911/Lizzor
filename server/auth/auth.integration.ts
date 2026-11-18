import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { eq, inArray, sql } from "drizzle-orm";
import { createApp } from "../app.js";
import { closeDatabase, getDatabase } from "../db/client.js";
import {
  adminPermissions,
  adminRolePermissions,
  adminRoles,
  adminUserRoles,
  auditLogs,
  companies,
  emailVerificationTokens,
  passwordResetTokens,
  users,
} from "../db/schema.js";
import { getDevelopmentOutbox } from "./email.js";
import { runNotificationDeliveryWorker } from "../notifications/service.js";
import { hashPassword } from "./password.js";
import { canUser, createEmailVerificationToken, createPasswordResetToken, listUserPermissions } from "./service.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const personalEmail = `phase3-personal-${suffix}@example.test`;
const businessEmail = `phase3-business-${suffix}@example.test`;
const businessNoVatEmail = `phase3-business-no-vat-${suffix}@example.test`;
const companyEmail = `phase3-company-${suffix}@example.test`;
const companyNoVatEmail = `phase3-company-no-vat-${suffix}@example.test`;
const adminEmail = `phase3-admin-${suffix}@example.test`;
const limitedAdminEmail = `phase3-limited-${suffix}@example.test`;
const twoFactorAdminEmail = `phase3-two-factor-${suffix}@example.test`;
const password = "SecurePhase3Password1";

class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (!["GET", "HEAD"].includes(init.method?.toUpperCase() ?? "GET")) {
      const csrf = this.cookies.get("lizzor_csrf");
      if (csrf) headers.set("x-csrf-token", decodeURIComponent(csrf));
    }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = getSetCookie ? getSetCookie.call(response.headers) : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  }
}

async function tokenFromLatestEmail(to: string, subject: string): Promise<string> {
  await runNotificationDeliveryWorker();
  const email = [...getDevelopmentOutbox()].reverse().find((message) => message.to === to && message.subject.includes(subject));
  const token = email?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, `Expected a development email token for ${to}`);
  return token;
}

async function run(): Promise<void> {
  const app = await createApp({ serveFrontend: false });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const anonymous = new Client(baseUrl);
  const invalidRegistration = new Client(baseUrl);
  const personal = new Client(baseUrl);
  const business = new Client(baseUrl);
  const businessNoVat = new Client(baseUrl);
  const admin = new Client(baseUrl);
  const limitedAdmin = new Client(baseUrl);
  const twoFactorAdmin = new Client(baseUrl);

  try {
    const malformedCookieResponse = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie: "broken=%E0%A4%A; lizzor_csrf=valid" } });
    assert.equal(malformedCookieResponse.status, 200, "Malformed cookies must be ignored instead of crashing authentication.");
    await personal.request("/auth/me");
    await invalidRegistration.request("/auth/me");
    let invalid = await invalidRegistration.request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ firstName: "Phase", lastName: "Missing Phone", email: `missing-phone-${suffix}@example.test`, countryCode: "CY", password, confirmPassword: password }),
    });
    assert.equal(invalid.response.status, 400);
    invalid = await invalidRegistration.request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ firstName: "Phase", lastName: "Missing Country", email: `missing-country-${suffix}@example.test`, phone: "99123456", password, confirmPassword: password }),
    });
    assert.equal(invalid.response.status, 400);
    invalid = await invalidRegistration.request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ firstName: "Phase", lastName: "Unsupported Country", email: `unsupported-country-${suffix}@example.test`, phone: "99123456", countryCode: "US", password, confirmPassword: password }),
    });
    assert.equal(invalid.response.status, 400);
    invalid = await invalidRegistration.request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ firstName: "Phase", lastName: "Wrong Prefix", email: `wrong-prefix-${suffix}@example.test`, phone: "+3099123456", countryCode: "CY", password, confirmPassword: password }),
    });
    assert.equal(invalid.response.status, 400);
    let result = await personal.request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ firstName: "Phase", lastName: "Personal", email: personalEmail, phone: "99 123456", countryCode: "cy", password, confirmPassword: password }),
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.data.user.accountType, "personal");
    assert.equal(result.body.data.user.countryCode, "CY");
    assert.equal(result.body.data.user.phone, "+35799123456");

    result = await personal.request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ firstName: "Phase", lastName: "Duplicate", email: personalEmail, phone: "99123456", countryCode: "CY", password, confirmPassword: password }),
    });
    assert.equal(result.response.status, 409);
    assert.equal((await personal.request("/account/profile")).response.status, 200);
    assert.equal((await anonymous.request("/account/profile")).response.status, 401);
    assert.equal((await personal.request("/admin/session")).response.status, 403);
    assert.equal((await personal.request("/admin/dashboard")).response.status, 403);

    const verificationToken = await tokenFromLatestEmail(personalEmail, "Verify");
    result = await personal.request("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationToken }) });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.data, { verified: true, alreadyVerified: false });
    result = await personal.request("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verificationToken }) });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.data, { verified: true, alreadyVerified: true });
    assert.equal((await personal.request("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: "invalid-verification-token-value-00000000" }) })).response.status, 400);
    const personalUser = await getDatabase().select({ id: users.id }).from(users).where(eq(users.email, personalEmail)).limit(1);
    assert.ok(personalUser[0]);
    const expiredVerification = await createEmailVerificationToken(personalUser[0].id, personalEmail);
    await getDatabase().update(emailVerificationTokens).set({ expiresAt: new Date(0) })
      .where(eq(emailVerificationTokens.tokenHash, hashForTest(expiredVerification)));
    assert.equal((await personal.request("/auth/verify-email", { method: "POST", body: JSON.stringify({ token: expiredVerification }) })).response.status, 400);

    assert.equal((await personal.request("/auth/logout", { method: "POST" })).response.status, 204);
    assert.equal((await personal.request("/account/profile")).response.status, 401);
    await personal.request("/auth/me");
    assert.equal((await personal.request("/auth/login", { method: "POST", body: JSON.stringify({ email: personalEmail, password: "WrongPassword1" }) })).response.status, 401);
    assert.equal((await personal.request("/auth/login", { method: "POST", body: JSON.stringify({ email: personalEmail, password }) })).response.status, 200);

    await businessNoVat.request("/auth/me");
    result = await businessNoVat.request("/auth/register/business", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Phase", lastName: "No VAT", email: businessNoVatEmail, phone: "99 111111", countryCode: "CY", password, confirmPassword: password,
        companyName: `Phase 3 No VAT Company ${suffix}`, vatNumber: "   ", contactPerson: "Phase No VAT",
        companyEmail: companyNoVatEmail, companyPhone: "22 111111",
      }),
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.data.user.accountType, "business");
    assert.equal(result.body.data.user.company.vatNumber, null);
    const [noVatCompany] = await getDatabase().select({ vatNumber: companies.vatNumber }).from(companies).where(eq(companies.email, companyNoVatEmail)).limit(1);
    assert.equal(noVatCompany?.vatNumber, null, "blank VAT input must be normalized to null");

    await business.request("/auth/me");
    result = await business.request("/auth/register/business", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Phase", lastName: "Business", email: businessEmail, phone: "99 222222", countryCode: "cy", password, confirmPassword: password,
        companyName: `Phase 3 Company ${suffix}`, vatNumber: `VAT-${suffix}`, contactPerson: "Phase Business",
        companyEmail, companyPhone: "22 333333",
      }),
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.data.user.accountType, "business");
    assert.equal(result.body.data.user.phone, "+35799222222");
    assert.equal(result.body.data.user.countryCode, "CY");
    assert.equal(result.body.data.user.company.countryCode, "CY");
    assert.equal(result.body.data.user.company.vatNumber, `VAT-${suffix}`);
    const [businessCompany] = await getDatabase().select({ phone: companies.phone, vatNumber: companies.vatNumber }).from(companies).where(eq(companies.email, companyEmail)).limit(1);
    assert.equal(businessCompany?.phone, "+35722333333");
    assert.equal(businessCompany?.vatNumber, `VAT-${suffix}`, "valid VAT numbers must remain unchanged");

    result = await personal.request("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: personalEmail }) });
    assert.equal(result.response.status, 200);
    const expiredReset = await createPasswordResetToken(personalUser[0].id, personalEmail);
    await getDatabase().update(passwordResetTokens).set({ expiresAt: new Date(0) })
      .where(eq(passwordResetTokens.tokenHash, hashForTest(expiredReset)));
    assert.equal((await personal.request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token: expiredReset, password, confirmPassword: password }) })).response.status, 400);
    result = await personal.request("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: personalEmail }) });
    const activeResetToken = await tokenFromLatestEmail(personalEmail, "Reset");
    assert.equal((await personal.request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token: "invalid-token-that-is-long-enough-000", password, confirmPassword: password }) })).response.status, 400);
    assert.equal((await personal.request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token: activeResetToken, password, confirmPassword: password }) })).response.status, 200);
    await personal.request("/auth/me");
    assert.equal((await personal.request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token: activeResetToken, password, confirmPassword: password }) })).response.status, 400);

    const db = getDatabase();
    const [permission] = await db.insert(adminPermissions).values({ permissionKey: "settings.manage" }).onConflictDoUpdate({
      target: adminPermissions.permissionKey,
      set: { permissionKey: "settings.manage" },
    }).returning();
    const [dashboardPermission] = await db.insert(adminPermissions).values({ permissionKey: "dashboard.view" }).onConflictDoUpdate({
      target: adminPermissions.permissionKey,
      set: { permissionKey: "dashboard.view" },
    }).returning();
    assert.ok(permission && dashboardPermission);
    const [adminRole] = await db.insert(adminRoles).values({ name: `Phase3 Admin ${suffix}` }).returning();
    const [limitedRole] = await db.insert(adminRoles).values({ name: `Phase3 Limited ${suffix}` }).returning();
    const [adminUser] = await db.insert(users).values({
      email: adminEmail, passwordHash: await hashPassword(password), firstName: "Phase", lastName: "Admin",
      status: "active", emailVerifiedAt: new Date(),
    }).returning();
    const [limitedUser] = await db.insert(users).values({
      email: limitedAdminEmail, passwordHash: await hashPassword(password), firstName: "Phase", lastName: "Limited",
      status: "active", emailVerifiedAt: new Date(),
    }).returning();
    const [twoFactorUser] = await db.insert(users).values({
      email: twoFactorAdminEmail, passwordHash: await hashPassword(password), firstName: "Phase", lastName: "Two Factor",
      status: "active", emailVerifiedAt: new Date(),
    }).returning();
    assert.ok(adminRole && limitedRole && adminUser && limitedUser && twoFactorUser);
    await db.insert(adminRolePermissions).values([
      { roleId: adminRole.id, permissionId: permission.id },
      { roleId: adminRole.id, permissionId: dashboardPermission.id },
    ]);
    await db.insert(adminUserRoles).values([{ roleId: adminRole.id, userId: adminUser.id }, { roleId: limitedRole.id, userId: limitedUser.id }, { roleId: adminRole.id, userId: twoFactorUser.id }]);

    await getDatabase().execute(sql`INSERT INTO admin_two_factor (user_id,status,secret_ciphertext) VALUES (${twoFactorUser.id},'enabled',${encryptTwoFactorSecret("JBSWY3DPEHPK3PXP")})`);

    await admin.request("/auth/me");
    assert.equal((await admin.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: adminEmail, password }) })).response.status, 200);
    assert.equal((await admin.request("/admin/session")).response.status, 200);
    assert.equal((await admin.request("/admin/security-check")).response.status, 200);
    const dashboard = await admin.request("/admin/dashboard?range=30d");
    assert.equal(dashboard.response.status, 200);
    assert.equal(typeof (dashboard.body as { data: { metrics: { orders: unknown } } }).data.metrics.orders, "number");

    await limitedAdmin.request("/auth/me");
    assert.equal((await limitedAdmin.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: limitedAdminEmail, password }) })).response.status, 200);
    assert.equal((await limitedAdmin.request("/admin/security-check")).response.status, 403);
    assert.equal((await limitedAdmin.request("/admin/dashboard")).response.status, 403);
    await db.update(adminRoles).set({ active: false }).where(eq(adminRoles.id, limitedRole.id));
    assert.equal(await canUser(limitedUser.id, "dashboard.view"), false);
    assert.deepEqual(await listUserPermissions(limitedUser.id), []);
    assert.deepEqual((await limitedAdmin.request("/auth/me")).body.data.permissions, []);
    assert.equal((await limitedAdmin.request("/admin/session")).response.status, 403);

    await twoFactorAdmin.request("/auth/me");
    const challenge = await twoFactorAdmin.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: twoFactorAdminEmail, password }) });
    assert.equal(challenge.response.status, 403);
    const challengeToken = challenge.body.error.details.challengeToken as string;
    assert.ok(challengeToken);
    assert.equal((await twoFactorAdmin.request("/auth/me")).body.data.sessionType, null, "2FA challenge must not create a session");
    assert.equal((await twoFactorAdmin.request("/auth/admin/login/verify-2fa", { method: "POST", body: JSON.stringify({ challengeToken, code: "000000" }) })).response.status, 401);
    const verified = await twoFactorAdmin.request("/auth/admin/login/verify-2fa", { method: "POST", body: JSON.stringify({ challengeToken, code: totp("JBSWY3DPEHPK3PXP") }) });
    assert.equal(verified.response.status, 200);
    assert.equal((await twoFactorAdmin.request("/admin/session")).response.status, 200);
    assert.equal((await twoFactorAdmin.request("/auth/admin/login/verify-2fa", { method: "POST", body: JSON.stringify({ challengeToken, code: totp("JBSWY3DPEHPK3PXP") }) })).response.status, 400);
    const expiringChallenge = await twoFactorAdmin.request("/auth/admin/login", { method: "POST", body: JSON.stringify({ email: twoFactorAdminEmail, password }) });
    const expiringToken = expiringChallenge.body.error.details.challengeToken as string;
    await getDatabase().execute(sql`UPDATE admin_two_factor_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=${hashForTest(expiringToken)}`);
    assert.equal((await twoFactorAdmin.request("/auth/admin/login/verify-2fa", { method: "POST", body: JSON.stringify({ challengeToken: expiringToken, code: totp("JBSWY3DPEHPK3PXP") }) })).response.status, 400);

    console.info("Phase 3 authentication integration checks passed.");
  } finally {
    const db = getDatabase();
    const fixtureUsers = await db.select({ id: users.id }).from(users).where(inArray(users.email, [personalEmail, businessEmail, businessNoVatEmail, adminEmail, limitedAdminEmail, twoFactorAdminEmail]));
    if (fixtureUsers.length) await db.delete(auditLogs).where(inArray(auditLogs.entityId, fixtureUsers.map((user) => user.id)));
    await db.delete(users).where(inArray(users.email, [personalEmail, businessEmail, businessNoVatEmail, adminEmail, limitedAdminEmail, twoFactorAdminEmail]));
    await db.delete(companies).where(inArray(companies.email, [companyEmail, companyNoVatEmail]));
    await db.delete(adminRoles).where(inArray(adminRoles.name, [`Phase3 Admin ${suffix}`, `Phase3 Limited ${suffix}`]));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeDatabase();
  }
}

function hashForTest(token: string): string {
  const secret = process.env.SESSION_SECRET;
  assert.ok(secret);
  return createHmac("sha256", secret).update(token).digest("hex");
}

function encryptTwoFactorSecret(secret: string): string {
  const key = createHash("sha256").update(process.env.SESSION_SECRET ?? "development-only-two-factor-key").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map((character) => alphabet.indexOf(character).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) => Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});