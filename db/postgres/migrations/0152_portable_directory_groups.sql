CREATE TABLE "portable_directory_group_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "portable_directory_group_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "portable_directory_groups" (
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"tenant" uuid NOT NULL,
	"external_id" uuid NOT NULL,
	"group_id" uuid,
	"display_name" text,
	CONSTRAINT "portable_directory_groups_workspace_id_team_id_pk" PRIMARY KEY("workspace_id","team_id"),
	CONSTRAINT "portable_directory_group_object" UNIQUE("workspace_id","tenant","external_id"),
	CONSTRAINT "portable_directory_group_resource" UNIQUE("workspace_id","group_id"),
	CONSTRAINT "portable_directory_group_provisioned" CHECK (("portable_directory_groups"."group_id" IS NULL AND "portable_directory_groups"."display_name" IS NULL) OR
    ("portable_directory_groups"."group_id" IS NOT NULL AND "portable_directory_groups"."display_name" IS NOT NULL AND length(trim("portable_directory_groups"."display_name")) BETWEEN 1 AND 120))
);
--> statement-breakpoint
ALTER TABLE "portable_directory_group_members" ADD CONSTRAINT "portable_directory_member_group" FOREIGN KEY ("workspace_id","group_id") REFERENCES "public"."portable_directory_groups"("workspace_id","group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_directory_group_members" ADD CONSTRAINT "portable_directory_member_access" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."portable_workspace_viewers"("workspace_id","viewer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_directory_group_members" ADD CONSTRAINT "portable_directory_member_user" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."portable_directory_users"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_directory_groups" ADD CONSTRAINT "portable_directory_group_team" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."portable_workspace_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_directory_group_roster" ON "portable_directory_group_members" USING btree ("workspace_id","group_id");