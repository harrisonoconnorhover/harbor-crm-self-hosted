CREATE TABLE "portable_workflow_webhook_jobs" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_revision" integer NOT NULL,
	"path_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"object_kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"record_revision" integer NOT NULL,
	CONSTRAINT "portable_workflow_webhook_jobs_workspace_id_job_id_pk" PRIMARY KEY("workspace_id","job_id"),
	CONSTRAINT "workflow_webhook_record" CHECK ("portable_workflow_webhook_jobs"."object_kind" IN ('contacts','deals') AND "portable_workflow_webhook_jobs"."record_revision">0 AND "portable_workflow_webhook_jobs"."workflow_revision">0),
	CONSTRAINT "workflow_webhook_destination" CHECK (length(btrim("portable_workflow_webhook_jobs"."destination")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "portable_jobs" DROP CONSTRAINT "portable_job_event_wait";--> statement-breakpoint
ALTER TABLE "portable_workflow_webhook_jobs" ADD CONSTRAINT "workflow_webhook_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_workflow_path_receipts"("workspace_id","job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_webhook_jobs" ADD CONSTRAINT "workflow_webhook_definition_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "public"."portable_deal_workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_job_event_wait" CHECK ("portable_jobs"."wait_for_lifecycle" IS NULL OR (
    ("portable_jobs"."status" IN ('queued','skipped') AND "portable_jobs"."kind" IN ('note','task','external') OR
     "portable_jobs"."kind"='external' AND "portable_jobs"."status"='attention' AND "portable_jobs"."issue" IS NOT DISTINCT FROM 'restore_requires_reconciliation') AND "portable_jobs"."attempts"=0
    AND "portable_jobs"."wait_for_lifecycle" IN ('Subscriber','Lead','Marketing qualified lead','Sales qualified lead','Opportunity','Customer','Evangelist','Other')));