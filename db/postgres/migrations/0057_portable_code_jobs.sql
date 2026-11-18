CREATE TABLE "portable_code_jobs" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	CONSTRAINT "portable_code_jobs_workspace_id_job_id_pk" PRIMARY KEY("workspace_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "portable_jobs" DROP CONSTRAINT "portable_job_kind";--> statement-breakpoint
ALTER TABLE "portable_code_jobs" ADD CONSTRAINT "portable_code_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_job_kind" CHECK ("portable_jobs"."kind" IN ('note','external','gmail','code'));