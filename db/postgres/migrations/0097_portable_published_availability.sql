CREATE TABLE "portable_published_availability" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid NOT NULL,
	"title" text NOT NULL,
	"time_zone" text NOT NULL,
	"slots" jsonb NOT NULL,
	CONSTRAINT "portable_published_availability_id_unique" UNIQUE("id")
);
--> statement-breakpoint
ALTER TABLE "portable_published_availability" ADD CONSTRAINT "portable_published_availability_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;