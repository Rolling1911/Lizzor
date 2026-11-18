import { databaseConfigured, env } from "./config/env.js";
import { createServer } from "node:http";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";
import { closeDatabase, withBackgroundWorkerLock } from "./db/client.js";
import { releaseExpiredReservations } from "./orders/service.js";
import { expirePaymentReservations, queueStuckPaymentRecoveries, runPaymentRecovery } from "./payments/service.js";
import { runNotificationDeliveryWorker } from "./notifications/service.js";
import {
  beginApplicationStartup,
  getPaymentRecoveryWorkerStatus,
  markApplicationReady,
  markApplicationStartupFailed,
  setPaymentRecoveryWorkerStatus,
} from "./lib/runtime-status.js";
import { runMediaCleanup } from "./catalog/media-cleanup.js";
import { repairBundledCategoryMediaReferences } from "./catalog/category-media-repair.js";
import { reconcileSuperAdminPermissions } from "./auth/permission-reconciliation.js";
import { getOperationalReadiness } from "./api/health.js";
import { reconcileLegalDocumentCatalog } from "./legal/document-reconciliation.js";
import { reconcileCanonicalCategoryReferences } from "./catalog/category-reference-reconciliation.js";
import { reconcileDuplicatePrimaryMedia } from "./catalog/media-primary-reconciliation.js";
import { reconcileStaleTooniesSyncRuns, reconcileTooniesReferenceData } from "./suppliers/toonies-reference-reconciliation.js";
import { runTooniesProcurementPollingCycle } from "./suppliers/toonies-procurement-service.js";

let paymentRecoveryRunning = false;

async function runPaymentRecoveryCycle() {
  if (paymentRecoveryRunning) {
    logger.warn("payment recovery cycle skipped because the prior cycle is still running");
    return;
  }
  paymentRecoveryRunning = true;
  try {
    const cycle = await withBackgroundWorkerLock(async () => {
      setPaymentRecoveryWorkerStatus("running");
      const [payments, orders, stalePayments] = await Promise.all([
        expirePaymentReservations(env.PAYMENT_RECOVERY_BATCH_SIZE),
        releaseExpiredReservations(env.PAYMENT_RECOVERY_BATCH_SIZE),
        queueStuckPaymentRecoveries(env.PAYMENT_RECOVERY_BATCH_SIZE),
      ]);
      const recovery = await runPaymentRecovery(env.PAYMENT_RECOVERY_BATCH_SIZE);
      const tooniesProcurement = await runTooniesProcurementPollingCycle(env.PAYMENT_RECOVERY_BATCH_SIZE);
      const notifications = await runNotificationDeliveryWorker(env.PAYMENT_RECOVERY_BATCH_SIZE);
      const mediaCleanup = await runMediaCleanup(env.PAYMENT_RECOVERY_BATCH_SIZE);
      if (payments.released || payments.finalized || payments.failed || orders.released || stalePayments.queued || recovery.claimed || tooniesProcurement.claimed || mediaCleanup.claimed) {
        logger.info("background recovery cycle completed", { payments, ordersReleased: orders.released, stalePayments, recovery, tooniesProcurement, notifications, mediaCleanup });
      }
    });
    // A replica that did not obtain the cycle lock is healthy: another
    // replica is executing the same durable, lease-backed work.
    setPaymentRecoveryWorkerStatus(cycle.acquired ? "idle" : "standby");
  } catch (error) {
    logger.error("payment recovery cycle failed", { error: error instanceof Error ? error.message : "Unknown error" });
    setPaymentRecoveryWorkerStatus("failed", error);
  } finally {
    paymentRecoveryRunning = false;
  }
}

beginApplicationStartup();
const processStartedAt = Date.now();
const server = createServer();
const app = await createApp({ enforceStartupReadiness: true, viteHmrServer: server });
server.on("request", app);
let recoveryTimer: NodeJS.Timeout | undefined;
server.listen(env.PORT, "0.0.0.0", () => {
  logger.info("Lizzor server listening", {
    port: env.PORT,
    environment: env.NODE_ENV,
    database: process.env.DATABASE_URL ? "configured" : "not configured",
    startupState: "starting",
    processUptimeMs: Date.now() - processStartedAt,
  });
  void initializeApplication();
});

