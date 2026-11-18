CREATE VIEW "public"."portable_task_repeat_monitor" AS (
  SELECT least(count(*)::integer,50) AS due_count,
    count(*)>50 AS truncated,
    floor(extract(epoch FROM statement_timestamp()-min(candidate.due_at)::timestamptz))::double precision AS oldest_due_age_seconds
  FROM (
    SELECT ("portable_tasks"."data"->>'repeatDueAt') AS due_at
    FROM "portable_tasks"
    WHERE
  "portable_tasks"."completed_at" IS NULL AND jsonb_typeof("portable_tasks"."data"->'repeat') = 'object' AND ("portable_tasks"."data"->>'repeatDueAt') IS NOT NULL
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
