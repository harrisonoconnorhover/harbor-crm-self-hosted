ALTER TABLE "portable_workflow_runs" DROP CONSTRAINT "portable_workflow_run_source";--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "custom_object_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "custom_record_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "custom_record_name" text;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "custom_object_name" text;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "custom_task_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_custom_record_fk" FOREIGN KEY ("workspace_id","custom_object_id","custom_record_id") REFERENCES "public"."portable_object_records"("workspace_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_custom_task_fk" FOREIGN KEY ("workspace_id","custom_task_id") REFERENCES "public"."portable_tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_workflow_custom_history" ON "portable_workflow_runs" USING btree ("workspace_id","custom_object_id","custom_record_id","created_at","id") WHERE "portable_workflow_runs"."custom_record_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_custom_creation_receipt" UNIQUE("workspace_id","workflow_id","custom_object_id","custom_record_id");--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_custom_task" CHECK (
    num_nonnulls("portable_workflow_runs"."custom_object_id","portable_workflow_runs"."custom_record_id","portable_workflow_runs"."custom_task_id","portable_workflow_runs"."custom_object_name","portable_workflow_runs"."custom_record_name") IN (0,5)
    AND ("portable_workflow_runs"."custom_record_id" IS NULL OR ("portable_workflow_runs"."custom_task_id"="portable_workflow_runs"."id" AND "portable_workflow_runs"."job_id" IS NULL AND "portable_workflow_runs"."issue" IS NULL
      AND length("portable_workflow_runs"."custom_record_name") BETWEEN 1 AND 100 AND length("portable_workflow_runs"."custom_object_name") BETWEEN 1 AND 100))
  );--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_run_source" CHECK (
    num_nonnulls("portable_workflow_runs"."deal_id","portable_workflow_runs"."contact_id","portable_workflow_runs"."ticket_id","portable_workflow_runs"."company_id","portable_workflow_runs"."custom_record_id") = 1
    AND (("portable_workflow_runs"."company_id" IS NULL) = ("portable_workflow_runs"."company_revision" IS NULL))
    AND (("portable_workflow_runs"."deal_id" IS NULL) = ("portable_workflow_runs"."deal_revision" IS NULL))
    AND (("portable_workflow_runs"."contact_id" IS NULL) = ("portable_workflow_runs"."contact_revision" IS NULL))
    AND (("portable_workflow_runs"."ticket_id" IS NULL) = ("portable_workflow_runs"."ticket_revision" IS NULL))
  );