async function timedStartupStep<T>(step: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  logger.info("application initialization step started", { step });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Initialization step timed out: ${step}`)),
          30_000,
        );
        timeout.unref();
      }),
    ]);
    logger.info("application initialization step completed", { step, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logger.error("application initialization step failed", {
      step,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function initializeApplication(): Promise<void> {
  const startedAt = Date.now();
  logger.info("application initialization started");
  try {
    if (databaseConfigured) {
      const permissionReconciliation = await timedStartupStep(
        "super_admin_permission_reconciliation",
        reconcileSuperAdminPermissions,
      );
      if (permissionReconciliation.permissionsAdded || permissionReconciliation.grantsAdded) {
        logger.info("reconciled canonical Super Admin permissions", { ...permissionReconciliation });
      }
      const legalDocuments = await timedStartupStep(
        "legal_document_catalog_reconciliation",
        reconcileLegalDocumentCatalog,
      );
      if (legalDocuments.documentsAdded || legalDocuments.draftsAdded) {
        logger.info("reconciled canonical legal documents", { ...legalDocuments });
      }
      const categoryReferences = await timedStartupStep(
        "canonical_category_reference_reconciliation",
        reconcileCanonicalCategoryReferences,
      );
      if (categoryReferences.inserted || categoryReferences.legacyRootsUpdated) {
        logger.info("reconciled canonical category references", { ...categoryReferences });
      }
      const tooniesReferences = await timedStartupStep(
        "toonies_reference_data_reconciliation",
        reconcileTooniesReferenceData,
      );
      if (tooniesReferences.suppliersAdded || tooniesReferences.warehousesAdded) {
        logger.info("reconciled Toonies reference data", { ...tooniesReferences });
      }
      const staleTooniesRuns = await timedStartupStep(
        "stale_toonies_sync_reconciliation",
        reconcileStaleTooniesSyncRuns,
      );
      if (staleTooniesRuns.runsAbandoned) {
        logger.info("reconciled stale Toonies synchronization runs", { ...staleTooniesRuns });
      }
      const mediaPrimaries = await timedStartupStep(
        "product_media_primary_reconciliation",
        reconcileDuplicatePrimaryMedia,
      );
      if (mediaPrimaries.updated.length) {
        logger.info("reconciled duplicate product media primary flags", {
          rowsUpdated: mediaPrimaries.updated.length,
          scopesUpdated: new Set(mediaPrimaries.updated.map((row) => `${row.productId}:${row.variantId ?? "product"}`)).size,
        });
      }
      const repairedCategoryImages = await timedStartupStep(
        "bundled_category_media_repair",
        repairBundledCategoryMediaReferences,
      );
      if (repairedCategoryImages) {
        logger.info("restored missing bundled category media references", { repairedCategoryImages });
      }
      await timedStartupStep("payment_recovery_worker", runPaymentRecoveryCycle);
      if (getPaymentRecoveryWorkerStatus().state === "failed") {
        throw new Error("The payment recovery worker failed its startup cycle.");
      }
      const operationalReadiness = await timedStartupStep(
        "operational_readiness",
        () => getOperationalReadiness({ forceMediaStorageRefresh: true }),
      );
      if (!operationalReadiness.ready) {
        throw new Error("Required production readiness checks did not pass.");
      }
      recoveryTimer = setInterval(() => void runPaymentRecoveryCycle(), env.PAYMENT_RECOVERY_INTERVAL_SECONDS * 1000);
      recoveryTimer.unref();
    } else {
      setPaymentRecoveryWorkerStatus("disabled");
    }
    markApplicationReady();
    logger.info("application initialization completed", { durationMs: Date.now() - startedAt });
  } catch (error) {
    markApplicationStartupFailed(error);
    logger.error("application initialization failed; readiness remains unavailable", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Application shutdown started", { signal });
  if (recoveryTimer) clearInterval(recoveryTimer);
  server.close(async () => {
    await closeDatabase();
    logger.info("Application shutdown completed", { signal });
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });