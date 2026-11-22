CREATE TABLE "portable_directory_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "portable_directory_user_workspace" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "portable_directory_users" ADD CONSTRAINT "portable_directory_users_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_directory_users" ADD CONSTRAINT "portable_directory_users_user_id_login_identities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."login_identities"("id") ON DELETE cascade ON UPDATE no action;