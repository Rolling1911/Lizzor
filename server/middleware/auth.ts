import type { NextFunction, Request, Response } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { AppError } from "./error-handler.js";
import { getDatabase } from "../db/client.js";
import { adminPermissions, adminRolePermissions, adminRoles, adminUserRoles, authSessions, users } from "../db/schema.js";
import { getCookie } from "../auth/cookies.js";
import { hashOpaqueToken } from "../auth/tokens.js";
import type { AuthContext } from "../auth/types.js";

export async function loadAuth(request: Request): Promise<AuthContext | undefined> {
  const token = getCookie(request, "lizzor_session");
  if (!token) return undefined;

  const [session] = await getDatabase()
    .select({ sessionId: authSessions.id, userId: authSessions.userId, type: authSessions.type })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.sessionTokenHash, hashOpaqueToken(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
        eq(users.status, "active"),
      ),
    )
    .limit(1);

  if (!session) return undefined;
  await getDatabase().update(authSessions).set({ lastSeenAt: new Date() }).where(eq(authSessions.id, session.sessionId));
  return session;
}

export async function authMiddleware(request: Request, _response: Response, next: NextFunction): Promise<void> {
  request.auth = await loadAuth(request);
  next();
}

export function requireAuth(request: Request, _response: Response, next: NextFunction): void {
  if (!request.auth) {
    next(new AppError(401, "AUTH_REQUIRED", "Please sign in to continue."));
    return;
  }
  next();
}

export async function requireAdmin(request: Request, _response: Response, next: NextFunction): Promise<void> {
  if (!request.auth || request.auth.type !== "admin") {
    next(new AppError(403, "ADMIN_REQUIRED", "You do not have access to this area."));
    return;
  }
  const [activeRole] = await getDatabase()
    .select({ id: adminRoles.id })
    .from(adminUserRoles)
    .innerJoin(adminRoles, eq(adminRoles.id, adminUserRoles.roleId))
    .where(and(eq(adminUserRoles.userId, request.auth.userId), eq(adminRoles.active, true)))
    .limit(1);
  if (!activeRole) {
    next(new AppError(403, "ADMIN_REQUIRED", "You do not have access to this area."));
    return;
  }
  next();
}

export function requirePermission(permissionKey: string) {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    if (!request.auth || request.auth.type !== "admin") {
      next(new AppError(403, "ADMIN_REQUIRED", "You do not have access to this area."));
      return;
    }

    const [permission] = await getDatabase()
      .select({ id: adminPermissions.id })
      .from(adminUserRoles)
      .innerJoin(adminRoles, eq(adminRoles.id, adminUserRoles.roleId))
      .innerJoin(adminRolePermissions, eq(adminRolePermissions.roleId, adminRoles.id))
      .innerJoin(adminPermissions, eq(adminPermissions.id, adminRolePermissions.permissionId))
      .where(
        and(
          eq(adminUserRoles.userId, request.auth.userId),
          eq(adminRoles.active, true),
          eq(adminPermissions.permissionKey, permissionKey),
        ),
      )
      .limit(1);

    if (!permission) {
      next(new AppError(403, "PERMISSION_REQUIRED", "You do not have permission to perform this action."));
      return;
    }
    next();
  };
}

export async function isActiveSuperAdmin(userId: string): Promise<boolean> {
  const [role] = await getDatabase()
    .select({ id: adminRoles.id })
    .from(adminUserRoles)
    .innerJoin(adminRoles, eq(adminRoles.id, adminUserRoles.roleId))
    .where(and(eq(adminUserRoles.userId, userId), eq(adminRoles.active, true), eq(adminRoles.systemKey, "super_admin")))
    .limit(1);
  return Boolean(role);
}

export async function requireSuperAdmin(request: Request, _response: Response, next: NextFunction): Promise<void> {
  if (!request.auth || request.auth.type !== "admin" || !(await isActiveSuperAdmin(request.auth.userId))) {
    next(new AppError(403, "SUPER_ADMIN_REQUIRED", "Only an active Super Admin may grant or change administrative authority."));
    return;
  }
  next();
}

export async function requireCsrf(request: Request, _response: Response, next: NextFunction): Promise<void> {
  const cookieToken = getCookie(request, "lizzor_csrf");
  const headerToken = request.get("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    next(new AppError(403, "CSRF_REQUIRED", "The security token is missing or invalid."));
    return;
  }
  if (request.auth) {
    const [session] = await getDatabase()
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.id, request.auth.sessionId), eq(authSessions.csrfTokenHash, hashOpaqueToken(headerToken))))
      .limit(1);
    if (!session) {
      next(new AppError(403, "CSRF_REQUIRED", "The security token is missing or invalid."));
      return;
    }
  }
  next();
}