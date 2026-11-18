CREATE TABLE "admin_two_factor_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "token_hash" varchar(128) NOT NULL,
  "ip_hash" varchar(128) NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "admin_two_factor_challenges_attempts_valid" CHECK ("attempts" >= 0 AND "attempts" <= 5)
);
--> statement-breakpoint
ALTER TABLE "admin_two_factor_challenges" ADD CONSTRAINT "admin_two_factor_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_two_factor_challenges_token_hash_unique" ON "admin_two_factor_challenges" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "admin_two_factor_challenges_user_expiry_idx" ON "admin_two_factor_challenges" USING btree ("user_id","expires_at");
--> statement-breakpoint
CREATE INDEX "admin_two_factor_challenges_expiry_idx" ON "admin_two_factor_challenges" USING btree ("expires_at");