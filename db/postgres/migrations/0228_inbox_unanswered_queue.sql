ALTER TABLE "portable_inbox_conversations" ADD COLUMN "last_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portable_inbox_conversations" ADD COLUMN "last_replied_at" timestamp with time zone;--> statement-breakpoint
-- Message receipts are append-only. A confirmed outgoing receipt answers mail up to
-- its original submission time, even when an operator confirms delivery much later.
CREATE FUNCTION public.harbor_track_inbox_exchange() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'received' THEN
    UPDATE public.portable_inbox_conversations SET last_received_at = NEW.created_at
      WHERE workspace_id = NEW.workspace_id AND id = NEW.conversation_id
        AND (last_received_at IS NULL OR last_received_at < NEW.created_at);
  ELSE
    UPDATE public.portable_inbox_conversations SET last_replied_at = NEW.created_at
      WHERE workspace_id = NEW.workspace_id AND id = NEW.conversation_id
        AND (last_replied_at IS NULL OR last_replied_at < NEW.created_at);
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER inbox_exchange_after_receipt AFTER INSERT OR UPDATE OF state ON public.portable_inbox_messages
FOR EACH ROW WHEN (NEW.state IN ('received','sent')) EXECUTE FUNCTION public.harbor_track_inbox_exchange();--> statement-breakpoint
UPDATE public.portable_inbox_conversations AS c
SET last_received_at = history.received, last_replied_at = history.replied
FROM (
  SELECT workspace_id, conversation_id,
    max(created_at) FILTER (WHERE state = 'received') AS received,
    max(created_at) FILTER (WHERE state = 'sent') AS replied
  FROM public.portable_inbox_messages WHERE state IN ('received','sent')
  GROUP BY workspace_id, conversation_id
) AS history
WHERE c.workspace_id = history.workspace_id AND c.id = history.conversation_id;--> statement-breakpoint
CREATE INDEX "inbox_conversation_unanswered_page" ON "portable_inbox_conversations" USING btree ("workspace_id","status","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "portable_inbox_conversations"."last_received_at" >= coalesce("portable_inbox_conversations"."last_replied_at", '-infinity'::timestamptz);
