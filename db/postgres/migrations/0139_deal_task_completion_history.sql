CREATE INDEX "portable_task_completion_deal" ON "portable_task_events" USING btree ("workspace_id",("data"->>'dealId'),"occurred_at","task_id","revision") WHERE
  "portable_task_events"."data"->'fields'->>'status' = 'Completed' AND
  "portable_task_events"."previous"->'fields'->>'status' IS DISTINCT FROM 'Completed';
