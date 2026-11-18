ALTER TABLE "portable_tasks" ADD COLUMN "repeat_retry_revision" integer;--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD COLUMN "repeat_retry_at" timestamp with time zone;