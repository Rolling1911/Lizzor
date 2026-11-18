import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "lizzor_session";
export const CSRF_COOKIE = "lizzor_csrf";
export const GUEST_CART_COOKIE = "lizzor_guest_cart";

function parseCookies(request: Request): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (!key || !value.length) continue;
    try { parsed[key] = decodeURIComponent(value.join("=")); } catch { /* Ignore malformed cookies. */ }
  }
  return parsed;
}

function serializeCookie(name: string, value: string, options: { httpOnly?: boolean; maxAge?: number }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function getCookie(request: Request, name: string): string | undefined {
  return parseCookies(request)[name];
}

export function setSessionCookies(response: Response, sessionToken: string, csrfToken: string, maxAgeSeconds: number): void {
  response.appendHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, sessionToken, { httpOnly: true, maxAge: maxAgeSeconds }));
  response.appendHeader("Set-Cookie", serializeCookie(CSRF_COOKIE, csrfToken, { maxAge: maxAgeSeconds }));
}

export function clearSessionCookies(response: Response): void {
  response.appendHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0 }));
  response.appendHeader("Set-Cookie", serializeCookie(CSRF_COOKIE, "", { maxAge: 0 }));
}

export function ensureCsrfCookie(request: Request, response: Response): void {
  if (!getCookie(request, CSRF_COOKIE)) {
    response.appendHeader("Set-Cookie", serializeCookie(CSRF_COOKIE, randomToken(), { maxAge: 60 * 60 * 24 }));
  }
}

export function setGuestCartCookie(response: Response, token: string, maxAgeSeconds = 60 * 60 * 24 * 180): void {
  response.appendHeader("Set-Cookie", serializeCookie(GUEST_CART_COOKIE, token, { httpOnly: true, maxAge: maxAgeSeconds }));
}

export function clearGuestCartCookie(response: Response): void {
  response.appendHeader("Set-Cookie", serializeCookie(GUEST_CART_COOKIE, "", { httpOnly: true, maxAge: 0 }));
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}