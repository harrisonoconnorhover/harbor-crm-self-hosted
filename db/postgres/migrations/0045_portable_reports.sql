CREATE TABLE "portable_reports" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_reports_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_reports_positive_revision" CHECK ("portable_reports"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "portable_reports" ADD CONSTRAINT "portable_reports_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;