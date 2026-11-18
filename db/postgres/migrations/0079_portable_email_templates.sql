CREATE TABLE "portable_email_templates" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "portable_email_templates_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portable_email_templates" ADD CONSTRAINT "portable_email_templates_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;