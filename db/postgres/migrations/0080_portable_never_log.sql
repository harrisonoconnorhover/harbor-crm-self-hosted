CREATE TABLE "portable_never_log_rules" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_never_log_rules_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_never_log_value" UNIQUE("workspace_id","value")
);
--> statement-breakpoint
ALTER TABLE "portable_never_log_rules" ADD CONSTRAINT "portable_never_log_rules_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;