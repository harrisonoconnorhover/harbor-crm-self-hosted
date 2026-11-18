CREATE TABLE "portable_knowledge_categories" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"description" text NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "portable_knowledge_categories_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_knowledge_category_parent" CHECK ("portable_knowledge_categories"."parent_id" IS DISTINCT FROM "portable_knowledge_categories"."id")
);
--> statement-breakpoint
ALTER TABLE "portable_knowledge_categories" ADD CONSTRAINT "portable_knowledge_categories_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_knowledge_categories" ADD CONSTRAINT "portable_knowledge_category_parent_fk" FOREIGN KEY ("workspace_id","parent_id") REFERENCES "public"."portable_knowledge_categories"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_knowledge_category_name" ON "portable_knowledge_categories" USING btree ("workspace_id",coalesce("parent_id",'00000000-0000-0000-0000-000000000000'::uuid),"name_key");