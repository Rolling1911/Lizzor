import { Router } from "express";
import rateLimit from "express-rate-limit";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { clearGuestCartCookie, clearSessionCookies, getCookie, GUEST_CART_COOKIE, setSessionCookies } from "../auth/cookies.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  auditSecurityEvent,
  createEmailVerificationToken,
  createPasswordResetToken,
  createSession,
  createAdminTwoFactorChallenge,
  findUserByEmail,
  getPublicUser,
  getUserById,
  isAdminUser,
  listUserPermissions,
  revokeSession,
  verifyAdminTwoFactorChallenge,
} from "../auth/service.js";
import { hashOpaqueToken } from "../auth/tokens.js";
import { getDatabase, getDatabasePool } from "../db/client.js";
import {
  companies,
  companyUsers,
  adminTwoFactor,
  emailVerificationTokens,
  passwordResetTokens,
  authSessions,
  legalPolicyAcceptances,
  users,
} from "../db/schema.js";
import { AppError } from "../middleware/error-handler.js";
import { isActiveSuperAdmin, requireAdmin, requireAuth, requireCsrf, requirePermission } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { env } from "../config/env.js";
import { emitNotification } from "../notifications/service.js";
import { getCart } from "../cart/service.js";
import { getEuropeanCountry } from "../../shared/europeanCountries.js";
import { assertLegalAcceptance, legalRequirements } from "../legal/requirements.js";

function legalRequirementsInTransaction(tx: any) {
  const queryable = {
    query: async (text: string) => {
      const result = await tx.execute(sql.raw(text));
      return { rows: result.rows as any[] };
    },
  };
  return (async () => {
    await queryable.query("SELECT pg_advisory_xact_lock(hashtext('businessLegalProfile'))");
    return legalRequirements(queryable);
  })();
}

const nameField = z.string().trim().min(1).max(100);
const registrationPhoneField = z.string().trim().min(1, "Phone is required.").max(50, "Phone number is too long.");
const emailField = z.string().trim().email().max(320).transform((value) => value.toLowerCase());
const passwordField = z.string().min(12).max(128)
  .regex(/[a-z]/, "Password must include a lowercase letter.")
  .regex(/[A-Z]/, "Password must include an uppercase letter.")
  .regex(/[0-9]/, "Password must include a number.");

const personalRegistrationSchema = z.object({
  firstName: nameField,
  lastName: nameField,
  email: emailField,
  phone: registrationPhoneField,
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()).refine((value) => Boolean(getEuropeanCountry(value)), "Select a supported European country."),
  password: passwordField,
  confirmPassword: z.string(),
  legalAcceptance: z.array(z.string().uuid()).max(2).optional(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match.",
  path: ["confirmPassword"],
});

const businessRegistrationSchema = personalRegistrationSchema.and(z.object({
  companyName: z.string().trim().min(1).max(200),
  vatNumber: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(3).max(50).optional(),
  ),
  registrationNumber: z.string().trim().max(100).optional(),
  contactPerson: z.string().trim().min(1).max(200),
  companyEmail: emailField,
  companyPhone: z.string().trim().min(3).max(50),
}));

const loginSchema = z.object({ email: emailField, password: z.string().min(1).max(128) });
const twoFactorVerificationSchema = z.object({ challengeToken: z.string().min(32).max(256), code: z.string().trim().min(6).max(128) });
const tokenSchema = z.object({ token: z.string().min(32).max(256) });
const resetSchema = tokenSchema.extend({ password: passwordField, confirmPassword: z.string() })
  .refine((data) => data.password === data.confirmPassword, { message: "Passwords do not match.", path: ["confirmPassword"] });
const profileSchema = z.object({
  firstName: nameField,
  lastName: nameField,
  phone: z.string().trim().min(3).max(50).nullable().optional(),
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 100 : 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "AUTH_RATE_LIMITED", message: "Too many attempts. Please try again later." } },
});

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function normalizeRegistrationPhone(value: string, countryCode: string, fieldLabel = "Phone"): string {
  const country = getEuropeanCountry(countryCode);
  if (!country) throw new AppError(400, "UNSUPPORTED_PHONE_COUNTRY", `${fieldLabel} must use a supported European country.`);
  const raw = value.trim();
  if (!raw) throw new AppError(400, "PHONE_REQUIRED", `${fieldLabel} is required.`);
  if (!/^\+?[\d\s().-]+$/.test(raw)) {
    throw new AppError(400, "INVALID_PHONE", `${fieldLabel} contains invalid characters.`);
  }
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) {
    throw new AppError(400, "INVALID_PHONE", `${fieldLabel} must contain a valid international phone number.`);
  }
  const hasInternationalPrefix = raw.startsWith("+");
  if (hasInternationalPrefix && !digits.startsWith(country.dialingCode)) {
    throw new AppError(400, "PHONE_COUNTRY_MISMATCH", `${fieldLabel} prefix does not match the selected country.`);
  }
  const localDigits = hasInternationalPrefix ? digits.slice(country.dialingCode.length) : digits;
  if (hasInternationalPrefix && localDigits.startsWith(country.dialingCode)) {
    throw new AppError(400, "DUPLICATE_PHONE_PREFIX", `${fieldLabel} must not include the country prefix twice.`);
  }
  if (localDigits.length < 6 || localDigits.length + country.dialingCode.length > 15) {
    throw new AppError(400, "INVALID_PHONE", `${fieldLabel} must contain a valid international phone number.`);
  }
  return `+${country.dialingCode}${localDigits}`;
}

