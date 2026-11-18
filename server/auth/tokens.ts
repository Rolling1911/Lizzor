import { createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required for authentication.");
  }
  return createHmac("sha256", env.SESSION_SECRET).update(token).digest("hex");
}

export function addHours(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export function addDays(days: number): Date {
  return addHours(days * 24);
}