CREATE TABLE "contact_file_versions" (
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"expected_version" uuid,
	"revision" integer,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contact_file_versions_workspace_id_contact_id_file_id_version_id_pk" PRIMARY KEY("workspace_id","contact_id","file_id","version_id"),
	CONSTRAINT "contact_file_revision" UNIQUE("workspace_id","contact_id","file_id","revision")
);
--> statement-breakpoint
ALTER TABLE "contact_file_versions" ADD CONSTRAINT "contact_file_versions_workspace_id_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;