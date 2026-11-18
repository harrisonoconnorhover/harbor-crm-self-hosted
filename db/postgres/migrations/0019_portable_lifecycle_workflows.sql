ALTER TABLE "portable_jobs" DROP CONSTRAINT "portable_job_status";--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ALTER COLUMN "deal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ALTER COLUMN "deal_revision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD COLUMN "segment_entry_revision" integer;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "contact_revision" integer;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_jobs_workspace_id_contact_id_segment_entry_revision_contact_events_workspace_id_contact_id_revision_fk" FOREIGN KEY ("workspace_id","contact_id","segment_entry_revision") REFERENCES "public"."contact_events"("workspace_id","contact_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_runs_workspace_id_contact_id_contact_revision_contact_events_workspace_id_contact_id_revision_fk" FOREIGN KEY ("workspace_id","contact_id","contact_revision") REFERENCES "public"."contact_events"("workspace_id","contact_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_contact_receipt" UNIQUE("workspace_id","workflow_id","contact_id","contact_revision");--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_job_status" CHECK ("portable_jobs"."status" IN ('queued','running','dispatching','succeeded','attention','failed','skipped'));--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_run_source" CHECK (
    ("portable_workflow_runs"."deal_id" IS NOT NULL AND "portable_workflow_runs"."deal_revision" IS NOT NULL AND "portable_workflow_runs"."contact_id" IS NULL AND "portable_workflow_runs"."contact_revision" IS NULL)
    OR ("portable_workflow_runs"."deal_id" IS NULL AND "portable_workflow_runs"."deal_revision" IS NULL AND "portable_workflow_runs"."contact_id" IS NOT NULL AND "portable_workflow_runs"."contact_revision" IS NOT NULL)
  );