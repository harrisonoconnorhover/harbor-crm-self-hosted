ALTER TABLE "private_workspaces" ADD COLUMN "last_task_repeat_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "private_workspace_task_repeat_order" ON "private_workspaces" USING btree ("last_task_repeat_at" NULLS FIRST,"id");--> statement-breakpoint
CREATE INDEX "portable_task_repeat_workspace_due" ON "portable_tasks" USING btree ("workspace_id",("data"->>'repeatDueAt'),"id") WHERE
  "portable_tasks"."completed_at" IS NULL AND jsonb_typeof("portable_tasks"."data"->'repeat') = 'object' AND ("portable_tasks"."data"->>'repeatDueAt') IS NOT NULL;
