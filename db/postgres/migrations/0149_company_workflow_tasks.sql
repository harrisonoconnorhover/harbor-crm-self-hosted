ALTER TABLE "portable_workflow_runs" DROP CONSTRAINT "portable_workflow_run_source";--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "company_revision" integer;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "company_task_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_run_company_revision_fk" FOREIGN KEY ("workspace_id","company_id","company_revision") REFERENCES "public"."company_events"("workspace_id","company_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_run_company_task_fk" FOREIGN KEY ("workspace_id","company_task_id") REFERENCES "public"."portable_tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_workflow_company_history" ON "portable_workflow_runs" USING btree ("workspace_id","company_id","created_at","id") WHERE "portable_workflow_runs"."company_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_company_creation_receipt" UNIQUE("workspace_id","workflow_id","company_id");--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_company_task" CHECK (
    (("portable_workflow_runs"."company_id" IS NULL) = ("portable_workflow_runs"."company_task_id" IS NULL))
    AND ("portable_workflow_runs"."company_id" IS NULL OR ("portable_workflow_runs"."company_revision"=1 AND "portable_workflow_runs"."job_id" IS NULL AND "portable_workflow_runs"."issue" IS NULL))
  );--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_run_source" CHECK (
    num_nonnulls("portable_workflow_runs"."deal_id","portable_workflow_runs"."contact_id","portable_workflow_runs"."ticket_id","portable_workflow_runs"."company_id") = 1
    AND (("portable_workflow_runs"."company_id" IS NULL) = ("portable_workflow_runs"."company_revision" IS NULL))
    AND (("portable_workflow_runs"."deal_id" IS NULL) = ("portable_workflow_runs"."deal_revision" IS NULL))
    AND (("portable_workflow_runs"."contact_id" IS NULL) = ("portable_workflow_runs"."contact_revision" IS NULL))
    AND (("portable_workflow_runs"."ticket_id" IS NULL) = ("portable_workflow_runs"."ticket_revision" IS NULL))
  );