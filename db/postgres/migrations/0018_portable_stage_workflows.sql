CREATE TABLE "portable_workflow_activations" (
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	CONSTRAINT "portable_workflow_activations_workspace_id_workflow_id_pk" PRIMARY KEY("workspace_id","workflow_id")
);
--> statement-breakpoint
CREATE TABLE "portable_workflow_runs" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_revision" integer NOT NULL,
	"workflow_name" text NOT NULL,
	"deal_id" uuid NOT NULL,
	"deal_revision" integer NOT NULL,
	"job_id" uuid,
	"issue" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "portable_workflow_runs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_workflow_trigger_receipt" UNIQUE("workspace_id","workflow_id","deal_id","deal_revision")
);
--> statement-breakpoint
CREATE TABLE "portable_deal_workflows" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "portable_deal_workflows_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portable_workflow_activations" ADD CONSTRAINT "portable_workflow_activations_workspace_id_workflow_id_portable_deal_workflows_workspace_id_id_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "public"."portable_deal_workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_runs_workspace_id_workflow_id_portable_deal_workflows_workspace_id_id_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "public"."portable_deal_workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_runs_workspace_id_deal_id_deal_revision_deal_events_workspace_id_deal_id_revision_fk" FOREIGN KEY ("workspace_id","deal_id","deal_revision") REFERENCES "public"."deal_events"("workspace_id","deal_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_runs_workspace_id_job_id_portable_jobs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_deal_workflows" ADD CONSTRAINT "portable_deal_workflows_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_workflow_runs_by_time" ON "portable_workflow_runs" USING btree ("workspace_id","created_at","id");