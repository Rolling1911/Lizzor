CREATE TABLE IF NOT EXISTS "payment_recovery_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid REFERENCES "orders"("id") ON DELETE CASCADE,
  "payment_id" uuid REFERENCES "payments"("id") ON DELETE CASCADE,
  "refund_id" uuid REFERENCES "refunds"("id") ON DELETE CASCADE,
  "provider_event_id" varchar(200),
  "event_type" varchar(100),
  "operation" varchar(50) NOT NULL,
  "payload_json" jsonb,
  "retryable" boolean NOT NULL DEFAULT true,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_attempt_at" timestamptz,
  "locked_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_recovery_jobs_operation_valid" CHECK ("operation" IN ('webhook', 'payment_creation', 'payment_status', 'expiration', 'refund')),
  CONSTRAINT "payment_recovery_jobs_status_valid" CHECK ("status" IN ('pending', 'processing', 'succeeded', 'failed')),
  CONSTRAINT "payment_recovery_jobs_target_check" CHECK (num_nonnulls("payment_id", "refund_id", "order_id") >= 1)
);
CREATE INDEX IF NOT EXISTS "payment_recovery_jobs_due_idx" ON "payment_recovery_jobs" ("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "payment_recovery_jobs_payment_idx" ON "payment_recovery_jobs" ("payment_id", "status");
CREATE INDEX IF NOT EXISTS "payment_recovery_jobs_refund_idx" ON "payment_recovery_jobs" ("refund_id", "status");
CREATE INDEX IF NOT EXISTS "payment_recovery_jobs_created_idx" ON "payment_recovery_jobs" ("created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_recovery_jobs_event_unique" ON "payment_recovery_jobs" ("provider_event_id") WHERE "provider_event_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "payment_recovery_jobs_payment_operation_active_unique"
  ON "payment_recovery_jobs" ("payment_id", "operation")
  WHERE "payment_id" IS NOT NULL AND "operation" NOT IN ('webhook', 'refund') AND "status" IN ('pending', 'processing', 'failed');
CREATE UNIQUE INDEX IF NOT EXISTS "payment_recovery_jobs_refund_operation_active_unique"
  ON "payment_recovery_jobs" ("refund_id", "operation")
  WHERE "refund_id" IS NOT NULL AND "operation" = 'refund' AND "status" IN ('pending', 'processing', 'failed');