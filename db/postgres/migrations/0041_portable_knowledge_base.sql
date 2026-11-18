CREATE TABLE "portable_knowledge_articles" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"excerpt" text NOT NULL,
	"search_text" text NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "portable_knowledge_articles_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "portable_knowledge_versions" (
	"workspace_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"content" jsonb NOT NULL,
	"action" text NOT NULL,
	"source_revision" bigint,
	"saved_at" bigint NOT NULL,
	"archived_at" bigint,
	"changed_by_id" text NOT NULL,
	CONSTRAINT "portable_knowledge_versions_workspace_id_article_id_revision_pk" PRIMARY KEY("workspace_id","article_id","revision")
);
--> statement-breakpoint
ALTER TABLE "portable_knowledge_articles" ADD CONSTRAINT "portable_knowledge_articles_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_knowledge_versions" ADD CONSTRAINT "portable_knowledge_version_article_fk" FOREIGN KEY ("workspace_id","article_id") REFERENCES "public"."portable_knowledge_articles"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_knowledge_articles_recent" ON "portable_knowledge_articles" USING btree ("workspace_id","updated_at","id");