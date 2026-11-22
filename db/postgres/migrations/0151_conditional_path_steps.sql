CREATE TABLE "portable_workflow_path_steps" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"action_id" uuid NOT NULL,
	"planned_job_id" uuid NOT NULL,
	"job_id" uuid,
	"action" jsonb NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_revision" integer NOT NULL,
	"object_kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"record_revision" integer NOT NULL,
	CONSTRAINT "portable_workflow_path_steps_workspace_id_run_id_position_pk" PRIMARY KEY("workspace_id","run_id","position"),
	CONSTRAINT "portable_path_step_action" UNIQUE("workspace_id","run_id","action_id"),
	CONSTRAINT "portable_path_step_planned_job" UNIQUE("workspace_id","planned_job_id"),
	CONSTRAINT "portable_path_step_identity" CHECK ("portable_workflow_path_steps"."position" BETWEEN 0 AND 4
    AND ("portable_workflow_path_steps"."job_id" IS NULL OR "portable_workflow_path_steps"."job_id"="portable_workflow_path_steps"."planned_job_id")
    AND ("portable_workflow_path_steps"."position">0 OR ("portable_workflow_path_steps"."job_id" IS NOT NULL AND "portable_workflow_path_steps"."job_id"="portable_workflow_path_steps"."run_id"))),
	CONSTRAINT "portable_path_step_action_shape" CHECK (jsonb_typeof("portable_workflow_path_steps"."action")='object' AND "portable_workflow_path_steps"."action" ? 'kind'
    AND ("portable_workflow_path_steps"."action"->>'kind') IS NOT NULL AND "portable_workflow_path_steps"."action"->>'kind' IN ('note','task','webhook')),
	CONSTRAINT "portable_path_step_source" CHECK ("portable_workflow_path_steps"."workflow_revision">0 AND "portable_workflow_path_steps"."record_revision">0 AND "portable_workflow_path_steps"."object_kind" IN ('contacts','deals','tickets'))
);
--> statement-breakpoint
ALTER TABLE "portable_workflow_path_steps" ADD CONSTRAINT "portable_path_step_root" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."portable_workflow_path_receipts"("workspace_id","job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_path_steps" ADD CONSTRAINT "portable_path_step_job" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_path_steps" ADD CONSTRAINT "portable_path_step_workflow" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "public"."portable_deal_workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;