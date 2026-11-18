CREATE TABLE "portable_custom_properties" (
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"id" uuid NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "portable_custom_properties_workspace_id_kind_id_pk" PRIMARY KEY("workspace_id","kind","id")
);
--> statement-breakpoint
ALTER TABLE "portable_custom_properties" ADD CONSTRAINT "portable_custom_properties_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_custom_property_label" ON "portable_custom_properties" USING btree ("workspace_id","kind",lower("label"));