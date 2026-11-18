CREATE TABLE "guest_order_email_access_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" uuid NOT NULL REFERENCES "notification_deliveries"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "token_hash" varchar(128) NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "guest_order_email_access_delivery_unique" UNIQUE("delivery_id"),
  CONSTRAINT "guest_order_email_access_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "guest_order_email_access_order_expiry_idx"
  ON "guest_order_email_access_tokens" ("order_id", "expires_at");