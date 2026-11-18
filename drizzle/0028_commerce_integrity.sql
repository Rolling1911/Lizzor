ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_request_fingerprint" varchar(64);
--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD COLUMN IF NOT EXISTS "usage_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE "promotion_campaigns" c
   SET "usage_count" = usage.total
  FROM (
    SELECT "campaign_id", count(*)::integer AS total
      FROM "promotion_usages"
     GROUP BY "campaign_id"
  ) usage
 WHERE c."id" = usage."campaign_id";
--> statement-breakpoint
ALTER TABLE "promotion_campaigns"
  ADD CONSTRAINT "promotion_campaigns_usage_count_nonnegative" CHECK ("usage_count" >= 0);