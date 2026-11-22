CREATE TABLE "portable_workspace_teams" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"parent_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "portable_workspace_teams_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_team_sibling_name" UNIQUE NULLS NOT DISTINCT("workspace_id","parent_id","name_key"),
	CONSTRAINT "portable_team_not_own_parent" CHECK ("portable_workspace_teams"."parent_id" IS DISTINCT FROM "portable_workspace_teams"."id")
);
--> statement-breakpoint
ALTER TABLE "portable_workspace_viewers" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_workspace_teams" ADD CONSTRAINT "portable_workspace_teams_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workspace_teams" ADD CONSTRAINT "portable_team_parent" FOREIGN KEY ("workspace_id","parent_id") REFERENCES "public"."portable_workspace_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workspace_viewers" ADD CONSTRAINT "portable_viewer_team" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."portable_workspace_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;