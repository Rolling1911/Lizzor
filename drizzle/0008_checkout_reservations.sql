ALTER TABLE "cart_items" ADD COLUMN "last_quoted_unit_price" numeric(12, 2);
CREATE SEQUENCE "lizzor_order_number_seq" START WITH 100001;
ALTER TABLE "orders" ADD COLUMN "guest_session_id" varchar(200);
ALTER TABLE "orders" ADD COLUMN "guest_access_token_hash" varchar(128);
ALTER TABLE "orders" ADD COLUMN "idempotency_key" varchar(200);
CREATE INDEX "orders_guest_session_idx" ON "orders" USING btree ("guest_session_id");
CREATE UNIQUE INDEX "orders_idempotency_key_unique" ON "orders" USING btree ("idempotency_key");
CREATE TYPE "reservation_status" AS ENUM ('active', 'released', 'converted');
CREATE TABLE "inventory_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "inventory_id" uuid NOT NULL REFERENCES "inventory"("id") ON DELETE RESTRICT,
  "quantity" integer NOT NULL,
  "status" "reservation_status" NOT NULL DEFAULT 'active',
  "released_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_reservations_quantity_positive" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "inventory_reservations_order_inventory_unique" ON "inventory_reservations" ("order_id", "inventory_id");
CREATE INDEX "inventory_reservations_order_idx" ON "inventory_reservations" ("order_id", "status");
CREATE INDEX "inventory_reservations_inventory_idx" ON "inventory_reservations" ("inventory_id", "status");