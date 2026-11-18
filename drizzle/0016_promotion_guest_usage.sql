ALTER TABLE "promotion_usages" ADD COLUMN IF NOT EXISTS "guest_session_id" varchar(200);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_usages_guest_idx" ON "promotion_usages" ("campaign_id","guest_session_id");