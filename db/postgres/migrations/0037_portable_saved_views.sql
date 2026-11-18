CREATE TABLE "portable_saved_views" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "portable_saved_views_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_saved_view_kind" CHECK ("portable_saved_views"."kind" IN ('contacts','companies','deals')),
	CONSTRAINT "portable_saved_view_revision" CHECK ("portable_saved_views"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "portable_saved_views" ADD CONSTRAINT "portable_saved_views_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_saved_view_name" ON "portable_saved_views" USING btree ("workspace_id","kind",lower("name"));