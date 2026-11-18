ALTER TABLE "storefront_banners"
ADD COLUMN IF NOT EXISTS "published_config_json" jsonb;