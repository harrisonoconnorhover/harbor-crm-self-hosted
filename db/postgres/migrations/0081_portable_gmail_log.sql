CREATE TABLE "portable_gmail_log_receipts" (
	"workspace_id" uuid NOT NULL,
	"mailbox" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"contact_id" uuid NOT NULL,
	"contact_created_at" timestamp with time zone NOT NULL,
	"activity_id" uuid NOT NULL,
	CONSTRAINT "portable_gmail_log_receipts_workspace_id_mailbox_message_id_pk" PRIMARY KEY("workspace_id","mailbox","message_id"),
	CONSTRAINT "portable_gmail_log_activity" UNIQUE("workspace_id","activity_id")
);
--> statement-breakpoint
ALTER TABLE "portable_gmail_log_receipts" ADD CONSTRAINT "portable_gmail_log_receipts_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;