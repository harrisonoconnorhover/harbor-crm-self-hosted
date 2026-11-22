CREATE TABLE "portable_webhook_deliveries" (
	"workspace_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"object_kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"http_status" integer,
	CONSTRAINT "portable_webhook_delivery_event" CHECK ("portable_webhook_deliveries"."revision">0 AND
    "portable_webhook_deliveries"."object_kind" IN ('contacts','companies','deals','tasks','leads','tickets') AND
    "portable_webhook_deliveries"."action" IN ('created','updated','archived','restored','deleted')),
	CONSTRAINT "portable_webhook_delivery_state" CHECK ("portable_webhook_deliveries"."status" IN ('pending','sending','delivered','failed','uncertain') AND
    "portable_webhook_deliveries"."attempts">=0 AND ("portable_webhook_deliveries"."http_status" IS NULL OR "portable_webhook_deliveries"."http_status" BETWEEN 100 AND 599))
);
--> statement-breakpoint
CREATE TABLE "portable_webhook_subscriptions" (
	"workspace_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"destination" text NOT NULL,
	"objects" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portable_webhook_subscriptions_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_webhook_destination" UNIQUE("workspace_id","destination"),
	CONSTRAINT "portable_webhook_destination_valid" CHECK (length(trim("portable_webhook_subscriptions"."destination")) BETWEEN 1 AND 128),
	CONSTRAINT "portable_webhook_objects" CHECK (cardinality("portable_webhook_subscriptions"."objects") BETWEEN 1 AND 6 AND
    "portable_webhook_subscriptions"."objects" <@ ARRAY['contacts','companies','deals','tasks','leads','tickets']::text[])
);
--> statement-breakpoint
ALTER TABLE "portable_webhook_deliveries" ADD CONSTRAINT "portable_webhook_subscription_fk" FOREIGN KEY ("workspace_id","subscription_id") REFERENCES "public"."portable_webhook_subscriptions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_webhook_subscriptions" ADD CONSTRAINT "portable_webhook_subscriptions_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_webhook_due" ON "portable_webhook_deliveries" USING btree ("workspace_id","subscription_id","available_at","id") WHERE "portable_webhook_deliveries"."status"='pending';--> statement-breakpoint
CREATE INDEX "portable_webhook_last_attempt" ON "portable_webhook_deliveries" USING btree ("workspace_id","attempted_at" DESC NULLS LAST) WHERE "portable_webhook_deliveries"."attempted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portable_webhook_sending" ON "portable_webhook_deliveries" USING btree ("attempted_at","id") WHERE "portable_webhook_deliveries"."status"='sending';--> statement-breakpoint
CREATE INDEX "portable_webhook_delivered" ON "portable_webhook_deliveries" USING btree ("finished_at","id") WHERE "portable_webhook_deliveries"."status"='delivered';--> statement-breakpoint
CREATE INDEX "portable_webhook_recent" ON "portable_webhook_deliveries" USING btree ("workspace_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE FUNCTION public.harbor_capture_record_webhook() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  workspace uuid;
  record_key uuid;
  record_revision integer;
  change text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    workspace := OLD.workspace_id;
    record_key := OLD.id;
    record_revision := OLD.revision;
    change := 'deleted';
  ELSE
    workspace := NEW.workspace_id;
    record_key := NEW.id;
    record_revision := NEW.revision;
    IF TG_OP = 'INSERT' THEN
      change := 'created';
    ELSIF OLD IS NOT DISTINCT FROM NEW THEN
      RETURN NULL;
    ELSIF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
      change := 'archived';
    ELSIF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
      change := 'restored';
    ELSE
      change := 'updated';
    END IF;
  END IF;

  -- Hold a selected subscription through commit, including its foreign-key check.
  -- A simultaneous unsubscribe either removes this delivery or wins before capture.
  INSERT INTO public.portable_webhook_deliveries
    (workspace_id, subscription_id, object_kind, record_id, revision, action, occurred_at)
  SELECT workspace, subscription.id, TG_ARGV[0], record_key, record_revision, change, statement_timestamp()
  FROM public.portable_webhook_subscriptions AS subscription
  WHERE subscription.workspace_id = workspace AND TG_ARGV[0] = ANY(subscription.objects)
  ORDER BY subscription.id
  FOR KEY SHARE OF subscription;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER capture_record_webhook AFTER INSERT OR UPDATE OR DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_webhook('contacts');
--> statement-breakpoint
CREATE TRIGGER capture_record_webhook AFTER INSERT OR UPDATE OR DELETE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_webhook('companies');
--> statement-breakpoint
CREATE TRIGGER capture_record_webhook AFTER INSERT OR UPDATE OR DELETE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_webhook('deals');
--> statement-breakpoint
CREATE TRIGGER capture_record_webhook AFTER INSERT OR UPDATE OR DELETE ON public.portable_tasks
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_webhook('tasks');
--> statement-breakpoint
CREATE TRIGGER capture_record_webhook AFTER INSERT OR UPDATE OR DELETE ON public.portable_leads
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_webhook('leads');
--> statement-breakpoint
CREATE TRIGGER capture_record_webhook AFTER INSERT OR UPDATE OR DELETE ON public.portable_tickets
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_webhook('tickets');
