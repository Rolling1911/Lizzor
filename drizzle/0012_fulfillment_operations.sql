ALTER TABLE "orders" ADD COLUMN "fulfillment_stage" varchar(30) DEFAULT 'unfulfilled' NOT NULL;
CREATE INDEX "orders_fulfillment_stage_idx" ON "orders" ("fulfillment_stage","created_at");

ALTER TYPE "return_status" ADD VALUE IF NOT EXISTS 'in_review';
ALTER TABLE "return_requests" ADD COLUMN "reviewed_at" timestamptz;
ALTER TABLE "return_requests" ADD COLUMN "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "return_requests" ADD COLUMN "received_at" timestamptz;
ALTER TABLE "return_requests" ADD COLUMN "received_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "return_items" ADD COLUMN "approved_quantity" integer DEFAULT 0 NOT NULL;
ALTER TABLE "return_items" ADD COLUMN "received_quantity" integer DEFAULT 0 NOT NULL;
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_approved_quantity_valid" CHECK ("approved_quantity" >= 0 AND "approved_quantity" <= "quantity");
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_received_quantity_valid" CHECK ("received_quantity" >= 0 AND "received_quantity" <= "approved_quantity");

CREATE TABLE "shipment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shipment_id" uuid NOT NULL REFERENCES "shipments"("id") ON DELETE CASCADE,
  "status" "shipment_status" NOT NULL,
  "note" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "shipment_events_shipment_idx" ON "shipment_events" ("shipment_id","created_at");
CREATE INDEX "shipment_events_status_idx" ON "shipment_events" ("status","created_at");

CREATE TABLE "return_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "return_request_id" uuid NOT NULL REFERENCES "return_requests"("id") ON DELETE CASCADE,
  "filename" varchar(255) NOT NULL,
  "mime_type" varchar(120) NOT NULL,
  "size_bytes" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "return_attachments_size_positive" CHECK ("size_bytes" > 0 AND "size_bytes" <= 5242880)
);
CREATE INDEX "return_attachments_request_idx" ON "return_attachments" ("return_request_id","created_at");

INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('fulfillment.view', 'View fulfillment queues and shipment tracking'),
  ('fulfillment.manage', 'Manage fulfillment stages and shipments'),
  ('shipping.manage', 'Manage shipping zones and rules'),
  ('returns.manage', 'Review returns and receive returned stock')
ON CONFLICT ("permission_key") DO NOTHING;
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "admin_roles" r CROSS JOIN "admin_permissions" p
WHERE r."name" = 'Super Admin' AND p."permission_key" IN ('fulfillment.view','fulfillment.manage','shipping.manage','returns.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;