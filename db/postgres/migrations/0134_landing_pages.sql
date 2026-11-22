CREATE TABLE "portable_landing_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"draft_revision" integer NOT NULL,
	"draft" jsonb NOT NULL,
	"last_published" jsonb,
	CONSTRAINT "landing_page_workspace_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "landing_page_revisions" CHECK ("portable_landing_pages"."draft_revision" > 0 AND "portable_landing_pages"."revision" >= "portable_landing_pages"."draft_revision")
);
--> statement-breakpoint
CREATE TABLE "portable_landing_publications" (
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "portable_landing_publications_workspace_id_page_id_pk" PRIMARY KEY("workspace_id","page_id"),
	CONSTRAINT "landing_public_url" UNIQUE("workspace_id","slug"),
	CONSTRAINT "landing_public_slug" CHECK (length("portable_landing_publications"."slug") <= 72 AND "portable_landing_publications"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "portable_landing_publications"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "portable_landing_pages" ADD CONSTRAINT "portable_landing_pages_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_landing_publications" ADD CONSTRAINT "portable_landing_publications_workspace_id_page_id_portable_landing_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","page_id") REFERENCES "public"."portable_landing_pages"("workspace_id","id") ON DELETE no action ON UPDATE no action;