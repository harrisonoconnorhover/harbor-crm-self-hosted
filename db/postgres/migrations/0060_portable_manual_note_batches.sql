CREATE TABLE "portable_manual_workflow_batches" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_revision" integer NOT NULL,
	"workflow_name" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "portable_manual_workflow_batches_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portable_manual_workflow_runs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_manual_workflow_batches" ADD CONSTRAINT "portable_manual_workflow_batch_definition_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "public"."portable_deal_workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_manual_workflow_runs" ADD CONSTRAINT "portable_manual_workflow_run_batch_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."portable_manual_workflow_batches"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_manual_workflow_batch_contact" ON "portable_manual_workflow_runs" USING btree ("workspace_id","batch_id","contact_id") WHERE "portable_manual_workflow_runs"."batch_id" IS NOT NULL;