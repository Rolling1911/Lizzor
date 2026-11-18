CREATE TABLE "media_cleanup_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "url" text NOT NULL,
  "reason" varchar(100) NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_cleanup_jobs_url_unique" UNIQUE("url"),
  CONSTRAINT "media_cleanup_jobs_status_check" CHECK ("status" IN ('pending','processing','failed','completed')),
  CONSTRAINT "media_cleanup_jobs_attempts_nonnegative" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "media_cleanup_jobs_due_idx" ON "media_cleanup_jobs" ("status","next_attempt_at");