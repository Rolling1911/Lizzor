CREATE TABLE IF NOT EXISTS "content_page_preview_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "page_id" uuid NOT NULL REFERENCES "content_pages"("id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
  "page_updated_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_page_preview_receipts_lookup_idx"
  ON "content_page_preview_receipts" ("page_id","actor_id","session_id","expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_page_preview_receipts_expiry_idx"
  ON "content_page_preview_receipts" ("expires_at");