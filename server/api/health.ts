import { Router } from "express";
import type { HealthResponse, ReadinessResponse } from "../../shared/types/index.js";
import { databaseConfig, getDatabaseReadiness } from "../config/database.js";
import { env } from "../config/env.js";
import { getPaymentProvider } from "../payments/provider.js";
import { getApplicationStartupStatus, getPaymentRecoveryWorkerStatus } from "../lib/runtime-status.js";
import { emailProviderConfigured } from "../auth/email.js";
import { getMediaStorageReadiness } from "../catalog/storage.js";
import { getTooniesProcurementGateStatus, getTooniesSettlementGateStatus } from "../suppliers/toonies-procurement-gate.js";

export const healthRouter = Router();

const MEDIA_READINESS_CACHE_MS = 30_000;
let mediaReadinessCache:
  | { value: Awaited<ReturnType<typeof getMediaStorageReadiness>>; checkedAt: number }
  | undefined;
let mediaReadinessRefresh: Promise<Awaited<ReturnType<typeof getMediaStorageReadiness>>> | undefined;

async function refreshMediaStorageReadiness() {
  mediaReadinessRefresh ??= getMediaStorageReadiness()
    .then((value) => {
      mediaReadinessCache = { value, checkedAt: Date.now() };
      return value;
    })
    .finally(() => {
      mediaReadinessRefresh = undefined;
    });
  return mediaReadinessRefresh;
}

async function getPromptMediaStorageReadiness(forceRefresh: boolean) {
  if (forceRefresh || !mediaReadinessCache) {
    return refreshMediaStorageReadiness();
  }
  if (Date.now() - mediaReadinessCache.checkedAt >= MEDIA_READINESS_CACHE_MS) {
    // Keep probes prompt after startup. The validated last result remains
    // authoritative while a stale-while-revalidate refresh runs.
    void refreshMediaStorageReadiness();
  }
  return mediaReadinessCache.value;
}

export async function getOperationalReadiness(options: { forceMediaStorageRefresh?: boolean } = {}) {
  const database = await getDatabaseReadiness();
  const mediaStorage = await getPromptMediaStorageReadiness(options.forceMediaStorageRefresh === true);
  const paymentProvider: "configured" | "not_configured" = getPaymentProvider().configured ? "configured" : "not_configured";
  const paymentFrontend: "configured" | "not_configured" = env.STRIPE_PUBLISHABLE_KEY ? "configured" : "not_configured";
  const paymentWebhook: "configured" | "not_configured" = env.STRIPE_WEBHOOK_SECRET ? "configured" : "not_configured";
  const notificationProvider: "development_only" | "not_configured" | "configured" = env.NODE_ENV === "production"
    ? emailProviderConfigured ? "configured" : "not_configured"
    : "development_only";
  const sessionSecret: "configured" | "not_configured" = env.SESSION_SECRET ? "configured" : "not_configured";
  const recoveryWorker = getPaymentRecoveryWorkerStatus();
  const tooniesProcurement = await getTooniesProcurementGateStatus();
  const tooniesSettlement = await getTooniesSettlementGateStatus();
  // These report configuration/state only; readiness never asserts a remote
  // provider is reachable. Local development intentionally does not require
  // production providers or a started background worker.
  const productionRequirementsMet = env.NODE_ENV !== "production" || (
    paymentProvider === "configured"
    && paymentFrontend === "configured"
    && paymentWebhook === "configured"
    && notificationProvider === "configured"
    && mediaStorage === "configured"
    && sessionSecret === "configured"
    && !["not_started", "failed", "disabled"].includes(recoveryWorker.state)
  );
  return {
    ready: database === "connected" && productionRequirementsMet,
    checks: {
      database,
      paymentProvider,
      paymentFrontend,
      paymentWebhook,
      notificationProvider,
      mediaStorage,
      sessionSecret,
      recoveryWorker: recoveryWorker.state,
      tooniesProcurementConfigured: tooniesProcurement.configured,
      tooniesDatabaseAttestation: tooniesProcurement.databaseAttestation,
      tooniesProcurementEffective: tooniesProcurement.effective,
      tooniesSettlementConfigured: tooniesSettlement.configured,
      tooniesSettlementDatabaseAttestation: tooniesSettlement.databaseAttestation,
      tooniesSettlementEffective: tooniesSettlement.effective,
    },
    recoveryWorker,
      tooniesProcurement,
      tooniesSettlementConfigured: tooniesSettlement.configured,
      tooniesSettlementEffective: tooniesSettlement.effective,
  };
}

healthRouter.get("/health", (_req, res) => {
  const response: HealthResponse = {
    status: "ok",
    service: "lizzor-api",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  };
  res.json({ data: response });
});

healthRouter.get("/readiness", async (_req, res) => {
  const startup = getApplicationStartupStatus();
  const operational = await getOperationalReadiness();
  const response: ReadinessResponse = {
    status: startup.state === "ready" && operational.ready ? "ready" : "degraded",
    checks: {
      api: "ok",
      startup: startup.state,
      ...operational.checks,
    },
  };
  res.status(response.status === "ready" ? 200 : 503).json({
    data: response,
    meta: {
      databaseProvider: databaseConfig.provider,
      recoveryWorker: operational.recoveryWorker,
      startup: {
        state: startup.state,
        startedAt: startup.startedAt,
        readyAt: startup.readyAt,
      },
    },
  });
});