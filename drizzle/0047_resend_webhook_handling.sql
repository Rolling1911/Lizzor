ALTER TABLE "notification_deliveries"
  ADD COLUMN IF NOT EXISTS "provider_status" varchar(30),
  ADD COLUMN IF NOT EXISTS "provider_event_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "suppression_reason" varchar(30),
  ADD COLUMN IF NOT EXISTS "suppressed_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "notification_deliveries_provider_message_idx"
  ON "notification_deliveries" ("provider_message_id");
CREATE INDEX IF NOT EXISTS "notification_deliveries_provider_status_idx"
  ON "notification_deliveries" ("provider_status", "created_at");

CREATE TABLE IF NOT EXISTS "resend_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "webhook_id" varchar(200) NOT NULL,
  "event_type" varchar(50) NOT NULL,
  "provider_message_id" varchar(200) NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "matched_delivery_id" uuid REFERENCES "notification_deliveries"("id") ON DELETE SET NULL,
  "details_json" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "resend_webhook_events_webhook_id_unique" UNIQUE("webhook_id")
);
CREATE INDEX IF NOT EXISTS "resend_webhook_events_provider_message_idx"
  ON "resend_webhook_events" ("provider_message_id", "occurred_at");

CREATE TABLE IF NOT EXISTS "email_recipient_suppressions" (
  "email" varchar(320) PRIMARY KEY,
  "reason" varchar(30) NOT NULL,
  "provider_message_id" varchar(200),
  "source_event_id" uuid REFERENCES "resend_webhook_events"("id") ON DELETE SET NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);