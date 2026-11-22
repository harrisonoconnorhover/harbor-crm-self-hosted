ALTER TABLE "portable_workflow_runs" DROP CONSTRAINT "portable_workflow_run_source";--> statement-breakpoint
ALTER TABLE "portable_workflow_webhook_jobs" DROP CONSTRAINT "workflow_webhook_record";--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD COLUMN "ticket_revision" integer;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_run_ticket_revision_fk" FOREIGN KEY ("workspace_id","ticket_id","ticket_revision") REFERENCES "public"."portable_ticket_events"("workspace_id","ticket_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_ticket_receipt" UNIQUE("workspace_id","workflow_id","ticket_id","ticket_revision");--> statement-breakpoint
ALTER TABLE "portable_workflow_runs" ADD CONSTRAINT "portable_workflow_run_source" CHECK (
    num_nonnulls("portable_workflow_runs"."deal_id","portable_workflow_runs"."contact_id","portable_workflow_runs"."ticket_id") = 1
    AND (("portable_workflow_runs"."deal_id" IS NULL) = ("portable_workflow_runs"."deal_revision" IS NULL))
    AND (("portable_workflow_runs"."contact_id" IS NULL) = ("portable_workflow_runs"."contact_revision" IS NULL))
    AND (("portable_workflow_runs"."ticket_id" IS NULL) = ("portable_workflow_runs"."ticket_revision" IS NULL))
  );--> statement-breakpoint
ALTER TABLE "portable_workflow_webhook_jobs" ADD CONSTRAINT "workflow_webhook_record" CHECK ("portable_workflow_webhook_jobs"."object_kind" IN ('contacts','deals','tickets') AND "portable_workflow_webhook_jobs"."record_revision">0 AND "portable_workflow_webhook_jobs"."workflow_revision">0);--> statement-breakpoint
CREATE INDEX "portable_workflow_ticket_history" ON "portable_workflow_runs" USING btree ("workspace_id","ticket_id","created_at","id") WHERE "portable_workflow_runs"."ticket_id" IS NOT NULL;