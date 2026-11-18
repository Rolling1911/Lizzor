ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "priority" varchar(20) NOT NULL DEFAULT 'normal';
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "assigned_admin_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN IF NOT EXISTS "is_internal" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "assigned_admin_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "last_read_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "is_internal" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_assignee_idx" ON "support_tickets" ("assigned_admin_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_sessions_assignee_idx" ON "chat_sessions" ("assigned_admin_id","created_at");
--> statement-breakpoint
INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('support.manage', 'Update tickets and send support responses'),
  ('chat.manage', 'Assign, reply to, and close live chats')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id","permission_id")
SELECT r."id",p."id" FROM "admin_roles" r CROSS JOIN "admin_permissions" p
WHERE r."system_key"='super_admin' AND p."permission_key" IN ('support.manage','chat.manage')
ON CONFLICT ("role_id","permission_id") DO NOTHING;