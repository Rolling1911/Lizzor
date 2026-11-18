ALTER TABLE "legal_documents" ADD COLUMN "audience" varchar(8) DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN "website_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN "app_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN "pdf_storage_key" text;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN "pdf_original_filename" varchar(255);--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN "pdf_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN "pdf_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN "pdf_uploaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN "pdf_uploaded_by" uuid;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_audience_valid" CHECK ("legal_documents"."audience" IN ('b2c', 'b2b', 'both'));--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD CONSTRAINT "legal_document_versions_pdf_size_valid" CHECK ("legal_document_versions"."pdf_size_bytes" IS NULL OR "legal_document_versions"."pdf_size_bytes" > 0);--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD CONSTRAINT "legal_document_versions_pdf_uploaded_by_users_id_fk" FOREIGN KEY ("pdf_uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;