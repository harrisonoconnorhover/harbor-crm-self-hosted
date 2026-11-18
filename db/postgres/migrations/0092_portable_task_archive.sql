CREATE TABLE "portable_task_archive_receipts" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"next_task_id" uuid,
	CONSTRAINT "portable_task_archive_receipts_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id"),
	CONSTRAINT "portable_task_archive_action" CHECK (("portable_task_archive_receipts"."action"='archive' AND "portable_task_archive_receipts"."archived_at" IS NOT NULL)
    OR ("portable_task_archive_receipts"."action"='restore' AND "portable_task_archive_receipts"."archived_at" IS NULL AND "portable_task_archive_receipts"."next_task_id" IS NULL))
);
--> statement-breakpoint
DROP INDEX "portable_task_repeat_due";--> statement-breakpoint
DROP INDEX "portable_task_repeat_workspace_due";--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portable_task_archive_receipts" ADD CONSTRAINT "portable_task_archive_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."portable_tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_task_archive_order" ON "portable_tasks" USING btree ("workspace_id","id") WHERE "portable_tasks"."archived_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portable_task_repeat_due" ON "portable_tasks" USING btree (("data"->>'repeatDueAt'),"workspace_id","id") WHERE
  "portable_tasks"."archived_at" IS NULL AND "portable_tasks"."completed_at" IS NULL AND jsonb_typeof("portable_tasks"."data"->'repeat') = 'object' AND ("portable_tasks"."data"->>'repeatDueAt') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portable_task_repeat_workspace_due" ON "portable_tasks" USING btree ("workspace_id",("data"->>'repeatDueAt'),"id") WHERE
  "portable_tasks"."archived_at" IS NULL AND "portable_tasks"."completed_at" IS NULL AND jsonb_typeof("portable_tasks"."data"->'repeat') = 'object' AND ("portable_tasks"."data"->>'repeatDueAt') IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE VIEW "public"."portable_task_repeat_monitor" AS (
  SELECT least(count(*)::integer,50) AS due_count,
    count(*)>50 AS truncated,
    floor(extract(epoch FROM statement_timestamp()-min(candidate.due_at)::timestamptz))::double precision AS oldest_due_age_seconds
  FROM (
    SELECT ("portable_tasks"."data"->>'repeatDueAt') AS due_at
    FROM "portable_tasks"
    WHERE
  "portable_tasks"."archived_at" IS NULL AND "portable_tasks"."completed_at" IS NULL AND jsonb_typeof("portable_tasks"."data"->'repeat') = 'object' AND ("portable_tasks"."data"->>'repeatDueAt') IS NOT NULL
      AND ("portable_tasks"."data"->>'repeatDueAt')<=to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      AND (
        SELECT 1 FROM "portable_task_repeat_receipts"
        WHERE "portable_task_repeat_receipts"."workspace_id"="portable_tasks"."workspace_id"
          AND "portable_task_repeat_receipts"."predecessor_id"="portable_tasks"."id"
      ) IS NULL
    ORDER BY ("portable_tasks"."data"->>'repeatDueAt'),"portable_tasks"."workspace_id","portable_tasks"."id"
    LIMIT 51
  ) candidate
);
