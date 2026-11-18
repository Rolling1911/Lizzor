/*
 * PRODUCTION DEMO CATALOG CLEANUP — MANUAL EXECUTION ONLY
 *
 * Prepared from the approved production audit and revalidation.
 * DO NOT run against development. DO NOT run without a writable production
 * connection and an authorized operator reviewing the PRE-CLEANUP results.
 *
 * This script:
 * - targets exact audited UUIDs only;
 * - never disables foreign keys;
 * - never contacts or modifies Stripe;
 * - preserves all orders, order items, reservations, movements, payments,
 *   payment evidence, fulfillment, legal, audit, security, user, company,
 *   membership, and invitation records;
 * - removes database media relationships only. It does not delete media files.
 *
 * Expected production baseline:
 * products 20, variants 16, inventory 24, warehouses 12, price_tiers 68,
 * product_media 21, cart_items 34, categories 5, brands 4, orders 17,
 * order_items 17, inventory_reservations 17, inventory_movements 2,
 * payments 11, payment_events 10, payment_recovery_jobs 17,
 * payment_recovery_attempts 8357, shipments 1, fulfillment_events 2,
 * guest_order_claims 0, guest_order_email_access_tokens 4.
 *
 * Expected final state:
 * products 2, variants 1, inventory 2, warehouses 2, price_tiers 0,
 * product_media 0, cart_items 0, categories 1, brands 1, while every
 * protected historical count above remains unchanged.
 */

/* ========================================================================== */
/* PRE-CLEANUP VERIFICATION — READ ONLY                                        */
/* Run this section first and review every result before running the transaction. */
/* ========================================================================== */

