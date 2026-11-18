import { and, eq, isNull, sql } from "drizzle-orm";
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { getDatabase, getDatabasePool } from "../db/client.js";
import {
  adminPermissions,
  adminRolePermissions,
  adminRoles,
  adminUserRoles,
  authSessions,
  auditLogs,
  companies,
  companyUsers,
  emailVerificationTokens,
  passwordResetTokens,
  users,
} from "../db/schema.js";
import { getClientIp } from "./types.js";
import { addDays, addHours, createOpaqueToken, hashOpaqueToken } from "./tokens.js";
import { emitNotification } from "../notifications/service.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error-handler.js";

export type AuthSessionType = "customer" | "admin";

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  countryCode: string | null;
  accountType: "personal" | "business";
  status: string;
  emailVerifiedAt: Date | null;
  company: { id: string; name: string; vatNumber: string | null; countryCode: string | null } | null;
}

export async function findUserByEmail(email: string) {
  const [user] = await getDatabase().select().from(users).where(eq(users.email, email)).limit(1);
  return user;
}

export async function getUserById(userId: string) {
  const [user] = await getDatabase().select().from(users).where(eq(users.id, userId)).limit(1);
  return user;
}

export async function getPublicUser(userId: string): Promise<PublicUser | null> {
  const db = getDatabase();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;

  const [membership] = await db
    .select({ id: companies.id, name: companies.companyName, vatNumber: companies.vatNumber, countryCode: companies.countryCode })
    .from(companyUsers)
    .innerJoin(companies, eq(companies.id, companyUsers.companyId))
    .where(and(eq(companyUsers.userId, userId), eq(companyUsers.companyId, user.activeCompanyId ?? "00000000-0000-0000-0000-000000000000")))
    .limit(1);

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    countryCode: user.countryCode,
    accountType: user.accountType,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    company: membership ?? null,
  };
}

export async function createSession(userId: string, type: AuthSessionType, request: Request, securityEmail?: string) {
  const sessionToken = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  const now = new Date();
  const client = await getDatabasePool().connect();
  let session;
  try {
    await client.query("BEGIN");
    session = (await client.query(`INSERT INTO auth_sessions (user_id,type,session_token_hash,csrf_token_hash,expires_at,last_seen_at,ip_address,user_agent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,expires_at AS "expiresAt"`,
      [userId,type,hashOpaqueToken(sessionToken),hashOpaqueToken(csrfToken),addDays(30),now,getClientIp(request),request.get("user-agent") ?? null])).rows[0];
    if (type === "admin" && securityEmail) {
      await emitNotification({type:"security.admin_login",idempotencyKey:`admin-login:${session.id}`,userId,email:securityEmail,
        message:"An administrator session was created for your account. If this was not you, contact support immediately."},client);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  return { sessionToken, csrfToken, sessionId: session.id, expiresAt: session.expiresAt };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await getDatabase().update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, sessionId));
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await getDatabase()
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
}

export async function createEmailVerificationToken(userId: string, email: string): Promise<string> {
  const token = createOpaqueToken();
  const client=await getDatabasePool().connect();
  try { await client.query("BEGIN"); await client.query("select pg_advisory_xact_lock(hashtext($1))",[`email-verification:${userId}`]); await client.query("UPDATE email_verification_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",[userId]); await client.query("INSERT INTO email_verification_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)",[userId,hashOpaqueToken(token),addHours(24)]); await emitNotification({type:"security.email_verification",idempotencyKey:`verify-email:${token}`,userId,email,message:"Use the secure link in this email to verify your account.",secureToken:token},client); await client.query("COMMIT"); } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
  return token;
}

