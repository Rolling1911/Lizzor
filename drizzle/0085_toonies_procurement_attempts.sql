CREATE TABLE IF NOT EXISTS toonies_procurement_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  actor_admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
  client_task_no varchar(64) NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  task_id varchar(32),
  state varchar(32) NOT NULL DEFAULT 'created',
  request_fingerprint varchar(64) NOT NULL,
  raw_snapshot jsonb,
  failure_code integer,
  failure_message varchar(1000),
  snapshot_expires_at timestamptz,
  next_poll_at timestamptz,
  poll_count integer NOT NULL DEFAULT 0,
  max_polls integer NOT NULL DEFAULT 30,
  retry_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  lease_until timestamptz,
  lease_token varchar(64),
  api_order_sn varchar(128),
  toonies_order_sn varchar(128),
  trade_order_sn varchar(128),
  settlement_status varchar(32),
  settled_cny_product_amount numeric(20,6),
  freight_status varchar(32),
  freight_amount_cny numeric(20,6),
  supplier_order_status varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT toonies_procurement_attempts_state_valid CHECK (state IN ('created','validating','precheck_pending','task_pending','ready','failed','expired','retry_wait')),
  CONSTRAINT toonies_procurement_attempts_poll_nonnegative CHECK (poll_count >= 0 AND max_polls > 0 AND retry_count >= 0 AND max_attempts > 0 AND generation > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS toonies_procurement_attempts_supplier_client_unique ON toonies_procurement_attempts(supplier_id, client_task_no);
CREATE UNIQUE INDEX IF NOT EXISTS toonies_procurement_attempts_supplier_fingerprint_generation_unique ON toonies_procurement_attempts(supplier_id, request_fingerprint, generation);
CREATE UNIQUE INDEX IF NOT EXISTS toonies_procurement_attempts_supplier_task_unique ON toonies_procurement_attempts(supplier_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS toonies_procurement_attempts_order_idx ON toonies_procurement_attempts(order_id, created_at);
CREATE INDEX IF NOT EXISTS toonies_procurement_attempts_poll_idx ON toonies_procurement_attempts(state, next_poll_at);

CREATE TABLE IF NOT EXISTS toonies_procurement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES toonies_procurement_attempts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES product_variants(id) ON DELETE RESTRICT,
  catalogue_item_id uuid NOT NULL REFERENCES supplier_catalogue_items(id) ON DELETE RESTRICT,
  catalogue_variant_id uuid REFERENCES supplier_catalogue_variants(id) ON DELETE RESTRICT,
  product_code varchar(255) NOT NULL,
  sku_code varchar(255) NOT NULL,
  requested_quantity integer NOT NULL,
  returned_quantity integer,
  returned_moq integer,
  returned_stock integer,
  returned_charge_cny numeric(20,6),
  returned_subtotal_cny numeric(20,6),
  returned_weight_kg numeric(20,6),
  orderable boolean,
  failure_code integer,
  failure_message varchar(1000),
  raw_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT toonies_procurement_lines_quantity_valid CHECK (requested_quantity > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS toonies_procurement_lines_attempt_product_sku_unique ON toonies_procurement_lines(attempt_id, product_code, sku_code);
CREATE INDEX IF NOT EXISTS toonies_procurement_lines_attempt_idx ON toonies_procurement_lines(attempt_id);

CREATE TABLE IF NOT EXISTS toonies_procurement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES toonies_procurement_attempts(id) ON DELETE CASCADE,
  actor_admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
  from_state varchar(32),
  to_state varchar(32) NOT NULL,
  event_type varchar(64) NOT NULL,
  error_code integer,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS toonies_procurement_events_attempt_idx ON toonies_procurement_events(attempt_id, created_at);