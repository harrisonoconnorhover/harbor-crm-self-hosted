CREATE TABLE "portable_segment_workflow_members" (
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"epoch" uuid NOT NULL,
	CONSTRAINT "portable_segment_workflow_members_workspace_id_workflow_id_contact_id_pk" PRIMARY KEY("workspace_id","workflow_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "portable_segment_workflow_scans" (
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"workflow_revision" integer NOT NULL,
	"segment_revision" integer NOT NULL,
	"epoch" uuid NOT NULL,
	"cursor" uuid,
	"baseline" boolean DEFAULT true NOT NULL,
	"next_at" bigint,
	"waiting_for_capacity" boolean DEFAULT false NOT NULL,
	CONSTRAINT "portable_segment_workflow_scans_workspace_id_workflow_id_pk" PRIMARY KEY("workspace_id","workflow_id")
);
--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD COLUMN "segment_criteria" jsonb;--> statement-breakpoint
ALTER TABLE "portable_segment_workflow_members" ADD CONSTRAINT "portable_segment_member_scan_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "public"."portable_segment_workflow_scans"("workspace_id","workflow_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_segment_workflow_scans" ADD CONSTRAINT "portable_segment_scan_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "public"."portable_deal_workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_segment_scans_due" ON "portable_segment_workflow_scans" USING btree ("next_at","workspace_id","workflow_id");