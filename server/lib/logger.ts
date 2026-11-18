import { env } from "../config/env.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type LogContext = Record<string, unknown>;

const requestContext = new AsyncLocalStorage<LogContext>();
const sensitiveKey = /(?:authorization|bearer|token|secret|password|session|cookie|email|phone|address|customer|payment|card|iban|cost(?:price)?|margin|profit|revenue|amount|total|subtotal|vat)/i;
const tokenInText = /(\b(?:bearer|basic)\s+)[^\s,;]+|([?&](?:token|key|secret|signature|password|session)=[^&\s]+)/gi;
const credentialsInUrl = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi;
const emailInText = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const levels: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function redact(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value
    .replace(tokenInText, (_match, credential, parameter) => credential ? `${credential}[REDACTED]` : `${parameter.split("=")[0]}=[REDACTED]`)
    .replace(credentialsInUrl, "$1[REDACTED]@")
    .replace(emailInText, "[REDACTED_EMAIL]");
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.map((item) => redact(item, undefined, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey, seen)]));
  }
  return value;
}

export function withLogContext<T>(context: LogContext, callback: () => T): T {
  return requestContext.run(context, callback);
}

function write(level: string, message: string, context?: LogContext): void {
  if (levels[level] < levels[env.LOG_LEVEL]) return;
  const payload = redact({ timestamp: new Date().toISOString(), level, message, ...requestContext.getStore(), ...context });
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](JSON.stringify(payload));
}

export const logger = {
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context),
  debug: (message: string, context?: LogContext) => {
    if (env.LOG_LEVEL === "debug") write("debug", message, context);
  },
};