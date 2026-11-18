CREATE TABLE "portable_activity_creation_receipts" (
	"workspace_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "portable_activity_creation_receipts_workspace_id_namespace_id_pk" PRIMARY KEY("workspace_id","namespace","id"),
	CONSTRAINT "portable_activity_receipt_namespace" CHECK ("portable_activity_creation_receipts"."namespace" IN ('contact','record'))
);
--> statement-breakpoint
ALTER TABLE "portable_contact_activities" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_record_activities" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_activity_creation_receipts" ADD CONSTRAINT "portable_activity_creation_receipts_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;