export async function createPasswordResetToken(userId: string, email: string, database?: any): Promise<string> {
  const token = createOpaqueToken();
  if (database) {
    await database.query("select pg_advisory_xact_lock(hashtext($1))",[`password-reset:${userId}`]);
    await database.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",[userId]);
    await database.query("INSERT INTO password_reset_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)",[userId,hashOpaqueToken(token),addHours(1)]);
    await emitNotification({type:"security.password_reset",idempotencyKey:`password-reset:${token}`,userId,email,message:"Use the secure link in this email to reset your password.",secureToken:token},database);
    return token;
  }
  const client=await getDatabasePool().connect();
  try { await client.query("BEGIN"); await client.query("select pg_advisory_xact_lock(hashtext($1))",[`password-reset:${userId}`]); await client.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",[userId]); await client.query("INSERT INTO password_reset_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)",[userId,hashOpaqueToken(token),addHours(1)]); await emitNotification({type:"security.password_reset",idempotencyKey:`password-reset:${token}`,userId,email,message:"Use the secure link in this email to reset your password.",secureToken:token},client); await client.query("COMMIT"); } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
  return token;
}

export async function canUser(userId: string, permissionKey: string): Promise<boolean> {
  const [permission] = await getDatabase()
    .select({ id: adminPermissions.id })
    .from(adminUserRoles)
    .innerJoin(adminRoles, eq(adminRoles.id, adminUserRoles.roleId))
    .innerJoin(adminRolePermissions, eq(adminRolePermissions.roleId, adminUserRoles.roleId))
    .innerJoin(adminPermissions, eq(adminPermissions.id, adminRolePermissions.permissionId))
    .where(and(eq(adminUserRoles.userId, userId), eq(adminRoles.active, true), eq(adminPermissions.permissionKey, permissionKey)))
    .limit(1);
  return Boolean(permission);
}

export async function listUserPermissions(userId: string): Promise<string[]> {
  const rows = await getDatabase()
    .select({ key: adminPermissions.permissionKey })
    .from(adminUserRoles)
    .innerJoin(adminRoles, eq(adminRoles.id, adminUserRoles.roleId))
    .innerJoin(adminRolePermissions, eq(adminRolePermissions.roleId, adminUserRoles.roleId))
    .innerJoin(adminPermissions, eq(adminPermissions.id, adminRolePermissions.permissionId))
    .where(and(eq(adminUserRoles.userId, userId), eq(adminRoles.active, true)));
  return [...new Set(rows.map((row) => row.key))];
}

const twoFactorKey = () => {
  if (!env.SESSION_SECRET && env.NODE_ENV === "production") throw new Error("SESSION_SECRET is required for two-factor authentication.");
  return createHash("sha256").update(env.SESSION_SECRET ?? "development-only-two-factor-key").digest();
};

