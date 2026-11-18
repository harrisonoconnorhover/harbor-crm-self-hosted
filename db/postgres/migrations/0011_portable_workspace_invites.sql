CREATE TABLE "portable_workspace_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_workspace_invite_recipient" UNIQUE("workspace_id","email")
);
--> statement-breakpoint
ALTER TABLE "portable_workspace_invites" ADD CONSTRAINT "portable_workspace_invites_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_workspace_invite_inbox" ON "portable_workspace_invites" USING btree ("email","expires_at","id");