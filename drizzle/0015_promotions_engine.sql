ALTER TABLE "promotion_campaigns"
  ADD COLUMN IF NOT EXISTS "promotion_type" varchar(30) NOT NULL DEFAULT 'order',
  ADD COLUMN IF NOT EXISTS "discount_type" "discount_type",
  ADD COLUMN IF NOT EXISTS "discount_value" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "minimum_order_value" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "free_shipping" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "automatic" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "coupon_code" varchar(80),
  ADD COLUMN IF NOT EXISTS "usage_limit" integer,
  ADD COLUMN IF NOT EXISTS "usage_limit_per_customer" integer,
  ADD COLUMN IF NOT EXISTS "allow_stacking" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "priority" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_campaigns_coupon_code_unique" ON "promotion_campaigns" ("coupon_code") WHERE "coupon_code" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_value_nonnegative" CHECK ("discount_value" IS NULL OR "discount_value" >= 0);
--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_percentage_valid" CHECK ("discount_type" IS NULL OR "discount_type" <> 'percentage' OR "discount_value" <= 100);
--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_usage_limits_positive" CHECK (("usage_limit" IS NULL OR "usage_limit" > 0) AND ("usage_limit_per_customer" IS NULL OR "usage_limit_per_customer" > 0));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotion_brands" (
  "campaign_id" uuid NOT NULL REFERENCES "promotion_campaigns"("id") ON DELETE CASCADE,
  "brand_id" uuid NOT NULL REFERENCES "brands"("id") ON DELETE CASCADE,
  CONSTRAINT "promotion_brands_campaign_id_brand_id_pk" PRIMARY KEY("campaign_id","brand_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_brands_brand_idx" ON "promotion_brands" ("brand_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promotion_usages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL REFERENCES "promotion_campaigns"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "guest_session_id" varchar(200),
  "discount_amount" numeric(12, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "promotion_usages_discount_nonnegative" CHECK ("discount_amount" >= 0),
  CONSTRAINT "promotion_usages_campaign_order_unique" UNIQUE("campaign_id","order_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_usages_customer_idx" ON "promotion_usages" ("campaign_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_usages_guest_idx" ON "promotion_usages" ("campaign_id","guest_session_id");
--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN IF NOT EXISTS "applied_coupon_code" varchar(80);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "promotion_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "promotion_snapshot" jsonb;
--> statement-breakpoint
INSERT INTO "admin_permissions" ("permission_key") VALUES
  ('promotions.create'),('promotions.edit'),('promotions.manage'),('promotions.archive')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id","permission_id")
SELECT r.id,p.id FROM "admin_roles" r CROSS JOIN "admin_permissions" p
WHERE r.name='Super Admin' AND p.permission_key IN ('promotions.create','promotions.edit','promotions.manage','promotions.archive')
ON CONFLICT DO NOTHING;