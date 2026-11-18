ALTER TABLE "payment_recovery_jobs" ADD COLUMN IF NOT EXISTS "retryable" boolean NOT NULL DEFAULT true;
ALTER TABLE "payment_recovery_jobs" DROP CONSTRAINT IF EXISTS "payment_recovery_jobs_operation_valid";
ALTER TABLE "payment_recovery_jobs" ADD CONSTRAINT "payment_recovery_jobs_operation_valid"
  CHECK ("operation" IN ('webhook', 'payment_creation', 'payment_status', 'expiration', 'refund'));