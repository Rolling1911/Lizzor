UPDATE "storefront_banners"
SET
  "desktop_url" = '/lizzor-mobile-app-banner.png',
  "mobile_url" = '/lizzor-mobile-app-banner.png',
  "alt_text" = 'Lizzor mobile app coming soon banner',
  "enabled" = true,
  "app_status" = 'coming_soon',
  "app_store_url" = NULL,
  "google_play_url" = NULL,
  "qr_image_url" = NULL,
  "published_config_json" = jsonb_build_object(
    'desktopUrl', '/lizzor-mobile-app-banner.png',
    'mobileUrl', '/lizzor-mobile-app-banner.png',
    'altText', 'Lizzor mobile app coming soon banner',
    'enabled', true,
    'appStatus', 'coming_soon',
    'appStoreUrl', NULL,
    'googlePlayUrl', NULL,
    'qrImageUrl', NULL
  ),
  "published_at" = COALESCE("published_at", now()),
  "updated_at" = now()
WHERE "slot" = 'homepage_app_banner';