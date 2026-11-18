import { z } from "zod";

export function parseExplicitEnabledFlag(value: unknown): boolean {
  return value === "true";
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  DATABASE_URL: z.string().url().optional().or(z.literal("")),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(50).default(10),
  SESSION_SECRET: z.string().min(1).optional(),
  APP_ORIGIN: z.string().url().optional(),
  TRUSTED_HOSTS: z.string().trim().optional().or(z.literal("")),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
  LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  CHECKOUT_RESERVATION_MINUTES: z.coerce.number().int().positive().max(1440).default(30),
  PAYMENT_RECOVERY_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  PAYMENT_RECOVERY_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(100),
  PAYMENT_RECOVERY_MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(5),
  FX_CACHE_TTL_HOURS: z.coerce.number().finite().min(0.01).max(24).default(6),
  FX_OBSERVATION_MAX_AGE_HOURS: z.coerce.number().finite().min(24).max(168).default(120),
  FX_HTTP_TIMEOUT_MS: z.coerce.number().int().min(5000).max(10000).default(8000),
  FX_HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(3),
  PAYMENT_PROVIDER: z.enum(["stripe", "fake"]).default("stripe"),
  STRIPE_SECRET_KEY: z.string().optional().or(z.literal("")),
  STRIPE_PUBLISHABLE_KEY: z.string().regex(/^pk_(?:test|live)_/, "STRIPE_PUBLISHABLE_KEY must be a Stripe publishable key.").optional().or(z.literal("")),
  STRIPE_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
  STRIPE_API_VERSION: z.string().min(1).default("2025-06-30.basil"),
  RESEND_API_KEY: z.string().optional().or(z.literal("")),
  RESEND_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
  CATALOG_MEDIA_DIR: z.string().trim().optional().or(z.literal("")),
  // Toonies credentials are read only by the server-side supplier adapter.
  // They are intentionally not persisted in supplier/catalogue tables.
  TOONIES_APP_KEY: z.string().trim().optional().or(z.literal("")),
  TOONIES_APP_SECRET: z.string().optional().or(z.literal("")),
  app_key: z.string().trim().optional().or(z.literal("")),
  app_secret: z.string().optional().or(z.literal("")),
  TOONIES_ORDER_BOUND_PROCUREMENT_ENABLED: z.unknown().optional().transform(parseExplicitEnabledFlag),
  // Stage 3 is an independent financial kill switch and is intentionally
  // disabled unless the value is exactly the string "true".
  TOONIES_ORDER_SETTLEMENT_ENABLED: z.unknown().optional().transform(parseExplicitEnabledFlag),
}).superRefine((value, context) => {
  if (value.NODE_ENV === "production") {
    if (!value.SESSION_SECRET || value.SESSION_SECRET.length < 32) {
      context.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET must be at least 32 characters in production.",
      });
    }
    if (!value.APP_ORIGIN) {
      context.addIssue({
        code: "custom",
        path: ["APP_ORIGIN"],
        message: "APP_ORIGIN is required in production for canonical and sitemap URLs.",
      });
    } else {
      const origin = new URL(value.APP_ORIGIN);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
        context.addIssue({
          code: "custom",
          path: ["APP_ORIGIN"],
          message: "APP_ORIGIN must be a bare HTTPS origin in production (for example, https://shop.example.com).",
        });
      }
    }
    if (value.RESEND_API_KEY && !value.RESEND_WEBHOOK_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["RESEND_WEBHOOK_SECRET"],
        message: "RESEND_WEBHOOK_SECRET is required in production when transactional email is enabled.",
      });
    }
    for (const hostname of value.TRUSTED_HOSTS?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? []) {
      let valid = false;
      try {
        const parsedHost = new URL(`https://${hostname}`);
        valid = parsedHost.hostname === hostname.toLowerCase()
          && parsedHost.port === ""
          && parsedHost.pathname === "/"
          && !hostname.includes("*")
          && !hostname.includes("@");
      } catch {
        valid = false;
      }
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["TRUSTED_HOSTS"],
          message: "TRUSTED_HOSTS must contain only comma-separated exact hostnames without schemes, ports, paths, credentials, or wildcards.",
        });
        break;
      }
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const databaseConfigured = Boolean(env.DATABASE_URL);
