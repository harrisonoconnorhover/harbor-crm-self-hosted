CREATE TABLE "portable_scheduled_gmail" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"sender" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"dispatch_started_at" bigint,
	"provider_id" text,
	CONSTRAINT "portable_scheduled_gmail_workspace_id_job_id_pk" PRIMARY KEY("workspace_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "portable_jobs" DROP CONSTRAINT "portable_job_kind";--> statement-breakpoint
ALTER TABLE "portable_scheduled_gmail" ADD CONSTRAINT "portable_scheduled_gmail_workspace_id_job_id_portable_jobs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_job_kind" CHECK ("portable_jobs"."kind" IN ('note','external','gmail'));