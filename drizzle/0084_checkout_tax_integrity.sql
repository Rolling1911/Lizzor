ALTER TABLE products
  ADD COLUMN IF NOT EXISTS tax_mode varchar(16) NOT NULL DEFAULT 'inclusive';

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_tax_mode_valid;
ALTER TABLE products
  ADD CONSTRAINT products_tax_mode_valid CHECK (tax_mode IN ('inclusive','exclusive'));

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS tax_mode_snapshot varchar(16) NOT NULL DEFAULT 'inclusive';
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS vat_classified_at_snapshot timestamptz;

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_tax_mode_valid;
ALTER TABLE order_items
  ADD CONSTRAINT order_items_tax_mode_valid CHECK (tax_mode_snapshot IN ('inclusive','exclusive'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS total_fingerprint varchar(64);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS order_total_fingerprint varchar(64);