CREATE UNIQUE INDEX product_media_primary_product_unique
  ON product_media(product_id)
  WHERE type='image' AND is_primary=true AND variant_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX product_media_primary_variant_unique
  ON product_media(product_id,variant_id)
  WHERE type='image' AND is_primary=true AND variant_id IS NOT NULL;