CREATE TABLE "portable_task_events" (
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"previous" jsonb,
	"data" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_task_events_workspace_id_task_id_revision_pk" PRIMARY KEY("workspace_id","task_id","revision")
);
--> statement-breakpoint
CREATE TABLE "portable_tasks" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"data" jsonb NOT NULL,
	"assignee_id" text,
	"assignee_label" text,
	"contact_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_tasks_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_task_assignee_label" CHECK (("portable_tasks"."assignee_id" IS NULL) = ("portable_tasks"."assignee_label" IS NULL)),
	CONSTRAINT "portable_task_completion" CHECK ("portable_tasks"."data"->>'status' IS NOT NULL AND
    (("portable_tasks"."data"->>'status' = 'Completed' AND "portable_tasks"."completed_at" IS NOT NULL)
      OR ("portable_tasks"."data"->>'status' = 'Not started' AND "portable_tasks"."completed_at" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "portable_task_events" ADD CONSTRAINT "portable_task_events_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_task_events" ADD CONSTRAINT "portable_task_event_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."portable_tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD CONSTRAINT "portable_tasks_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD CONSTRAINT "portable_tasks_assignee_id_login_identities_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD CONSTRAINT "portable_task_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_task_contact_order" ON "portable_tasks" USING btree ("workspace_id","contact_id","id");--> statement-breakpoint
CREATE INDEX "portable_task_status_order" ON "portable_tasks" USING btree ("workspace_id",("data"->>'status'),"id");