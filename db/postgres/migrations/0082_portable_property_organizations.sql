CREATE TABLE "portable_property_organizations" (
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"revision" integer NOT NULL,
	"config" jsonb NOT NULL,
	CONSTRAINT "portable_property_organizations_workspace_id_kind_pk" PRIMARY KEY("workspace_id","kind")
);
--> statement-breakpoint
ALTER TABLE "portable_property_organizations" ADD CONSTRAINT "portable_property_organizations_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;