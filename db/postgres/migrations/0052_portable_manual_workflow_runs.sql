CREATE TABLE "portable_manual_workflow_runs" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_revision" integer NOT NULL,
	"workflow_name" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"contact_revision" integer NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "portable_manual_workflow_runs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portable_manual_workflow_runs" ADD CONSTRAINT "portable_manual_workflow_definition_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "public"."portable_deal_workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_manual_workflow_runs" ADD CONSTRAINT "portable_manual_workflow_contact_revision_fk" FOREIGN KEY ("workspace_id","contact_id","contact_revision") REFERENCES "public"."contact_events"("workspace_id","contact_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_manual_workflow_runs" ADD CONSTRAINT "portable_manual_workflow_job_fk" FOREIGN KEY ("workspace_id","id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_manual_workflow_runs_by_time" ON "portable_manual_workflow_runs" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "portable_manual_workflow_contact_history" ON "portable_manual_workflow_runs" USING btree ("workspace_id","workflow_id","contact_id");