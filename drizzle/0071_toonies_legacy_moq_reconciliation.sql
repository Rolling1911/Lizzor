-- Reconcile legacy Toonies MOQ from the preserved provider payload. Records
-- without a valid positive integer remain unavailable for publication until a
-- controlled resync supplies authoritative MOQ.
WITH item_moq AS (
  SELECT i.id,
         COALESCE(
           i.raw_payload->>'minimum_order_quantity',
           i.raw_payload->>'min_order_quantity',
           i.raw_payload->>'moq',
           i.raw_payload->>'min_order',
           i.raw_payload->>'min_num',
           i.raw_payload->>'min_quantity'
         ) AS raw_moq
    FROM supplier_catalogue_items i
    JOIN suppliers s ON s.id=i.supplier_id AND s.slug='toonies'
)
UPDATE supplier_catalogue_items i
   SET supplier_raw_moq=to_jsonb(item_moq.raw_moq),
       minimum_order_quantity=(item_moq.raw_moq::numeric)::integer,
       updated_at=now()
  FROM item_moq
 WHERE i.id=item_moq.id
   AND item_moq.raw_moq ~ '^[1-9][0-9]{0,8}$';

WITH unresolved AS (
  SELECT i.id
    FROM supplier_catalogue_items i
    JOIN suppliers s ON s.id=i.supplier_id AND s.slug='toonies'
   WHERE COALESCE(
           i.raw_payload->>'minimum_order_quantity',
           i.raw_payload->>'min_order_quantity',
           i.raw_payload->>'moq',
           i.raw_payload->>'min_order',
           i.raw_payload->>'min_num',
           i.raw_payload->>'min_quantity'
         ) !~ '^[1-9][0-9]{0,8}$'
      OR COALESCE(
           i.raw_payload->>'minimum_order_quantity',
           i.raw_payload->>'min_order_quantity',
           i.raw_payload->>'moq',
           i.raw_payload->>'min_order',
           i.raw_payload->>'min_num',
           i.raw_payload->>'min_quantity'
         ) IS NULL
)
UPDATE supplier_catalogue_items i
   SET needs_review=true,state='Needs review',updated_at=now()
  FROM unresolved
 WHERE i.id=unresolved.id;

WITH variant_moq AS (
  SELECT v.id,i.minimum_order_quantity AS item_moq,
         COALESCE(
           v.raw_payload->>'minimum_order_quantity',
           v.raw_payload->>'min_order_quantity',
           v.raw_payload->>'moq',
           v.raw_payload->>'min_order',
           v.raw_payload->>'min_num',
           v.raw_payload->>'min_quantity'
         ) AS raw_moq
    FROM supplier_catalogue_variants v
    JOIN supplier_catalogue_items i ON i.id=v.catalogue_item_id
    JOIN suppliers s ON s.id=v.supplier_id AND s.slug='toonies'
)
UPDATE supplier_catalogue_variants v
   SET supplier_raw_moq=CASE
         WHEN variant_moq.raw_moq ~ '^[1-9][0-9]{0,8}$' THEN to_jsonb(variant_moq.raw_moq)
         ELSE to_jsonb(variant_moq.item_moq)
       END,
       minimum_order_quantity=CASE
         WHEN variant_moq.raw_moq ~ '^[1-9][0-9]{0,8}$' THEN (variant_moq.raw_moq::numeric)::integer
         ELSE variant_moq.item_moq
       END,
       updated_at=now()
  FROM variant_moq
 WHERE v.id=variant_moq.id;

UPDATE products p
   SET minimum_order_quantity=i.minimum_order_quantity,updated_at=now()
  FROM supplier_import_records r
  JOIN supplier_catalogue_items i ON i.id=r.catalogue_item_id
  JOIN suppliers s ON s.id=i.supplier_id AND s.slug='toonies'
 WHERE r.product_id=p.id
   AND r.external_variant_id IS NULL;

UPDATE product_variants pv
   SET minimum_order_quantity=v.minimum_order_quantity,updated_at=now()
  FROM supplier_import_records r
  JOIN supplier_catalogue_variants v ON v.id=r.catalogue_variant_id
  JOIN suppliers s ON s.id=v.supplier_id AND s.slug='toonies'
 WHERE r.variant_id=pv.id
   AND r.external_variant_id IS NOT NULL;