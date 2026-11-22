CREATE TABLE "portable_aircall_assets" (
	"workspace_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"asset" text NOT NULL,
	CONSTRAINT "portable_aircall_assets_workspace_id_activity_id_asset_pk" PRIMARY KEY("workspace_id","activity_id","asset"),
	CONSTRAINT "aircall_asset_type" CHECK ("portable_aircall_assets"."asset" IN ('recording','transcript'))
);
--> statement-breakpoint
ALTER TABLE "portable_aircall_assets" ADD CONSTRAINT "portable_aircall_assets_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;