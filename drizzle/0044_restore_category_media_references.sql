UPDATE "categories" AS c
SET
  "image_url" = media."image_url",
  "updated_at" = now()
FROM (
  VALUES
    ('demo-electronics', '/catalog-media/category-electronics.png'),
    ('demo-home-kitchen', '/catalog-media/category-home-kitchen.png'),
    ('demo-beauty-care', '/catalog-media/category-beauty.png'),
    ('demo-travel-accessories', '/catalog-media/category-travel.png'),
    ('demo-office-essentials', '/catalog-media/category-office.png')
) AS media("slug", "image_url")
WHERE c."slug" = media."slug"
  AND (c."image_url" IS NULL OR btrim(c."image_url") = '');