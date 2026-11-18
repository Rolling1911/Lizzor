DROP INDEX IF EXISTS "payment_recovery_jobs_payment_operation_active_unique";
CREATE UNIQUE INDEX "payment_recovery_jobs_payment_operation_active_unique"
  ON "payment_recovery_jobs" ("payment_id", "operation")
  WHERE "payment_id" IS NOT NULL AND "operation" NOT IN ('webhook', 'refund') AND "status" IN ('pending', 'processing', 'failed');