/* Exact 18 approved product IDs. This must return 18 rows with the expected names. */
WITH approved_products(id, expected_name) AS (
  VALUES
    ('40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid, 'DEMO-Cedar Hand Care Duo'),
    ('909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid, 'DEMO-Ceramic Soap Tray'),
    ('24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid, 'DEMO-Cloud Travel Towel'),
    ('2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid, 'DEMO-Form Desk Organizer'),
    ('faf1e714-b1cf-4690-9315-d406dde6c281'::uuid, 'DEMO-Grid Hardcover Notebook'),
    ('1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid, 'DEMO-Loop Cable Clips'),
    ('dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid, 'DEMO-Lumen Portable Speaker'),
    ('c95960c3-292d-459e-a6da-a6c282274c1b'::uuid, 'DEMO-Slate Pour-Over Set'),
    ('77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid, 'DEMO-Stack Linen Storage Bins'),
    ('7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid, 'DEMO-Tempo Wireless Presenter'),
    ('cdae366f-61e9-4c10-a845-d44094c05c53'::uuid, 'DEMO-Transit Packing Cube Set'),
    ('ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid, 'return-api-1788081438297-f016e168221e68'),
    ('ad455de0-8c13-4039-ab02-961f85e05728'::uuid, 'Payment Product 1788082345175-8c46f47defbd2'),
    ('2c161e0e-1387-4998-94ee-75022ab86991'::uuid, 'Payment Product 1788082650202-5e29acb57809f8'),
    ('b71e3808-302a-46c8-800b-96c0cda61a04'::uuid, 'Payment Product 1788082756166-58ef854f53df68'),
    ('08721dea-3e31-4093-bb02-8456d5e92eea'::uuid, 'Payment Product 1788082819620-3a38738b6277c8'),
    ('116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid, 'Payment Product 1788083337536-c1dbc9022d65d8'),
    ('c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid, 'Payment Product 1788083401453-fc8d1ea324e76')
)
SELECT a.id, a.expected_name, p.name AS actual_name, p.parent_sku, p.status
FROM approved_products a
LEFT JOIN products p ON p.id = a.id
ORDER BY a.expected_name;

/* Exact protected product shells. This must return Arc and TEST only. */
SELECT id, name, parent_sku, status, published_at
FROM products
WHERE id IN (
  '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid, /* DEMO Arc */
  'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid  /* TEST */
)
ORDER BY name;

/* Exact 10 approved warehouse IDs. This must return 10 expected synthetic rows. */
SELECT id, name, code, active
FROM warehouses
WHERE id IN (
  '81fc2d33-c508-4270-a6b2-4bcbc678334d'::uuid,
  '1402e96c-1015-4f6d-8e1f-03f7398477d7'::uuid,
  '38585c1e-0f91-43d6-a16a-4e401ea8eed5'::uuid,
  '0c01197e-db13-468c-8f6f-fc803ed9c7f8'::uuid,
  '13af26a7-0e43-4823-a17a-597708ebd999'::uuid,
  '06ac5f60-96d8-40d8-8319-fc0339c0b450'::uuid,
  '125ee666-a085-4903-b29c-3160c7bbfdb0'::uuid,
  '7e54b72a-08d2-4623-8a83-069538f79af8'::uuid,
  '130f39c1-393a-4167-a567-a558d5194804'::uuid,
  '66776c2c-c409-40cb-8349-a0f9a4754eb3'::uuid
)
ORDER BY name;

/* Audited baseline counts. */
SELECT
  (SELECT count(*) FROM products) AS products,
  (SELECT count(*) FROM product_variants) AS variants,
  (SELECT count(*) FROM inventory) AS inventory,
  (SELECT count(*) FROM warehouses) AS warehouses,
  (SELECT count(*) FROM price_tiers) AS pricing_tiers,
  (SELECT count(*) FROM product_media) AS media_relationships,
  (SELECT count(*) FROM cart_items) AS cart_item_relationships,
  (SELECT count(*) FROM categories) AS categories,
  (SELECT count(*) FROM brands) AS brands,
  (SELECT count(*) FROM orders) AS orders,
  (SELECT count(*) FROM order_items) AS order_items,
  (SELECT count(*) FROM inventory_reservations) AS reservations,
  (SELECT count(*) FROM inventory_movements) AS movements,
  (SELECT count(*) FROM payments) AS payments,
  (SELECT count(*) FROM payment_events) AS payment_events,
  (SELECT count(*) FROM payment_recovery_jobs) AS recovery_jobs,
  (SELECT count(*) FROM payment_recovery_attempts) AS recovery_attempts,
  (SELECT count(*) FROM shipments) AS shipments,
  (SELECT count(*) FROM fulfillment_events) AS fulfillment_events,
  (SELECT count(*) FROM guest_order_claims) AS guest_order_claims,
  (SELECT count(*) FROM guest_order_email_access_tokens) AS guest_access_tokens;

/* Approved product-tree counts and blocker checks.
 * Expected: 18 products, 15 variants, 22 inventory, 19 media, 60 tiers,
 * and ZERO for every protected blocker column.
 */
WITH approved_products(id) AS (
  VALUES
    ('40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid),
    ('909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid),
    ('24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid),
    ('2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid),
    ('faf1e714-b1cf-4690-9315-d406dde6c281'::uuid),
    ('1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid),
    ('dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid),
    ('c95960c3-292d-459e-a6da-a6c282274c1b'::uuid),
    ('77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid),
    ('7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid),
    ('cdae366f-61e9-4c10-a845-d44094c05c53'::uuid),
    ('ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid),
    ('ad455de0-8c13-4039-ab02-961f85e05728'::uuid),
    ('2c161e0e-1387-4998-94ee-75022ab86991'::uuid),
    ('b71e3808-302a-46c8-800b-96c0cda61a04'::uuid),
    ('08721dea-3e31-4093-bb02-8456d5e92eea'::uuid),
    ('116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid),
    ('c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid)
),
approved_variants AS (
  SELECT id FROM product_variants WHERE product_id IN (SELECT id FROM approved_products)
),
approved_inventory AS (
  SELECT id FROM inventory
  WHERE product_id IN (SELECT id FROM approved_products)
     OR variant_id IN (SELECT id FROM approved_variants)
),
approved_orders AS (
  SELECT DISTINCT order_id FROM order_items
  WHERE product_id IN (SELECT id FROM approved_products)
     OR variant_id IN (SELECT id FROM approved_variants)
)
SELECT
  (SELECT count(*) FROM approved_products) AS products,
  (SELECT count(*) FROM approved_variants) AS variants,
  (SELECT count(*) FROM approved_inventory) AS inventory,
  (SELECT count(*) FROM product_media
    WHERE product_id IN (SELECT id FROM approved_products)
       OR variant_id IN (SELECT id FROM approved_variants)) AS media,
  (SELECT count(*) FROM price_tiers
    WHERE product_id IN (SELECT id FROM approved_products)
       OR variant_id IN (SELECT id FROM approved_variants)) AS tiers,
  (SELECT count(*) FROM order_items
    WHERE product_id IN (SELECT id FROM approved_products)
       OR variant_id IN (SELECT id FROM approved_variants)) AS order_items_blocker,
  (SELECT count(*) FROM inventory_reservations
    WHERE inventory_id IN (SELECT id FROM approved_inventory)) AS reservation_blocker,
  (SELECT count(*) FROM inventory_movements
    WHERE product_id IN (SELECT id FROM approved_products)
       OR variant_id IN (SELECT id FROM approved_variants)) AS movement_blocker,
  (SELECT count(*) FROM payments
    WHERE order_id IN (SELECT order_id FROM approved_orders)) AS payment_blocker,
  (SELECT count(*) FROM shipments
    WHERE order_id IN (SELECT order_id FROM approved_orders)) AS shipment_blocker,
  (SELECT count(*) FROM fulfillment_events
    WHERE order_id IN (SELECT order_id FROM approved_orders)) AS fulfillment_blocker;

/* Protected historical counts. These must remain:
 * orders 17, reservations 17, movements 2, payments 11, payment_events 10,
 * recovery_jobs 17, recovery_attempts 8357, shipments 1,
 * fulfillment_events 2, guest access tokens 4.
 */
SELECT
  (SELECT count(*) FROM orders) AS orders,
  (SELECT count(*) FROM order_items) AS order_items,
  (SELECT count(*) FROM inventory_reservations) AS reservations,
  (SELECT count(*) FROM inventory_movements) AS movements,
  (SELECT count(*) FROM payments) AS payments,
  (SELECT count(*) FROM payment_events) AS payment_events,
  (SELECT count(*) FROM payment_recovery_jobs) AS recovery_jobs,
  (SELECT count(*) FROM payment_recovery_attempts) AS recovery_attempts,
  (SELECT count(*) FROM shipments) AS shipments,
  (SELECT count(*) FROM fulfillment_events) AS fulfillment_events,
  (SELECT count(*) FROM guest_order_claims) AS guest_order_claims,
  (SELECT count(*) FROM guest_order_email_access_tokens) AS guest_access_tokens;

/* ========================================================================== */
/* DESTRUCTIVE TRANSACTION — RUN ONLY AFTER PRE-CLEANUP REVIEW                 */
/* Any assertion failure raises an exception and leaves the transaction aborted. */
/* ========================================================================== */

BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;

/* Serialize against changes to every exact target and protected shell. */
SELECT id
FROM products
WHERE id IN (
  '40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid,
  '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid,
  '24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid,
  '2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid,
  'faf1e714-b1cf-4690-9315-d406dde6c281'::uuid,
  '1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid,
  'dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid,
  'c95960c3-292d-459e-a6da-a6c282274c1b'::uuid,
  '77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid,
  '7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid,
  'cdae366f-61e9-4c10-a845-d44094c05c53'::uuid,
  'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid,
  'ad455de0-8c13-4039-ab02-961f85e05728'::uuid,
  '2c161e0e-1387-4998-94ee-75022ab86991'::uuid,
  'b71e3808-302a-46c8-800b-96c0cda61a04'::uuid,
  '08721dea-3e31-4093-bb02-8456d5e92eea'::uuid,
  '116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid,
  'c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid,
  '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid,
  'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid
)
ORDER BY id
FOR UPDATE;

SELECT id
FROM warehouses
WHERE id IN (
  '81fc2d33-c508-4270-a6b2-4bcbc678334d'::uuid,
  '1402e96c-1015-4f6d-8e1f-03f7398477d7'::uuid,
  '38585c1e-0f91-43d6-a16a-4e401ea8eed5'::uuid,
  '0c01197e-db13-468c-8f6f-fc803ed9c7f8'::uuid,
  '13af26a7-0e43-4823-a17a-597708ebd999'::uuid,
  '06ac5f60-96d8-40d8-8319-fc0339c0b450'::uuid,
  '125ee666-a085-4903-b29c-3160c7bbfdb0'::uuid,
  '7e54b72a-08d2-4623-8a83-069538f79af8'::uuid,
  '130f39c1-393a-4167-a567-a558d5194804'::uuid,
  '66776c2c-c409-40cb-8349-a0f9a4754eb3'::uuid,
  '5eed3a7a-cbe8-48f1-9940-c218222c8c29'::uuid,
  'c08f49ef-9c8d-44fd-b64f-36e9e6653b5e'::uuid
)
ORDER BY id
FOR UPDATE;

/* Fail closed before the first DELETE. */
DO $cleanup_assertions$
DECLARE
  approved_product_ids uuid[] := ARRAY[
    '40311911-cf66-4a03-a9eb-d6cd3ad6a37b',
    '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c',
    '24243a7e-da5a-433d-bd7a-e8a4a0bd1313',
    '2533d9d3-cd52-4a58-a9f3-133f7c58aa27',
    'faf1e714-b1cf-4690-9315-d406dde6c281',
    '1c6bc351-8008-4106-b7fc-4c806136a66f',
    'dbaaa3af-cdf2-4773-801d-52c93e177879',
    'c95960c3-292d-459e-a6da-a6c282274c1b',
    '77226bda-9407-4db9-abd8-eb4a2621bc41',
    '7b98701a-ad58-4fbc-ac94-539be7e2c75a',
    'cdae366f-61e9-4c10-a845-d44094c05c53',
    'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5',
    'ad455de0-8c13-4039-ab02-961f85e05728',
    '2c161e0e-1387-4998-94ee-75022ab86991',
    'b71e3808-302a-46c8-800b-96c0cda61a04',
    '08721dea-3e31-4093-bb02-8456d5e92eea',
    '116ea05b-ba57-4a8a-b93d-d34029f95984',
    'c58369cc-a85d-4e55-8b50-ada2804d4432'
  ]::uuid[];
  approved_variant_ids uuid[];
  approved_inventory_ids uuid[];
  n bigint;
BEGIN
  IF (SELECT count(*) FROM products) <> 20
     OR (SELECT count(*) FROM product_variants) <> 16
     OR (SELECT count(*) FROM inventory) <> 24
     OR (SELECT count(*) FROM warehouses) <> 12
     OR (SELECT count(*) FROM price_tiers) <> 68
     OR (SELECT count(*) FROM product_media) <> 21
     OR (SELECT count(*) FROM cart_items) <> 34
     OR (SELECT count(*) FROM wishlist_items) <> 0
     OR (SELECT count(*) FROM recently_viewed_products) <> 0
     OR (SELECT count(*) FROM promotion_products) <> 0
     OR (SELECT count(*) FROM promotion_usages) <> 0
     OR (SELECT count(*) FROM categories) <> 5
     OR (SELECT count(*) FROM brands) <> 4
     OR (SELECT count(*) FROM orders) <> 17
     OR (SELECT count(*) FROM order_items) <> 17
     OR (SELECT count(*) FROM inventory_reservations) <> 17
     OR (SELECT count(*) FROM inventory_movements) <> 2
     OR (SELECT count(*) FROM payments) <> 11
     OR (SELECT count(*) FROM payment_events) <> 10
     OR (SELECT count(*) FROM payment_recovery_jobs) <> 17
     OR (SELECT count(*) FROM payment_recovery_attempts) <> 8357
     OR (SELECT count(*) FROM shipments) <> 1
     OR (SELECT count(*) FROM fulfillment_events) <> 2
     OR (SELECT count(*) FROM guest_order_claims) <> 0
     OR (SELECT count(*) FROM guest_order_email_access_tokens) <> 4
  THEN
    RAISE EXCEPTION 'Cleanup refused: production baseline counts changed';
  END IF;

  SELECT count(*) INTO n
  FROM products
  WHERE id = ANY(approved_product_ids);
  IF n <> 18 THEN
    RAISE EXCEPTION 'Cleanup refused: expected 18 exact approved products, found %', n;
  END IF;

  SELECT count(*) INTO n
  FROM products
  WHERE id = ANY(approved_product_ids)
    AND name IN (
      'DEMO-Cedar Hand Care Duo',
      'DEMO-Ceramic Soap Tray',
      'DEMO-Cloud Travel Towel',
      'DEMO-Form Desk Organizer',
      'DEMO-Grid Hardcover Notebook',
      'DEMO-Loop Cable Clips',
      'DEMO-Lumen Portable Speaker',
      'DEMO-Slate Pour-Over Set',
      'DEMO-Stack Linen Storage Bins',
      'DEMO-Tempo Wireless Presenter',
      'DEMO-Transit Packing Cube Set',
      'return-api-1788081438297-f016e168221e68',
      'Payment Product 1788082345175-8c46f47defbd2',
      'Payment Product 1788082650202-5e29acb57809f8',
      'Payment Product 1788082756166-58ef854f53df68',
      'Payment Product 1788082819620-3a38738b6277c8',
      'Payment Product 1788083337536-c1dbc9022d65d8',
      'Payment Product 1788083401453-fc8d1ea324e76'
    );
  IF n <> 18 THEN
    RAISE EXCEPTION 'Cleanup refused: an approved product ID no longer has its audited fixture name';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM products
    WHERE id = '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid
      AND name = 'DEMO-Arc USB-C Desk Hub'
  ) OR NOT EXISTS (
    SELECT 1 FROM products
    WHERE id = 'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid
      AND name = 'TEST'
  ) THEN
    RAISE EXCEPTION 'Cleanup refused: protected product shells changed';
  END IF;

  SELECT array_agg(id ORDER BY id) INTO approved_variant_ids
  FROM product_variants
  WHERE product_id = ANY(approved_product_ids);
  IF COALESCE(cardinality(approved_variant_ids), 0) <> 15 THEN
    RAISE EXCEPTION 'Cleanup refused: expected 15 approved variants';
  END IF;

  SELECT array_agg(id ORDER BY id) INTO approved_inventory_ids
  FROM inventory
  WHERE product_id = ANY(approved_product_ids)
     OR variant_id = ANY(approved_variant_ids);
  IF COALESCE(cardinality(approved_inventory_ids), 0) <> 22 THEN
    RAISE EXCEPTION 'Cleanup refused: expected 22 approved inventory rows';
  END IF;

  IF (SELECT count(*) FROM product_media
      WHERE product_id = ANY(approved_product_ids)
         OR variant_id = ANY(approved_variant_ids)) <> 19
     OR (SELECT count(*) FROM price_tiers
         WHERE product_id = ANY(approved_product_ids)
            OR variant_id = ANY(approved_variant_ids)) <> 60
  THEN
    RAISE EXCEPTION 'Cleanup refused: approved catalog-dependent counts changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM order_items
    WHERE product_id = ANY(approved_product_ids)
       OR variant_id = ANY(approved_variant_ids)
  ) THEN
    RAISE EXCEPTION 'Cleanup refused: an approved product acquired order history';
  END IF;

  IF EXISTS (
    SELECT 1 FROM inventory_reservations
    WHERE inventory_id = ANY(approved_inventory_ids)
  ) THEN
    RAISE EXCEPTION 'Cleanup refused: an approved inventory row acquired reservation history';
  END IF;

  IF EXISTS (
    SELECT 1 FROM inventory_movements
    WHERE product_id = ANY(approved_product_ids)
       OR variant_id = ANY(approved_variant_ids)
  ) THEN
    RAISE EXCEPTION 'Cleanup refused: an approved product acquired movement or transfer history';
  END IF;

  /* All audited pricing, media, and cart relationships must still be confined
   * to the exact 20 synthetic products/protected shells.
   */
  IF (SELECT count(*) FROM price_tiers
      WHERE product_id = ANY(approved_product_ids || ARRAY[
        '1411572a-eae3-4224-bb95-c2a565f9696a',
        'a3ca68a7-fb78-4553-91de-4389721c0f33'
      ]::uuid[])
         OR variant_id IN (
           SELECT id FROM product_variants
           WHERE product_id = ANY(approved_product_ids || ARRAY[
             '1411572a-eae3-4224-bb95-c2a565f9696a',
             'a3ca68a7-fb78-4553-91de-4389721c0f33'
           ]::uuid[])
         )) <> 68
  THEN
    RAISE EXCEPTION 'Cleanup refused: the 68 pricing tiers are no longer confined to the audited products';
  END IF;

  IF (SELECT count(*) FROM cart_items
      WHERE product_id = ANY(approved_product_ids || ARRAY[
        '1411572a-eae3-4224-bb95-c2a565f9696a',
        'a3ca68a7-fb78-4553-91de-4389721c0f33'
      ]::uuid[])) <> 34
  THEN
    RAISE EXCEPTION 'Cleanup refused: the 34 cart items are no longer confined to the audited products';
  END IF;

  IF (SELECT count(*) FROM product_media
      WHERE product_id = ANY(approved_product_ids || ARRAY[
        '1411572a-eae3-4224-bb95-c2a565f9696a',
        'a3ca68a7-fb78-4553-91de-4389721c0f33'
      ]::uuid[])) <> 21
  THEN
    RAISE EXCEPTION 'Cleanup refused: the 21 media relationships are no longer confined to the audited products';
  END IF;
END
$cleanup_assertions$;

/* 1. Remove approved synthetic session/catalog relationships first.
 * Cart shells, users, and converted orders are intentionally untouched.
 */
DELETE FROM cart_items
WHERE product_id IN (
  '40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid,
  '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid,
  '24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid,
  '2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid,
  'faf1e714-b1cf-4690-9315-d406dde6c281'::uuid,
  '1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid,
  'dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid,
  'c95960c3-292d-459e-a6da-a6c282274c1b'::uuid,
  '77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid,
  '7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid,
  'cdae366f-61e9-4c10-a845-d44094c05c53'::uuid,
  'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid,
  'ad455de0-8c13-4039-ab02-961f85e05728'::uuid,
  '2c161e0e-1387-4998-94ee-75022ab86991'::uuid,
  'b71e3808-302a-46c8-800b-96c0cda61a04'::uuid,
  '08721dea-3e31-4093-bb02-8456d5e92eea'::uuid,
  '116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid,
  'c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid,
  '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid,
  'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid
);

DELETE FROM price_tiers
WHERE product_id IN (
  SELECT id FROM products
  WHERE id IN (
    '40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid,
    '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid,
    '24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid,
    '2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid,
    'faf1e714-b1cf-4690-9315-d406dde6c281'::uuid,
    '1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid,
    'dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid,
    'c95960c3-292d-459e-a6da-a6c282274c1b'::uuid,
    '77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid,
    '7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid,
    'cdae366f-61e9-4c10-a845-d44094c05c53'::uuid,
    'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid,
    'ad455de0-8c13-4039-ab02-961f85e05728'::uuid,
    '2c161e0e-1387-4998-94ee-75022ab86991'::uuid,
    'b71e3808-302a-46c8-800b-96c0cda61a04'::uuid,
    '08721dea-3e31-4093-bb02-8456d5e92eea'::uuid,
    '116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid,
    'c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid,
    '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid,
    'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid
  )
)
OR variant_id IN (
  SELECT id FROM product_variants
  WHERE product_id IN (
    '40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid,
    '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid,
    '24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid,
    '2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid,
    'faf1e714-b1cf-4690-9315-d406dde6c281'::uuid,
    '1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid,
    'dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid,
    'c95960c3-292d-459e-a6da-a6c282274c1b'::uuid,
    '77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid,
    '7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid,
    'cdae366f-61e9-4c10-a845-d44094c05c53'::uuid,
    'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid,
    'ad455de0-8c13-4039-ab02-961f85e05728'::uuid,
    '2c161e0e-1387-4998-94ee-75022ab86991'::uuid,
    'b71e3808-302a-46c8-800b-96c0cda61a04'::uuid,
    '08721dea-3e31-4093-bb02-8456d5e92eea'::uuid,
    '116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid,
    'c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid,
    '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid,
    'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid
  )
);

DELETE FROM product_media
WHERE product_id IN (
  '40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid,
  '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid,
  '24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid,
  '2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid,
  'faf1e714-b1cf-4690-9315-d406dde6c281'::uuid,
  '1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid,
  'dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid,
  'c95960c3-292d-459e-a6da-a6c282274c1b'::uuid,
  '77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid,
  '7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid,
  'cdae366f-61e9-4c10-a845-d44094c05c53'::uuid,
  'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid,
  'ad455de0-8c13-4039-ab02-961f85e05728'::uuid,
  '2c161e0e-1387-4998-94ee-75022ab86991'::uuid,
  'b71e3808-302a-46c8-800b-96c0cda61a04'::uuid,
  '08721dea-3e31-4093-bb02-8456d5e92eea'::uuid,
  '116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid,
  'c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid,
  '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid,
  'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid
);

/* Audited and transactionally asserted as zero. These exact-ID statements are
 * retained to make the intended dependency order explicit, but must affect zero
 * rows or the final transaction review should be treated as suspect.
 */
DELETE FROM wishlist_items
WHERE product_id IN (
  '40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid,
  '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid,
  '24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid,
  '2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid,
  'faf1e714-b1cf-4690-9315-d406dde6c281'::uuid,
  '1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid,
  'dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid,
  'c95960c3-292d-459e-a6da-a6c282274c1b'::uuid,
  '77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid,
  '7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid,
  'cdae366f-61e9-4c10-a845-d44094c05c53'::uuid,
  'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid,
  'ad455de0-8c13-4039-ab02-961f85e05728'::uuid,
  '2c161e0e-1387-4998-94ee-75022ab86991'::uuid,
  'b71e3808-302a-46c8-800b-96c0cda61a04'::uuid,
  '08721dea-3e31-4093-bb02-8456d5e92eea'::uuid,
  '116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid,
  'c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid
);

DELETE FROM recently_viewed_products
WHERE product_id IN (
  '40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid,
  '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid,
  '24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid,
  '2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid,
  'faf1e714-b1cf-4690-9315-d406dde6c281'::uuid,
  '1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid,
  'dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid,
  'c95960c3-292d-459e-a6da-a6c282274c1b'::uuid,
  '77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid,
  '7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid,
  'cdae366f-61e9-4c10-a845-d44094c05c53'::uuid,
  'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid,
  'ad455de0-8c13-4039-ab02-961f85e05728'::uuid,
  '2c161e0e-1387-4998-94ee-75022ab86991'::uuid,
  'b71e3808-302a-46c8-800b-96c0cda61a04'::uuid,
  '08721dea-3e31-4093-bb02-8456d5e92eea'::uuid,
  '116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid,
  'c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid
);

/* Promotion links were audited as zero. This exact-ID statement cannot affect
 * usage/payment history and protects against an unexpected FK at product delete.
 */
DELETE FROM promotion_products
WHERE product_id IN (
  '40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid,
  '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid,
  '24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid,
  '2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid,
  'faf1e714-b1cf-4690-9315-d406dde6c281'::uuid,
  '1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid,
  'dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid,
  'c95960c3-292d-459e-a6da-a6c282274c1b'::uuid,
  '77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid,
  '7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid,
  'cdae366f-61e9-4c10-a845-d44094c05c53'::uuid,
  'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid,
  'ad455de0-8c13-4039-ab02-961f85e05728'::uuid,
  '2c161e0e-1387-4998-94ee-75022ab86991'::uuid,
  'b71e3808-302a-46c8-800b-96c0cda61a04'::uuid,
  '08721dea-3e31-4093-bb02-8456d5e92eea'::uuid,
  '116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid,
  'c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid
);

/* 2. Delete only the 18 approved product trees. Cascades remove their exact,
 * already-revalidated variants and unprotected inventory rows.
 */
DELETE FROM products
WHERE id IN (
  '40311911-cf66-4a03-a9eb-d6cd3ad6a37b'::uuid,
  '909e1aef-b3d6-40d3-8cd0-f1e129e1a95c'::uuid,
  '24243a7e-da5a-433d-bd7a-e8a4a0bd1313'::uuid,
  '2533d9d3-cd52-4a58-a9f3-133f7c58aa27'::uuid,
  'faf1e714-b1cf-4690-9315-d406dde6c281'::uuid,
  '1c6bc351-8008-4106-b7fc-4c806136a66f'::uuid,
  'dbaaa3af-cdf2-4773-801d-52c93e177879'::uuid,
  'c95960c3-292d-459e-a6da-a6c282274c1b'::uuid,
  '77226bda-9407-4db9-abd8-eb4a2621bc41'::uuid,
  '7b98701a-ad58-4fbc-ac94-539be7e2c75a'::uuid,
  'cdae366f-61e9-4c10-a845-d44094c05c53'::uuid,
  'ab62506a-d2d0-469f-bfec-7ecfe9ed85f5'::uuid,
  'ad455de0-8c13-4039-ab02-961f85e05728'::uuid,
  '2c161e0e-1387-4998-94ee-75022ab86991'::uuid,
  'b71e3808-302a-46c8-800b-96c0cda61a04'::uuid,
  '08721dea-3e31-4093-bb02-8456d5e92eea'::uuid,
  '116ea05b-ba57-4a8a-b93d-d34029f95984'::uuid,
  'c58369cc-a85d-4e55-8b50-ada2804d4432'::uuid
);

/* 3. Keep protected shells non-public/non-purchasable.
 * Product archival follows the application's persisted status fields:
 * archived status + no published_at. No order/payment snapshots are changed.
 */
UPDATE products
SET status = 'archived', published_at = NULL, updated_at = now()
WHERE id IN (
  '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid,
  'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid
);

/* Retain both historical warehouses but prevent normal warehouse operations. */
UPDATE warehouses
SET active = false, updated_at = now()
WHERE id IN (
  '5eed3a7a-cbe8-48f1-9940-c218222c8c29'::uuid,
  'c08f49ef-9c8d-44fd-b64f-36e9e6653b5e'::uuid
);

/* Inventory.active was not present in the audited production schema and is
 * intentionally not guessed or referenced here. The archived product status
 * prevents purchase/public catalog eligibility in the deployed schema.
 * After the inventory lifecycle schema is published through Replit's supported
 * Publish flow, deactivate the two retained inventory rows through Admin
 * Inventory; do not update production schema from this script.
 */

/* 4. Remove only the exact 10 approved warehouses, now required to be empty. */
DELETE FROM warehouses
WHERE id IN (
  '81fc2d33-c508-4270-a6b2-4bcbc678334d'::uuid,
  '1402e96c-1015-4f6d-8e1f-03f7398477d7'::uuid,
  '38585c1e-0f91-43d6-a16a-4e401ea8eed5'::uuid,
  '0c01197e-db13-468c-8f6f-fc803ed9c7f8'::uuid,
  '13af26a7-0e43-4823-a17a-597708ebd999'::uuid,
  '06ac5f60-96d8-40d8-8319-fc0339c0b450'::uuid,
  '125ee666-a085-4903-b29c-3160c7bbfdb0'::uuid,
  '7e54b72a-08d2-4623-8a83-069538f79af8'::uuid,
  '130f39c1-393a-4167-a567-a558d5194804'::uuid,
  '66776c2c-c409-40cb-8349-a0f9a4754eb3'::uuid
)
AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.warehouse_id = warehouses.id)
AND NOT EXISTS (SELECT 1 FROM inventory_movements im WHERE im.warehouse_id = warehouses.id);

/* 5. Remove only exact audited taxonomy IDs, and only if now unused. */
DELETE FROM categories
WHERE id IN (
  'ff6297c7-cf6f-42b2-92c8-811378122d91'::uuid,
  'b2e3df42-d570-4603-be35-93d827ec7c6a'::uuid,
  '6a594015-0a27-4dda-babe-fe4c1ac6d439'::uuid,
  '54acfa4b-a0fe-444c-b697-e8d066d8ba42'::uuid
)
AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = categories.id);

DELETE FROM brands
WHERE id IN (
  'a0b9a201-4df7-4637-82d8-9b9b5251864e'::uuid,
  'bc03b455-4bf7-4c46-8127-3400c2b8c2bd'::uuid,
  '7a8be32f-af28-4774-b5d5-b72e0d96c51f'::uuid
)
AND NOT EXISTS (SELECT 1 FROM products p WHERE p.brand_id = brands.id);

/* Fail closed before COMMIT unless the exact final state and protected history
 * are intact. An exception aborts the transaction.
 */
DO $post_cleanup_assertions$
BEGIN
  IF (SELECT count(*) FROM products) <> 2
     OR (SELECT count(*) FROM product_variants) <> 1
     OR (SELECT count(*) FROM inventory) <> 2
     OR (SELECT count(*) FROM warehouses) <> 2
     OR (SELECT count(*) FROM price_tiers) <> 0
     OR (SELECT count(*) FROM product_media) <> 0
     OR (SELECT count(*) FROM cart_items) <> 0
     OR (SELECT count(*) FROM categories) <> 1
     OR (SELECT count(*) FROM brands) <> 1
  THEN
    RAISE EXCEPTION 'Cleanup refused at final check: catalog counts are not the approved final state';
  END IF;

  IF (SELECT count(*) FROM orders) <> 17
     OR (SELECT count(*) FROM order_items) <> 17
     OR (SELECT count(*) FROM inventory_reservations) <> 17
     OR (SELECT count(*) FROM inventory_movements) <> 2
     OR (SELECT count(*) FROM payments) <> 11
     OR (SELECT count(*) FROM payment_events) <> 10
     OR (SELECT count(*) FROM payment_recovery_jobs) <> 17
     OR (SELECT count(*) FROM payment_recovery_attempts) <> 8357
     OR (SELECT count(*) FROM shipments) <> 1
     OR (SELECT count(*) FROM fulfillment_events) <> 2
     OR (SELECT count(*) FROM guest_order_claims) <> 0
     OR (SELECT count(*) FROM guest_order_email_access_tokens) <> 4
  THEN
    RAISE EXCEPTION 'Cleanup refused at final check: protected historical counts changed';
  END IF;

  IF (SELECT count(*) FROM products
      WHERE id IN (
        '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid,
        'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid
      )
        AND status = 'archived'
        AND published_at IS NULL) <> 2
  THEN
    RAISE EXCEPTION 'Cleanup refused at final check: protected shells are not archived';
  END IF;

  IF (SELECT count(*) FROM warehouses
      WHERE id IN (
        '5eed3a7a-cbe8-48f1-9940-c218222c8c29'::uuid,
        'c08f49ef-9c8d-44fd-b64f-36e9e6653b5e'::uuid
      )
        AND active = false) <> 2
  THEN
    RAISE EXCEPTION 'Cleanup refused at final check: protected warehouses are not inactive';
  END IF;
END
$post_cleanup_assertions$;

COMMIT;

/* ========================================================================== */
/* POST-CLEANUP VERIFICATION — READ ONLY                                       */
/* Run after COMMIT. Every value should match the expected final state.         */
/* ========================================================================== */

SELECT
  (SELECT count(*) FROM products) AS products_expected_2,
  (SELECT count(*) FROM product_variants) AS variants_expected_1,
  (SELECT count(*) FROM inventory) AS inventory_expected_2,
  (SELECT count(*) FROM warehouses) AS warehouses_expected_2,
  (SELECT count(*) FROM price_tiers) AS pricing_tiers_expected_0,
  (SELECT count(*) FROM product_media) AS media_expected_0,
  (SELECT count(*) FROM cart_items) AS cart_items_expected_0,
  (SELECT count(*) FROM categories) AS categories_expected_1,
  (SELECT count(*) FROM brands) AS brands_expected_1,
  (SELECT count(*) FROM orders) AS orders_expected_17,
  (SELECT count(*) FROM order_items) AS order_items_expected_17,
  (SELECT count(*) FROM inventory_reservations) AS reservations_expected_17,
  (SELECT count(*) FROM inventory_movements) AS movements_expected_2,
  (SELECT count(*) FROM payments) AS payments_expected_11,
  (SELECT count(*) FROM payment_events) AS payment_events_expected_10,
  (SELECT count(*) FROM payment_recovery_jobs) AS recovery_jobs_expected_17,
  (SELECT count(*) FROM payment_recovery_attempts) AS recovery_attempts_expected_8357,
  (SELECT count(*) FROM shipments) AS shipments_expected_1,
  (SELECT count(*) FROM fulfillment_events) AS fulfillment_events_expected_2,
  (SELECT count(*) FROM guest_order_claims) AS guest_order_claims_expected_0,
  (SELECT count(*) FROM guest_order_email_access_tokens) AS guest_access_tokens_expected_4;

/* These are the only products and warehouses that should remain. */
SELECT id, name, parent_sku, status, published_at
FROM products
ORDER BY name;

SELECT id, name, code, active
FROM warehouses
ORDER BY name;

/* Public/sellable synthetic products must be zero. */
SELECT count(*) AS publicly_sellable_synthetic_products_expected_0
FROM products
WHERE status = 'active'
  AND published_at IS NOT NULL
  AND id IN (
    '1411572a-eae3-4224-bb95-c2a565f9696a'::uuid,
    'a3ca68a7-fb78-4553-91de-4389721c0f33'::uuid
  );

/*
 * TABLES MODIFIED, IN FOREIGN-KEY-SAFE ORDER
 * 1. cart_items
 * 2. price_tiers
 * 3. product_media
 * 4. wishlist_items (audited zero)
 * 5. recently_viewed_products (audited zero)
 * 6. promotion_products (audited zero)
 * 7. products (cascades approved variants and unprotected inventory)
 * 8. products (archive the two retained shells)
 * 9. warehouses (deactivate two retained historical warehouses)
 * 10. warehouses (delete ten exact empty/unprotected fixtures)
 * 11. categories (four exact IDs, only when unused)
 * 12. brands (three exact IDs, only when unused)
 *
 * ROLLBACK BEHAVIOR
 * - Any failed pre-delete assertion raises an exception before DELETE.
 * - Any foreign-key failure aborts the transaction.
 * - Any final-count/protected-history mismatch raises an exception before COMMIT.
 * - In PostgreSQL an exception leaves the transaction aborted; issue ROLLBACK
 *   before correcting/reviewing anything. Do not retry blindly.
 *
 * OPERATOR SUCCESS CHECK
 * 1. Run PRE-CLEANUP SELECTs and compare every value to the documented baseline.
 * 2. Run the complete destructive transaction in one session with stop-on-error.
 * 3. Confirm COMMIT succeeded; if any error occurred, issue ROLLBACK.
 * 4. Run every POST-CLEANUP SELECT.
 * 5. Verify the public storefront/search has no Arc/TEST or other demo products.
 * 6. Verify Admin Inventory retains exactly the Arc and TEST historical rows.
 * 7. After the inventory lifecycle schema is separately published, deactivate
 *    those two inventory rows through the Admin Inventory lifecycle action.
 * 8. Do not delete media files from storage unless ownership is independently
 *    proven; this SQL intentionally removes database relationships only.
 */