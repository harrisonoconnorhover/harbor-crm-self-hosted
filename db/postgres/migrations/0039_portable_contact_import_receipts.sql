CREATE TABLE "portable_contact_import_receipts" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_contact_import_receipts_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "portable_contact_import_receipts" ADD CONSTRAINT "portable_contact_import_receipts_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;