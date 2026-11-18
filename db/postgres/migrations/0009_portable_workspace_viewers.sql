CREATE TABLE "portable_workspace_viewers" (
	"workspace_id" uuid NOT NULL,
	"viewer_id" text NOT NULL,
	"id" uuid NOT NULL,
	CONSTRAINT "portable_workspace_viewers_workspace_id_viewer_id_pk" PRIMARY KEY("workspace_id","viewer_id"),
	CONSTRAINT "portable_workspace_viewers_id_unique" UNIQUE("id")
);
--> statement-breakpoint
ALTER TABLE "portable_workspace_viewers" ADD CONSTRAINT "portable_workspace_viewers_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_workspace_viewers" ADD CONSTRAINT "portable_workspace_viewers_viewer_id_login_identities_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."login_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_workspace_viewer_lookup" ON "portable_workspace_viewers" USING btree ("viewer_id","workspace_id");--> statement-breakpoint
CREATE INDEX "portable_identity_email_lookup" ON "login_identities" USING btree ("email");