ALTER TABLE "portable_jobs" ADD COLUMN "operator_retry_at" bigint;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD COLUMN "operator_retry_by" text;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_jobs_operator_retry_by_login_identities_id_fk" FOREIGN KEY ("operator_retry_by") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;