ALTER TABLE payment_recovery_jobs DROP CONSTRAINT IF EXISTS payment_recovery_jobs_operation_valid;
--> statement-breakpoint
ALTER TABLE payment_recovery_jobs ADD CONSTRAINT payment_recovery_jobs_operation_valid
  CHECK (operation IN ('webhook','payment_creation','payment_status','expiration','refund','payment_invalidation'));