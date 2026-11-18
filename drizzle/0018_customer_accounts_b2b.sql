DO $$ BEGIN
 CREATE TYPE "company_status" AS ENUM ('pending', 'active', 'suspended', 'deactivated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
 CREATE TYPE "company_membership_role" AS ENUM ('owner', 'admin', 'buyer', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
 CREATE TYPE "company_membership_status" AS ENUM ('active', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "status" "company_status" DEFAULT 'active' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "active_company_id" uuid;
ALTER TABLE "company_users" ADD COLUMN IF NOT EXISTS "role" "company_membership_role" DEFAULT 'buyer' NOT NULL;
ALTER TABLE "company_users" ADD COLUMN IF NOT EXISTS "status" "company_membership_status" DEFAULT 'active' NOT NULL;
UPDATE "company_users" SET "role" = CASE lower(coalesce("company_role", ''))
  WHEN 'owner' THEN 'owner'::company_membership_role
  WHEN 'admin' THEN 'admin'::company_membership_role
  WHEN 'viewer' THEN 'viewer'::company_membership_role
  ELSE 'buyer'::company_membership_role END;
UPDATE "users" u SET "active_company_id" = (
 SELECT cu.company_id FROM company_users cu JOIN companies c ON c.id=cu.company_id WHERE cu.user_id=u.id AND cu.status='active' AND c.status='active' ORDER BY cu.created_at LIMIT 1
) WHERE u.active_company_id IS NULL;
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_active_company_id_companies_id_fk";
ALTER TABLE "users" ADD CONSTRAINT "users_active_company_id_companies_id_fk" FOREIGN KEY ("active_company_id") REFERENCES "companies"("id") ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS "company_invitations" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
 "email" varchar(320) NOT NULL,
 "role" "company_membership_role" DEFAULT 'buyer' NOT NULL,
 "token_hash" varchar(128) NOT NULL,
 "invited_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
 "expires_at" timestamptz NOT NULL,
 "accepted_at" timestamptz,
 "revoked_at" timestamptz,
 "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "company_invitations_token_hash_unique" ON "company_invitations" ("token_hash");
CREATE INDEX IF NOT EXISTS "company_invitations_company_idx" ON "company_invitations" ("company_id","expires_at");
CREATE INDEX IF NOT EXISTS "company_invitations_email_idx" ON "company_invitations" ("email");
CREATE TABLE IF NOT EXISTS "guest_order_claims" (
 "order_id" uuid PRIMARY KEY NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
 "claimed_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
 "guest_session_id" varchar(200) NOT NULL,
 "guest_access_token_hash" varchar(128) NOT NULL,
 "claimed_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "guest_order_claims_user_idx" ON "guest_order_claims" ("claimed_by_user_id");
WITH ranked AS (
 SELECT id, row_number() OVER (PARTITION BY user_id,type ORDER BY created_at,id) AS n
 FROM addresses WHERE user_id IS NOT NULL AND is_default
) UPDATE addresses a SET is_default=false FROM ranked r WHERE a.id=r.id AND r.n>1;
WITH ranked AS (
 SELECT id, row_number() OVER (PARTITION BY company_id,type ORDER BY created_at,id) AS n
 FROM addresses WHERE company_id IS NOT NULL AND is_default
) UPDATE addresses a SET is_default=false FROM ranked r WHERE a.id=r.id AND r.n>1;
CREATE UNIQUE INDEX IF NOT EXISTS "addresses_user_default_type_unique" ON "addresses" ("user_id","type") WHERE "is_default" AND "user_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "addresses_company_default_type_unique" ON "addresses" ("company_id","type") WHERE "is_default" AND "company_id" IS NOT NULL;
INSERT INTO admin_permissions (permission_key) VALUES ('customers.manage'), ('companies.manage') ON CONFLICT (permission_key) DO NOTHING;
INSERT INTO admin_role_permissions (role_id, permission_id)
 SELECT r.id,p.id FROM admin_roles r CROSS JOIN admin_permissions p
 WHERE r.name='Super Admin' AND p.permission_key IN ('customers.manage','companies.manage')
 ON CONFLICT DO NOTHING;