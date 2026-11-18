import type { Request } from "express";

export interface AuthContext {
  userId: string;
  sessionId: string;
  type: "customer" | "admin";
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function getClientIp(request: Request): string | null {
  return request.ip ?? null;
}