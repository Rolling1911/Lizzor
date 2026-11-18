ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "related_order_id" uuid REFERENCES "orders"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_session_reads" (
  "session_id" uuid NOT NULL REFERENCES "chat_sessions"("id") ON DELETE CASCADE,
  "admin_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "last_read_at" timestamptz NOT NULL,
  PRIMARY KEY ("session_id","admin_user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_session_reads_admin_idx" ON "chat_session_reads" ("admin_user_id","last_read_at");
--> statement-breakpoint
CREATE TEMP TABLE "chat_session_dedup" AS
WITH ranked AS (
  SELECT id,
    FIRST_VALUE(id) OVER (PARTITION BY user_id ORDER BY created_at ASC,id ASC) AS keep_id
  FROM "chat_sessions"
  WHERE status='open' AND user_id IS NOT NULL
  UNION ALL
  SELECT id,
    FIRST_VALUE(id) OVER (PARTITION BY guest_session_id ORDER BY created_at ASC,id ASC) AS keep_id
  FROM "chat_sessions"
  WHERE status='open' AND guest_session_id IS NOT NULL
),
duplicates AS (
  SELECT id,keep_id
  FROM ranked
  WHERE id <> keep_id
)
SELECT id AS duplicate_id,keep_id FROM duplicates;
--> statement-breakpoint
UPDATE "chat_messages" m SET "session_id"=d.keep_id
FROM "chat_session_dedup" d WHERE m."session_id"=d.duplicate_id;
--> statement-breakpoint
UPDATE "chat_sessions" s SET "status"='closed',"updated_at"=now()
FROM "chat_session_dedup" d WHERE s."id"=d.duplicate_id;
--> statement-breakpoint
DROP TABLE "chat_session_dedup";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_sessions_open_user_unique" ON "chat_sessions" ("user_id") WHERE "status"='open' AND "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_sessions_open_guest_unique" ON "chat_sessions" ("guest_session_id") WHERE "status"='open' AND "guest_session_id" IS NOT NULL;