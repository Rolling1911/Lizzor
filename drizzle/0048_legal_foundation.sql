CREATE TABLE IF NOT EXISTS "legal_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "canonical_key" varchar(80) NOT NULL UNIQUE,
  "public_route" varchar(180) NOT NULL UNIQUE,
  "title" varchar(250) NOT NULL,
  "language" varchar(12) NOT NULL DEFAULT 'en',
  "current_published_version_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_document_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL REFERENCES "legal_documents"("id") ON DELETE CASCADE,
  "version_number" integer NOT NULL,
  "language" varchar(12) NOT NULL DEFAULT 'en',
  "title" varchar(250) NOT NULL,
  "body_json" jsonb NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'draft',
  "effective_at" timestamptz,
  "published_at" timestamptz,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "published_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "legal_document_versions_status_valid" CHECK ("status" IN ('draft','published','archived')),
  CONSTRAINT "legal_document_versions_number_unique" UNIQUE ("document_id","language","version_number")
);
--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_current_version_fk" FOREIGN KEY ("current_published_version_id") REFERENCES "legal_document_versions"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_document_versions_document_idx" ON "legal_document_versions" ("document_id","language","version_number");
--> statement-breakpoint
INSERT INTO "legal_documents" ("canonical_key","public_route","title") VALUES
 ('privacy-policy','/privacy','Privacy Policy'),
 ('terms-of-use','/terms','Terms of Use'),
 ('consumer-terms-of-sale','/terms-of-sale','Consumer Terms of Sale'),
 ('business-terms-of-sale','/business-terms','Business Terms of Sale'),
 ('shipping-delivery-policy','/shipping-delivery','Shipping and Delivery Policy'),
 ('returns-refunds-cancellation-policy','/returns-refunds','Returns, Refunds and Cancellation Policy'),
 ('cookie-policy','/cookies','Cookie Policy'),
 ('company-contact-information','/company-information','Company and Contact Information'),
 ('account-data-deletion-information','/account-deletion','Account and Data Deletion Information'),
 ('consumer-withdrawal-information','/withdrawal-rights','Consumer Withdrawal Information')
ON CONFLICT ("canonical_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_permissions" ("permission_key","description") VALUES
 ('legal.view','View legal readiness and legal drafts'),
 ('legal.manage','Manage legal profile, document drafts, and publication')
ON CONFLICT ("permission_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_role_permissions" ("role_id","permission_id")
SELECT r."id",p."id" FROM "admin_roles" r CROSS JOIN "admin_permissions" p
WHERE r."system_key"='super_admin' AND p."permission_key" IN ('legal.view','legal.manage')
ON CONFLICT ("role_id","permission_id") DO NOTHING;