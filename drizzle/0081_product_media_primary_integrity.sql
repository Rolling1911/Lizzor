WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY product_id, variant_id
           ORDER BY sort_order, created_at, id
         ) AS primary_rank
    FROM product_media
   WHERE type='image' AND is_primary=true
)
UPDATE product_media media
   SET is_primary=false
  FROM ranked
 WHERE media.id=ranked.id
   AND ranked.primary_rank>1;
--> statement-breakpoint
CREATE UNIQUE INDEX product_media_primary_product_unique
  ON product_media(product_id)
  WHERE type='image' AND is_primary=true AND variant_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX product_media_primary_variant_unique
  ON product_media(product_id,variant_id)
  WHERE type='image' AND is_primary=true AND variant_id IS NOT NULL;