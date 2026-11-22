ALTER TABLE "portable_jobs" ADD COLUMN "wait_for_lifecycle" text;--> statement-breakpoint
CREATE INDEX "portable_jobs_wait_for_contact" ON "portable_jobs" USING btree ("workspace_id","contact_id","wait_for_lifecycle") WHERE "portable_jobs"."status"='queued' AND "portable_jobs"."wait_for_lifecycle" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_job_event_wait" CHECK ("portable_jobs"."wait_for_lifecycle" IS NULL OR (
    "portable_jobs"."kind" IN ('note','task') AND "portable_jobs"."status" IN ('queued','skipped') AND "portable_jobs"."attempts"=0
    AND "portable_jobs"."wait_for_lifecycle" IN ('Subscriber','Lead','Marketing qualified lead','Sales qualified lead','Opportunity','Customer','Evangelist','Other')));
--> statement-breakpoint
-- A single contact write may come from the editor, an import, or the API.
-- Wake already admitted work in that same transaction, before new workflow enrollments.
CREATE FUNCTION public.harbor_release_lifecycle_waits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entered_at_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
BEGIN
  UPDATE public.portable_jobs
     SET scheduled_for = entered_at_ms + (scheduled_for - created_at),
         available_at  = entered_at_ms + (scheduled_for - created_at),
         wait_for_lifecycle = NULL
   WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.id
     AND status = 'queued' AND wait_for_lifecycle = NEW.data->>'lifecycle';
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER release_contact_lifecycle_waits AFTER UPDATE OF data ON public.contacts
FOR EACH ROW WHEN (NEW.archived_at IS NULL AND OLD.data->>'lifecycle' IS DISTINCT FROM NEW.data->>'lifecycle')
EXECUTE FUNCTION public.harbor_release_lifecycle_waits();
