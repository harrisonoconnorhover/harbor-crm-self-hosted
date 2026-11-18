CREATE TABLE "portable_file_folders" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "portable_file_folders_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "portable_file_locations" (
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"folder_id" uuid,
	"revision" integer NOT NULL,
	CONSTRAINT "portable_file_locations_workspace_id_contact_id_file_id_pk" PRIMARY KEY("workspace_id","contact_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "portable_file_folders" ADD CONSTRAINT "portable_file_folders_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_file_locations" ADD CONSTRAINT "portable_file_location_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_file_locations" ADD CONSTRAINT "portable_file_location_folder_fk" FOREIGN KEY ("workspace_id","folder_id") REFERENCES "public"."portable_file_folders"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_file_folder_name" ON "portable_file_folders" USING btree ("workspace_id","name_key") WHERE "portable_file_folders"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "portable_file_location_folder" ON "portable_file_locations" USING btree ("workspace_id","folder_id");