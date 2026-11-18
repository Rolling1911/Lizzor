CREATE TABLE "fulfillment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "stage" varchar(30) NOT NULL,
  "note" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "fulfillment_events_order_idx" ON "fulfillment_events" ("order_id","created_at");

ALTER TABLE "return_attachments" ADD COLUMN "data" bytea;
UPDATE "return_attachments" SET "data" = ''::bytea WHERE "data" IS NULL;
ALTER TABLE "return_attachments" ALTER COLUMN "data" SET NOT NULL;