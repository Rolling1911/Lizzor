CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "event_type" varchar(100) NOT NULL,
  "in_app_enabled" boolean NOT NULL DEFAULT true,
  "email_enabled" boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id","event_type")
);
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "event_key" varchar(200);
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_event_recipient_unique"
  ON "notifications" ("event_key","user_id","company_id") WHERE "event_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "notification_id" uuid REFERENCES "notifications"("id") ON DELETE CASCADE,
  "event_type" varchar(100) NOT NULL,
  "channel" varchar(20) NOT NULL,
  "recipient_email" varchar(320),
  "subject" varchar(200),
  "message" text,
  "encrypted_secret" text,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "idempotency_key" varchar(200) NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "locked_at" timestamptz,
  "lock_token" uuid,
  "last_error" text,
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_deliveries_idempotency_unique" UNIQUE ("idempotency_key")
);
CREATE INDEX IF NOT EXISTS "notification_deliveries_ready_idx" ON "notification_deliveries" ("status","next_attempt_at");

CREATE TABLE IF NOT EXISTS "notification_delivery_attempts" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "delivery_id" uuid NOT NULL REFERENCES "notification_deliveries"("id") ON DELETE CASCADE,
  "attempt_number" integer NOT NULL,
  "status" varchar(20) NOT NULL,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_attempt_number_unique" UNIQUE ("delivery_id","attempt_number")
);