async function sendVerification(userId: string, email: string): Promise<void> {
  await createEmailVerificationToken(userId, email);
}

async function claimGuestCart(
  request: Parameters<typeof getCookie>[0],
  response: Parameters<typeof clearGuestCartCookie>[0],
  userId: string,
): Promise<void> {
  const guestSessionId = getCookie(request, GUEST_CART_COOKIE);
  if (guestSessionId) {
    await getCart({ userId, guestSessionId });
    clearGuestCartCookie(response);
  }
}

export const authRouter = Router();

authRouter.post("/auth/register", authLimiter, requireCsrf, validateBody(personalRegistrationSchema), async (req, res) => {
  const input = req.body as z.infer<typeof personalRegistrationSchema>;
  try {
    const passwordHash = await hashPassword(input.password);
    const user = await getDatabase().transaction(async (tx) => {
      const requirements = await legalRequirementsInTransaction(tx);
      const accepted = assertLegalAcceptance(requirements, "account", input.legalAcceptance);
      const [created] = await tx.insert(users).values({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: normalizeRegistrationPhone(input.phone, input.countryCode),
      countryCode: input.countryCode,
      accountType: "personal",
      status: "active",
      }).returning();
      if (!created) throw new Error("Registration failed.");
      if (accepted.length) await tx.insert(legalPolicyAcceptances).values(accepted.map((item) => ({ versionId: item.versionId, userId: created.id, source: "registration", scope: "account" })));
      return created;
    });
    if (!user) throw new Error("Registration failed.");
    await sendVerification(user.id, user.email);
    await emitNotification({ type: "account.created", idempotencyKey: `account.created:${user.id}`, userId: user.id,
      message: "Your Lizzor account is ready. You can now manage orders, saved items, and account details in one place.", metadata: { path: "/account" } });
    const session = await createSession(user.id, "customer", req);
    await claimGuestCart(req, res, user.id);
    setSessionCookies(res, session.sessionToken, session.csrfToken, 30 * 24 * 60 * 60);
    res.status(201).json({ data: { user: await getPublicUser(user.id) } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "EMAIL_IN_USE", "An account with this email already exists.");
    throw error;
  }
});

authRouter.post("/auth/register/business", authLimiter, requireCsrf, validateBody(businessRegistrationSchema), async (req, res) => {
  const input = req.body as z.infer<typeof businessRegistrationSchema>;
  try {
    const passwordHash = await hashPassword(input.password);
    const user = await getDatabase().transaction(async (tx) => {
       const requirements = await legalRequirementsInTransaction(tx);
       const accepted = assertLegalAcceptance(requirements, "account", input.legalAcceptance);
      const [createdUser] = await tx.insert(users).values({
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: normalizeRegistrationPhone(input.phone, input.countryCode),
        countryCode: input.countryCode,
        accountType: "business",
        status: "active",
      }).returning();
      if (!createdUser) throw new Error("Business registration failed.");
      const [company] = await tx.insert(companies).values({
        companyName: input.companyName,
        vatNumber: input.vatNumber ?? null,
        registrationNumber: input.registrationNumber,
        contactPerson: input.contactPerson,
        email: input.companyEmail,
        phone: normalizeRegistrationPhone(input.companyPhone, input.countryCode, "Company phone"),
        countryCode: input.countryCode,
      }).returning();
      if (!company) throw new Error("Company creation failed.");
      await tx.insert(companyUsers).values({ userId: createdUser.id, companyId: company.id, companyRole: "owner", role: "owner" });
      await tx.update(users).set({ activeCompanyId: company.id, updatedAt: new Date() }).where(eq(users.id, createdUser.id));
       if (accepted.length) await tx.insert(legalPolicyAcceptances).values(accepted.map((item) => ({ versionId: item.versionId, userId: createdUser.id, companyId: company.id, source: "registration", scope: "account" })));
      return { ...createdUser, activeCompanyId: company.id };
    });
    await sendVerification(user.id, user.email);
    await emitNotification({ type: "account.created", idempotencyKey: `account.created:${user.id}`, userId: user.id,
      message: "Your Lizzor business account is ready. You can now manage company purchasing, orders, and team access.", metadata: { path: "/account" } });
    const session = await createSession(user.id, "customer", req);
    await claimGuestCart(req, res, user.id);
    setSessionCookies(res, session.sessionToken, session.csrfToken, 30 * 24 * 60 * 60);
    res.status(201).json({ data: { user: await getPublicUser(user.id) } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "REGISTRATION_CONFLICT", "The email or VAT number is already registered.");
    throw error;
  }
});

authRouter.post("/auth/login", authLimiter, requireCsrf, validateBody(loginSchema), async (req, res) => {
  const input = req.body as z.infer<typeof loginSchema>;
  const user = await findUserByEmail(input.email);
  const valid = Boolean(user?.passwordHash && user.status === "active" && await verifyPassword(input.password, user.passwordHash));
  if (!user || !valid) throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  const session = await createSession(user.id, "customer", req);
  // Claim the browser's guest cart before completing sign-in. getCart's
  // transactional claim is idempotent, so retries and concurrent requests
  // cannot duplicate guest quantities.
  await claimGuestCart(req, res, user.id);
  setSessionCookies(res, session.sessionToken, session.csrfToken, 30 * 24 * 60 * 60);
  res.json({ data: { user: await getPublicUser(user.id) } });
});

authRouter.post("/auth/admin/login", authLimiter, requireCsrf, validateBody(loginSchema), async (req, res) => {
  const input = req.body as z.infer<typeof loginSchema>;
  const user = await findUserByEmail(input.email);
  const valid = Boolean(user?.passwordHash && user.status === "active" && user.emailVerifiedAt && await verifyPassword(input.password, user.passwordHash));
  if (!user || !valid || !await isAdminUser(user.id)) {
    await auditSecurityEvent({ action: "admin.login_failed", entityType: "authentication", request: req });
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }
  const [twoFactor] = await getDatabase().select({ status: adminTwoFactor.status }).from(adminTwoFactor)
    .where(eq(adminTwoFactor.userId, user.id)).limit(1);
  if (twoFactor?.status === "enabled") {
    const challengeToken = await createAdminTwoFactorChallenge(user.id, req);
    await auditSecurityEvent({ actorUserId: user.id, action: "admin.two_factor_challenge_issued", entityType: "authentication", entityId: user.id, request: req });
    throw new AppError(403, "TWO_FACTOR_CHALLENGE_REQUIRED", "Two-factor verification is required.", { challengeToken });
  }
  const session = await createSession(user.id, "admin", req, user.email);
  setSessionCookies(res, session.sessionToken, session.csrfToken, 30 * 24 * 60 * 60);
  await auditSecurityEvent({ actorUserId: user.id, action: "admin.login", entityType: "authentication", entityId: user.id, request: req });
  res.json({ data: { user: await getPublicUser(user.id), permissions: await listUserPermissions(user.id), isSuperAdmin: await isActiveSuperAdmin(user.id) } });
});

authRouter.post("/auth/admin/login/verify-2fa", authLimiter, requireCsrf, validateBody(twoFactorVerificationSchema), async (req, res) => {
  const input = req.body as z.infer<typeof twoFactorVerificationSchema>;
  const result = await verifyAdminTwoFactorChallenge(input.challengeToken, input.code, req);
  setSessionCookies(res, result.sessionToken, result.csrfToken, 30 * 24 * 60 * 60);
  res.json({ data: { user: await getPublicUser(result.userId), permissions: await listUserPermissions(result.userId), isSuperAdmin: await isActiveSuperAdmin(result.userId) } });
});

authRouter.post("/auth/logout", requireCsrf, requireAuth, async (req, res) => {
  await revokeSession(req.auth!.sessionId);
  clearSessionCookies(res);
  res.status(204).end();
});

authRouter.get("/auth/me", async (req, res) => {
  if (!req.auth) {
    res.json({ data: { user: null, sessionType: null, permissions: [], isSuperAdmin: false } });
    return;
  }
  res.json({
    data: {
      user: await getPublicUser(req.auth.userId),
      sessionType: req.auth.type,
      permissions: req.auth.type === "admin" ? await listUserPermissions(req.auth.userId) : [],
      isSuperAdmin: req.auth.type === "admin" ? await isActiveSuperAdmin(req.auth.userId) : false,
    },
  });
});

authRouter.post("/auth/verify-email", authLimiter, requireCsrf, validateBody(tokenSchema), async (req, res) => {
  const tokenHash = hashOpaqueToken((req.body as z.infer<typeof tokenSchema>).token);
  const record = await getDatabase().transaction(async (tx) => {
    const [claimed] = await tx.update(emailVerificationTokens).set({ usedAt: new Date() }).where(
      and(eq(emailVerificationTokens.tokenHash, tokenHash), isNull(emailVerificationTokens.usedAt), gt(emailVerificationTokens.expiresAt, new Date())),
    ).returning();
    if (claimed) {
      await tx.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, claimed.userId));
      return { verified: true, alreadyVerified: false };
    }
    const [completed] = await tx.select({ tokenId: emailVerificationTokens.id })
      .from(emailVerificationTokens)
      .innerJoin(users, eq(users.id, emailVerificationTokens.userId))
      .where(and(
        eq(emailVerificationTokens.tokenHash, tokenHash),
        isNotNull(emailVerificationTokens.usedAt),
        isNotNull(users.emailVerifiedAt),
      ))
      .limit(1);
    return completed ? { verified: true, alreadyVerified: true } : null;
  });
  if (!record) throw new AppError(400, "INVALID_VERIFICATION_TOKEN", "The verification link is invalid or expired.");
  res.json({ data: record });
});

