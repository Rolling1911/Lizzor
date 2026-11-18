DROP INDEX IF EXISTS "notifications_event_recipient_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_event_user_unique"
  ON "notifications" ("event_key","user_id")
  WHERE "event_key" IS NOT NULL AND "user_id" IS NOT NULL AND "company_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_event_company_unique"
  ON "notifications" ("event_key","company_id")
  WHERE "event_key" IS NOT NULL AND "company_id" IS NOT NULL AND "user_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_event_user_company_unique"
  ON "notifications" ("event_key","user_id","company_id")
  WHERE "event_key" IS NOT NULL AND "user_id" IS NOT NULL AND "company_id" IS NOT NULL;