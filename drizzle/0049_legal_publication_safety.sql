CREATE UNIQUE INDEX IF NOT EXISTS "legal_document_versions_one_published_per_language"
  ON "legal_document_versions" ("document_id","language") WHERE "status"='published';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_document_publications" (
  "document_id" uuid NOT NULL REFERENCES "legal_documents"("id") ON DELETE CASCADE,
  "language" varchar(12) NOT NULL DEFAULT 'en',
  "version_id" uuid NOT NULL REFERENCES "legal_document_versions"("id") ON DELETE RESTRICT,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("document_id","language"),
  CONSTRAINT "legal_document_publications_version_unique" UNIQUE ("version_id")
);
--> statement-breakpoint
INSERT INTO "legal_document_publications" ("document_id","language","version_id","published_at","updated_at")
SELECT d."id",'en',d."current_published_version_id",COALESCE(v."published_at",now()),now()
FROM "legal_documents" d JOIN "legal_document_versions" v ON v."id"=d."current_published_version_id"
WHERE d."current_published_version_id" IS NOT NULL
ON CONFLICT ("document_id","language") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN IF NOT EXISTS "content_reviewed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN IF NOT EXISTS "content_reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN IF NOT EXISTS "profile_applicability_verified_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN IF NOT EXISTS "profile_applicability_verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;