authRouter.post("/auth/verify-email/resend", authLimiter, requireCsrf, requireAuth, async (req, res) => {
  const user = await getUserById(req.auth!.userId);
  if (user && !user.emailVerifiedAt) await sendVerification(user.id, user.email);
  res.json({ data: { message: "If verification is needed, a new message has been queued." } });
});

authRouter.post("/auth/forgot-password", authLimiter, requireCsrf, validateBody(z.object({ email: emailField })), async (req, res) => {
  const user = await findUserByEmail((req.body as { email: string }).email);
  if (user?.passwordHash && user.status === "active") {
    await createPasswordResetToken(user.id, user.email);
  }
  res.json({ data: { message: "If an account exists, password reset instructions have been queued." } });
});

authRouter.post("/auth/reset-password", authLimiter, requireCsrf, validateBody(resetSchema), async (req, res) => {
  const input = req.body as z.infer<typeof resetSchema>;
  const passwordHash = await hashPassword(input.password);
  const client=await getDatabasePool().connect();
  let record;
  try {
    await client.query("BEGIN");
    record=(await client.query(`UPDATE password_reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()
      RETURNING id,user_id AS "userId"`,[hashOpaqueToken(input.token)])).rows[0] ?? null;
    if(record){
      const userStatus=(await client.query("SELECT status FROM users WHERE id=$1 FOR UPDATE",[record.userId])).rows[0]?.status;
      await client.query("UPDATE users SET password_hash=$1,status=CASE WHEN status='pending' THEN 'active' ELSE status END,email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=$2",[passwordHash,record.userId]);
      await client.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[record.userId]);
      if(userStatus==="pending") await client.query("INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,old_values_json,new_values_json) VALUES ($1,'admin.staff_invitation_accepted','user',$1,$2,$3)",[record.userId,JSON.stringify({status:"pending"}),JSON.stringify({status:"active",emailVerified:true})]);
      await emitNotification({type:"security.password_changed",idempotencyKey:`password-changed:${record.userId}:${record.id}`,userId:record.userId,
        message:"Your password was changed. If this was not you, contact support immediately."},client);
    }
    await client.query("COMMIT");
  } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
  if (!record) throw new AppError(400, "INVALID_RESET_TOKEN", "The reset link is invalid or expired.");
  clearSessionCookies(res);
  res.json({ data: { reset: true } });
});

authRouter.get("/account/profile", requireAuth, async (req, res) => {
  res.json({ data: { user: await getPublicUser(req.auth!.userId) } });
});

authRouter.patch("/account/profile", requireCsrf, requireAuth, validateBody(profileSchema), async (req, res) => {
  const input = req.body as z.infer<typeof profileSchema>;
  await getDatabase().update(users).set({
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone ?? null,
    updatedAt: new Date(),
  }).where(eq(users.id, req.auth!.userId));
  res.json({ data: { user: await getPublicUser(req.auth!.userId) } });
});

authRouter.get("/admin/session", requireAdmin, async (req, res) => {
  res.json({ data: { user: await getPublicUser(req.auth!.userId), permissions: await listUserPermissions(req.auth!.userId) } });
});

authRouter.get("/admin/security-check", requirePermission("settings.manage"), (_req, res) => {
  res.json({ data: { authorized: true } });
});