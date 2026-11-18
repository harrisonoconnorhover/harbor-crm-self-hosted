CREATE TABLE "portable_manual_workflow_run_actions" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"action_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"delay_minutes" integer NOT NULL,
	"planned_job_id" uuid NOT NULL,
	"job_id" uuid,
	CONSTRAINT "portable_manual_workflow_run_actions_workspace_id_run_id_position_pk" PRIMARY KEY("workspace_id","run_id","position"),
	CONSTRAINT "portable_manual_action_id" UNIQUE("workspace_id","run_id","action_id"),
	CONSTRAINT "portable_manual_action_planned_job" UNIQUE("workspace_id","planned_job_id"),
	CONSTRAINT "portable_manual_action_job" UNIQUE("workspace_id","job_id"),
	CONSTRAINT "portable_manual_action_bounds" CHECK ("portable_manual_workflow_run_actions"."position" BETWEEN 0 AND 4 AND "portable_manual_workflow_run_actions"."delay_minutes" BETWEEN 0 AND 43200),
	CONSTRAINT "portable_manual_action_job_matches" CHECK ("portable_manual_workflow_run_actions"."job_id" IS NULL OR "portable_manual_workflow_run_actions"."job_id"="portable_manual_workflow_run_actions"."planned_job_id")
);
--> statement-breakpoint
ALTER TABLE "portable_manual_workflow_run_actions" ADD CONSTRAINT "portable_manual_action_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."portable_manual_workflow_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_manual_workflow_run_actions" ADD CONSTRAINT "portable_manual_action_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;