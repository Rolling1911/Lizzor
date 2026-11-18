CREATE TABLE IF NOT EXISTS "storefront_banners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slot" varchar(64) NOT NULL,
  "desktop_url" text,
  "mobile_url" text,
  "alt_text" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "app_status" varchar(20) DEFAULT 'coming_soon' NOT NULL,
  "app_store_url" text,
  "google_play_url" text,
  "qr_image_url" text,
  "published_at" timestamptz,
  "published_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "storefront_banners_slot_valid" CHECK ("slot" IN ('homepage_hero', 'homepage_app_banner')),
  CONSTRAINT "storefront_banners_app_status_valid" CHECK ("app_status" IN ('coming_soon', 'live')),
  CONSTRAINT "storefront_banners_slot_unique" UNIQUE ("slot"),
  CONSTRAINT "storefront_banners_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "storefront_banners_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "storefront_banners_public_idx" ON "storefront_banners" ("enabled", "published_at");

INSERT INTO "storefront_banners" ("slot")
VALUES ('homepage_hero'), ('homepage_app_banner')
ON CONFLICT ("slot") DO NOTHING;

INSERT INTO "admin_permissions" ("permission_key", "description")
VALUES
  ('storefront_banners.view', 'View homepage banner settings and previews.'),
  ('storefront_banners.manage', 'Upload, edit, enable, disable, and publish homepage banners.')
ON CONFLICT ("permission_key") DO NOTHING;

INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT roles.id, permissions.id
FROM "admin_roles" roles
CROSS JOIN "admin_permissions" permissions
WHERE roles.name = 'Super Admin'
  AND permissions.permission_key IN ('storefront_banners.view', 'storefront_banners.manage')
ON CONFLICT DO NOTHING;