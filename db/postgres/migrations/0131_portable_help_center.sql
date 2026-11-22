CREATE TABLE "portable_article_publications" (
	"workspace_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"published_revision" bigint,
	"revision" integer NOT NULL,
	"search_text" text NOT NULL,
	CONSTRAINT "portable_article_publications_workspace_id_article_id_pk" PRIMARY KEY("workspace_id","article_id"),
	CONSTRAINT "portable_publication_version" CHECK ("portable_article_publications"."revision">0 AND (("portable_article_publications"."published_revision" IS NOT NULL AND "portable_article_publications"."published_revision">0) OR "portable_article_publications"."published_revision" IS NULL AND "portable_article_publications"."search_text"=''))
);
--> statement-breakpoint
CREATE TABLE "portable_help_centers" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"accent" text NOT NULL,
	"enabled" boolean NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "portable_help_centers_id_unique" UNIQUE("id"),
	CONSTRAINT "portable_help_brand" CHECK (char_length(trim("portable_help_centers"."name")) BETWEEN 1 AND 80 AND "portable_help_centers"."accent" ~ '^#[0-9a-fA-F]{6}$' AND "portable_help_centers"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "portable_article_publications" ADD CONSTRAINT "portable_article_publications_workspace_id_article_id_portable_knowledge_articles_workspace_id_id_fk" FOREIGN KEY ("workspace_id","article_id") REFERENCES "public"."portable_knowledge_articles"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_article_publications" ADD CONSTRAINT "portable_published_version_fk" FOREIGN KEY ("workspace_id","article_id","published_revision") REFERENCES "public"."portable_knowledge_versions"("workspace_id","article_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_help_centers" ADD CONSTRAINT "portable_help_centers_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_published_article_search" ON "portable_article_publications" USING gin (("search_text" COLLATE "C") public.gin_trgm_ops);