ALTER TABLE "admin_roles" ADD COLUMN "staff_assignable" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_super_admin_not_staff_assignable" CHECK ("system_key" IS DISTINCT FROM 'super_admin' OR "staff_assignable" = false);
--> statement-breakpoint
CREATE INDEX "admin_roles_staff_assignable_idx" ON "admin_roles" USING btree ("staff_assignable");