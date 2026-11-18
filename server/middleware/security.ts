import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import type { RequestHandler } from "express";
import { getClientIp } from "../auth/types.js";
import { env } from "../config/env.js";

const productionHostnames = new Set([
  ...(env.APP_ORIGIN ? [new URL(env.APP_ORIGIN).hostname.toLowerCase()] : []),
  ...(env.TRUSTED_HOSTS?.split(",").map((hostname) => hostname.trim().toLowerCase()).filter(Boolean) ?? []),
]);

// Replit terminates TLS at its local reverse proxy. Trust only loopback rather
// than accepting forwarding headers from an arbitrary internet client.
export const replitProxyTrust = "loopback";

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1"
    || address === "::1"
    || Boolean(address?.startsWith("::ffff:127."));
}

function isInternalRootHealthcheck(request: Parameters<RequestHandler>[0], hostname: string): boolean {
  return (request.method === "GET" || request.method === "HEAD")
    && request.path === "/"
    && (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost")
    && isLoopbackAddress(request.socket.remoteAddress);
}

export const productionHostProtection: RequestHandler = (request, response, next) => {
  const hostname = request.hostname.toLowerCase().replace(/\.$/, "");
  if (
    env.NODE_ENV !== "production"
    || productionHostnames.has(hostname)
    || isInternalRootHealthcheck(request, hostname)
  ) {
    next();
    return;
  }
  response.status(421).json({ error: { code: "UNTRUSTED_HOST", message: "The request host is not accepted." } });
};

function guestRouteFamily(path: string): string {
  if (/^\/guest\/orders\/[^/]+\/payments$/.test(path)) return "order-payments";
  if (/^\/guest\/orders\/[^/]+\/tracking$/.test(path)) return "order-tracking";
  if (/^\/guest\/orders\/[^/]+\/returns$/.test(path)) return "order-returns";
  if (/^\/guest\/orders\/[^/]+\/cancel$/.test(path)) return "order-cancel";
  return "order-detail";
}

export const guestBearerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 100 : 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (request) => `${getClientIp(request)}:${request.method}:${guestRouteFamily(request.path)}`,
  message: { error: { code: "GUEST_ACCESS_RATE_LIMITED", message: "Too many guest access attempts. Please try again later." } },
});

export const securityMiddleware = [
  helmet({
    contentSecurityPolicy: false,
  }),
  cors({
    origin: false,
    credentials: true,
  }),
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    skip: (request) => !request.path.startsWith("/api/"),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please try again shortly.",
      },
    },
  }),
];