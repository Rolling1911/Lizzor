ALTER TABLE "company_invitations" ADD COLUMN IF NOT EXISTS "last_resend_idempotency_key" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_invitations_last_resend_idempotency_key_unique"
  ON "company_invitations" ("last_resend_idempotency_key") WHERE "last_resend_idempotency_key" IS NOT NULL;