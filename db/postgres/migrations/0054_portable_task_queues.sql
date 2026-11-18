CREATE TABLE "portable_task_queues" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "portable_task_queues_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD COLUMN "queue_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_task_queues" ADD CONSTRAINT "portable_task_queues_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_task_queues_name" ON "portable_task_queues" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD CONSTRAINT "portable_task_queue_fk" FOREIGN KEY ("workspace_id","queue_id") REFERENCES "public"."portable_task_queues"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_task_queue_order" ON "portable_tasks" USING btree ("workspace_id","queue_id","id");