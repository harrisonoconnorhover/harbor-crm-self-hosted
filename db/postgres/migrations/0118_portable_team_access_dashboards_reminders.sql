ALTER TABLE "portable_workspace_viewers" ADD COLUMN "backup_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD COLUMN "reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD COLUMN "reminder_dismissed_by" text;--> statement-breakpoint
ALTER TABLE "portable_dashboards" ADD COLUMN "team_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "portable_task_reminders_due" ON "portable_tasks" USING btree ("workspace_id","assignee_id","reminder_at","id") WHERE "portable_tasks"."archived_at" IS NULL AND "portable_tasks"."completed_at" IS NULL AND "portable_tasks"."reminder_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_workspace_viewers" ADD CONSTRAINT "portable_workspace_backup_editor" CHECK (NOT "portable_workspace_viewers"."backup_admin" OR "portable_workspace_viewers"."role"='editor');