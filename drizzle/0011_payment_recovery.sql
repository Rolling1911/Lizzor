ALTER TABLE "payments" ADD COLUMN "recovery_status" varchar(30) DEFAULT 'idle' NOT NULL;
ALTER TABLE "payments" ADD COLUMN "recovery_attempt_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "payments" ADD COLUMN "last_recovery_attempt_at" timestamptz;
ALTER TABLE "payments" ADD COLUMN "next_recovery_attempt_at" timestamptz;
ALTER TABLE "payments" ADD COLUMN "recovery_failure_reason" text;
CREATE TABLE "payment_recovery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_id" uuid NOT NULL REFERENCES "payments"("id") ON DELETE CASCADE,
  "provider_event_id" varchar(200),
  "source" varchar(40) NOT NULL,
  "status" varchar(30) NOT NULL,
  "attempt_number" integer NOT NULL,
  "failure_reason" text,
  "details_json" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_recovery_attempts_number_positive" CHECK ("attempt_number" > 0)
);
CREATE INDEX "payment_recovery_attempts_payment_idx" ON "payment_recovery_attempts" ("payment_id","created_at");
CREATE INDEX "payment_recovery_attempts_status_idx" ON "payment_recovery_attempts" ("status","created_at");
CREATE UNIQUE INDEX "payment_recovery_attempts_provider_event_unique" ON "payment_recovery_attempts" ("provider_event_id");
INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('payments.recovery.view', 'View payment recovery state and attempts'),
  ('payments.recovery.manage', 'Retry payment recovery and safely release expired reservations')
ON CONFLICT ("permission_key") DO NOTHING;
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "admin_roles" r CROSS JOIN "admin_permissions" p
WHERE r."name" = 'Super Admin' AND p."permission_key" IN ('payments.recovery.view','payments.recovery.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;