-- Keep display spelling in the conversation and use folded elements for exact tag lookups.
CREATE FUNCTION public.harbor_inbox_tag_keys(labels text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT ARRAY(SELECT lower(label) FROM unnest(labels) WITH ORDINALITY AS tags(label,position) ORDER BY position)
$function$;
--> statement-breakpoint
CREATE INDEX "inbox_conversation_claim_page" ON "portable_inbox_conversations" USING btree ("workspace_id","status","claimed_by","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inbox_conversation_tag_keys" ON "portable_inbox_conversations" USING gin (public.harbor_inbox_tag_keys("tags"));
