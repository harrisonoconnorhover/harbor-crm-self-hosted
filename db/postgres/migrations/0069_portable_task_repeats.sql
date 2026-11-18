CREATE TABLE "portable_task_repeat_receipts" (
	"workspace_id" uuid NOT NULL,
	"predecessor_id" uuid NOT NULL,
	"successor_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_task_repeat_receipts_workspace_id_predecessor_id_pk" PRIMARY KEY("workspace_id","predecessor_id"),
	CONSTRAINT "portable_task_repeat_successor" UNIQUE("workspace_id","successor_id"),
	CONSTRAINT "portable_task_repeat_distinct" CHECK ("portable_task_repeat_receipts"."predecessor_id" <> "portable_task_repeat_receipts"."successor_id")
);
--> statement-breakpoint
ALTER TABLE "portable_task_repeat_receipts" ADD CONSTRAINT "portable_task_repeat_receipts_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_task_repeat_receipts" ADD CONSTRAINT "portable_task_repeat_receipts_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;