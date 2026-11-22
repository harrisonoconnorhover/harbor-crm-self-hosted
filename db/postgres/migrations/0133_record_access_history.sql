CREATE TABLE "portable_record_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"actor_email" text NOT NULL,
	"token_id" uuid,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"record_ids" uuid[] NOT NULL,
	"occurred_at" bigint DEFAULT floor(extract(epoch from clock_timestamp()) * 1000)::bigint NOT NULL,
	CONSTRAINT "record_access_kind" CHECK ("portable_record_access_events"."kind" IN ('contacts','companies','deals')),
	CONSTRAINT "record_access_action" CHECK ("portable_record_access_events"."action" IN ('detail','list','csv','integration') AND (("portable_record_access_events"."token_id" IS NOT NULL) = ("portable_record_access_events"."action"='integration'))),
	CONSTRAINT "record_access_count" CHECK (cardinality("portable_record_access_events"."record_ids") BETWEEN 1 AND 500 AND ("portable_record_access_events"."action"<>'detail' OR cardinality("portable_record_access_events"."record_ids")=1))
);
--> statement-breakpoint
ALTER TABLE "portable_record_access_events" ADD CONSTRAINT "portable_record_access_events_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_access_workspace_time" ON "portable_record_access_events" USING btree ("workspace_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "record_access_record_ids" ON "portable_record_access_events" USING gin ("record_ids");
--> statement-breakpoint
CREATE FUNCTION public.harbor_preserve_record_access() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Record access history is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER preserve_record_access BEFORE UPDATE OR DELETE OR TRUNCATE
ON public.portable_record_access_events FOR EACH STATEMENT EXECUTE FUNCTION public.harbor_preserve_record_access();
