CREATE TABLE IF NOT EXISTS "admin_operation_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_type" varchar(100) NOT NULL,
  "entity_id" uuid NOT NULL,
  "body" text NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "admin_operation_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict,
  CONSTRAINT "admin_operation_notes_body_nonempty" CHECK (length(trim("body")) > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_operation_notes_entity_idx" ON "admin_operation_notes" USING btree ("entity_type","entity_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_operation_notes_author_idx" ON "admin_operation_notes" USING btree ("created_by","created_at");
--> statement-breakpoint
INSERT INTO "admin_permissions" ("permission_key", "description") VALUES
  ('operations.view', 'View operational queues and timelines'),
  ('operations.manage', 'Add internal notes and run operational checks')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "admin_roles" r
CROSS JOIN "admin_permissions" p
WHERE r."name" = 'Super Admin' AND p."permission_key" IN ('operations.view', 'operations.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;