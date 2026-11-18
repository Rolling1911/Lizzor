ALTER TABLE orders
  ADD COLUMN shipping_rule_id uuid,
  ADD COLUMN shipping_provider varchar(80),
  ADD COLUMN shipping_source varchar(80),
  ADD COLUMN shipping_weight_kg numeric(10,3),
  ADD COLUMN shipping_quoted_total numeric(12,2),
  ADD COLUMN shipping_charged_total numeric(12,2),
  ADD COLUMN shipping_min_delivery_days integer,
  ADD COLUMN shipping_max_delivery_days integer;

ALTER TABLE orders
  ADD CONSTRAINT orders_shipping_snapshot_weight_nonnegative
    CHECK (shipping_weight_kg IS NULL OR shipping_weight_kg >= 0),
  ADD CONSTRAINT orders_shipping_snapshot_quoted_nonnegative
    CHECK (shipping_quoted_total IS NULL OR shipping_quoted_total >= 0),
  ADD CONSTRAINT orders_shipping_snapshot_charged_nonnegative
    CHECK (shipping_charged_total IS NULL OR shipping_charged_total >= 0);