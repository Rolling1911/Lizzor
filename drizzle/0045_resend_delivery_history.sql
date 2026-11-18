ALTER TABLE "notification_deliveries"
  ADD COLUMN IF NOT EXISTS "metadata_json" jsonb,
  ADD COLUMN IF NOT EXISTS "provider_message_id" varchar(200);