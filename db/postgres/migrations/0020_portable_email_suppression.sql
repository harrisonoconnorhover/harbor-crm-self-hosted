CREATE TABLE "portable_email_suppressions" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"recipient_opted_out_at" timestamp with time zone,
	CONSTRAINT "portable_email_suppressions_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_email_suppression_address" UNIQUE("workspace_id","email")
);
--> statement-breakpoint
CREATE TABLE "portable_email_unsubscribe_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"email" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portable_email_suppressions" ADD CONSTRAINT "portable_email_suppressions_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_email_unsubscribe_tokens" ADD CONSTRAINT "portable_email_unsubscribe_tokens_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_email_unsubscribe_tokens" ADD CONSTRAINT "portable_email_unsubscribe_tokens_owner_id_login_identities_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;