function decryptTwoFactorSecret(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Invalid two-factor secret.");
  const decipher = createDecipheriv("aes-256-gcm", twoFactorKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = value.replace(/[\s=-]/g, "").toUpperCase();
  let bits = ""; for (const character of clean) { const index = alphabet.indexOf(character); if (index < 0) throw new Error("Invalid two-factor secret."); bits += index.toString(2).padStart(5, "0"); }
  const bytes: number[] = []; for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}

function validTotp(secret: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secret);
  for (const drift of [-1, 0, 1]) {
    const counter = BigInt(Math.floor(now / 30_000) + drift);
    const message = Buffer.alloc(8); message.writeBigUInt64BE(counter);
    const digest = createHmac("sha1", key).update(message).digest();
    const offset = digest[digest.length - 1]! & 15;
    const expected = String(((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}

function twoFactorIpHash(request: Request): string {
  return hashOpaqueToken(getClientIp(request) ?? "unknown");
}

export async function createAdminTwoFactorChallenge(userId: string, request: Request): Promise<string> {
  const token = createOpaqueToken();
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`admin-2fa:${userId}`]);
    await client.query("UPDATE admin_two_factor_challenges SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [userId]);
    await client.query("INSERT INTO admin_two_factor_challenges (user_id,token_hash,expires_at,ip_hash) VALUES ($1,$2,$3,$4)", [userId, hashOpaqueToken(token), addHours(1 / 12), twoFactorIpHash(request)]);
    await client.query("COMMIT");
    return token;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function verifyAdminTwoFactorChallenge(challengeToken: string, code: string, request: Request) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const challenge = (await client.query(`SELECT c.id,c.user_id AS "userId",f.secret_ciphertext AS "secretCiphertext",f.recovery_code_hashes AS "recoveryCodeHashes",u.email
      FROM admin_two_factor_challenges c JOIN admin_two_factor f ON f.user_id=c.user_id AND f.status='enabled' JOIN users u ON u.id=c.user_id AND u.status='active'
      WHERE c.token_hash=$1 AND c.used_at IS NULL AND c.expires_at>now() AND c.ip_hash=$2 AND c.attempts<5
        AND EXISTS (SELECT 1 FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id AND r.active=true WHERE ur.user_id=c.user_id)
      FOR UPDATE`, [hashOpaqueToken(challengeToken), twoFactorIpHash(request)])).rows[0];
    if (!challenge) throw new AppError(400, "INVALID_TWO_FACTOR_CHALLENGE", "The two-factor challenge is invalid or expired.");
    let verified = false;
    try { verified = validTotp(decryptTwoFactorSecret(challenge.secretCiphertext), code); } catch { verified = false; }
    const recoveryCodes = Array.isArray(challenge.recoveryCodeHashes) ? challenge.recoveryCodeHashes.filter((value: unknown) => typeof value === "string") : [];
    const recoveryHash = hashOpaqueToken(code);
    const recoveryIndex = recoveryCodes.findIndex((value: string) => value.length === recoveryHash.length && timingSafeEqual(Buffer.from(value), Buffer.from(recoveryHash)));
    verified ||= recoveryIndex >= 0;
    if (!verified) {
      await client.query("UPDATE admin_two_factor_challenges SET attempts=attempts+1 WHERE id=$1", [challenge.id]);
      await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,ip_address,user_agent) VALUES ($1,'admin.two_factor_failed','authentication',$1,$2,$3)", [challenge.userId, getClientIp(request), request.get("user-agent") ?? null]);
      await client.query("COMMIT");
      throw new AppError(401, "INVALID_TWO_FACTOR_CODE", "The two-factor code is invalid.");
    }
    await client.query("UPDATE admin_two_factor_challenges SET used_at=now() WHERE id=$1", [challenge.id]);
    if (recoveryIndex >= 0) { recoveryCodes.splice(recoveryIndex, 1); await client.query("UPDATE admin_two_factor SET recovery_code_hashes=$1,updated_at=now() WHERE user_id=$2", [JSON.stringify(recoveryCodes), challenge.userId]); }
    const sessionToken = createOpaqueToken(), csrfToken = createOpaqueToken(), now = new Date();
    const session = (await client.query(`INSERT INTO auth_sessions (user_id,type,session_token_hash,csrf_token_hash,expires_at,last_seen_at,ip_address,user_agent)
      VALUES ($1,'admin',$2,$3,$4,$5,$6,$7) RETURNING id,expires_at AS "expiresAt"`, [challenge.userId, hashOpaqueToken(sessionToken), hashOpaqueToken(csrfToken), addDays(30), now, getClientIp(request), request.get("user-agent") ?? null])).rows[0];
    await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,ip_address,user_agent) VALUES ($1,'admin.login','authentication',$1,$2,$3)", [challenge.userId, getClientIp(request), request.get("user-agent") ?? null]);
    await emitNotification({ type: "security.admin_login", idempotencyKey: `admin-login:${session.id}`, userId: challenge.userId, email: challenge.email, message: "An administrator session was created for your account. If this was not you, contact support immediately." }, client);
    await client.query("COMMIT");
    return { userId: challenge.userId, sessionToken, csrfToken, expiresAt: session.expiresAt };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function isAdminUser(userId: string): Promise<boolean> {
  const [role] = await getDatabase()
    .select({ id: adminRoles.id })
    .from(adminUserRoles)
    .innerJoin(adminRoles, eq(adminRoles.id, adminUserRoles.roleId))
    .where(and(eq(adminUserRoles.userId, userId), eq(adminRoles.active, true)))
    .limit(1);
  return Boolean(role);
}

export async function auditSecurityEvent(input: {
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  request: Request;
}): Promise<void> {
  await getDatabase().insert(auditLogs).values({
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    oldValuesJson: input.oldValues,
    newValuesJson: input.newValues,
    ipAddress: getClientIp(input.request),
    userAgent: input.request.get("user-agent") ?? null,
  });
}