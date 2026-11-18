CREATE TABLE "portable_dashboards" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_dashboards_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_dashboards_positive_revision" CHECK ("portable_dashboards"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "portable_dashboards" ADD CONSTRAINT "portable_dashboards_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;