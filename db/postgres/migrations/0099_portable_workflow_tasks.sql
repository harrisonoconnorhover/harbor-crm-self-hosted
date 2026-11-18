CREATE TABLE "portable_task_jobs" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "portable_task_jobs_workspace_id_job_id_pk" PRIMARY KEY("workspace_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "portable_jobs" DROP CONSTRAINT "portable_job_kind";--> statement-breakpoint
ALTER TABLE "portable_task_jobs" ADD CONSTRAINT "portable_task_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_job_kind" CHECK ("portable_jobs"."kind" IN ('note','external','gmail','code','task'));