CREATE TABLE IF NOT EXISTS "guest_order_claims" (
 "order_id" uuid PRIMARY KEY NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
 "claimed_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
 "guest_session_id" varchar(200) NOT NULL,
 "guest_access_token_hash" varchar(128) NOT NULL,
 "claimed_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "guest_order_claims_user_idx" ON "guest_order_claims" ("claimed_by_user_id");