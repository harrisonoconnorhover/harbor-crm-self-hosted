CREATE TABLE "portable_record_deletions" (
	"workspace_id" uuid NOT NULL,
	"object_kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"deleted_at" timestamp (3) NOT NULL,
	CONSTRAINT "portable_record_deletions_workspace_id_object_kind_record_id_pk" PRIMARY KEY("workspace_id","object_kind","record_id"),
	CONSTRAINT "portable_record_deletion_kind" CHECK ("portable_record_deletions"."object_kind" IN ('contacts','companies','deals','tasks','leads','tickets'))
);
--> statement-breakpoint
ALTER TABLE "portable_record_deletions" ADD CONSTRAINT "portable_record_deletions_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_record_deletion_window" ON "portable_record_deletions" USING btree ("workspace_id","object_kind","deleted_at","record_id");
--> statement-breakpoint
CREATE FUNCTION public.harbor_capture_record_deletion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.portable_record_deletions(workspace_id,object_kind,record_id,deleted_at)
    SELECT w.id,TG_ARGV[0],OLD.id,date_trunc('milliseconds',statement_timestamp() AT TIME ZONE 'UTC')
    FROM public.private_workspaces w WHERE w.id=OLD.workspace_id
    ON CONFLICT(workspace_id,object_kind,record_id) DO UPDATE
      SET deleted_at=greatest(portable_record_deletions.deleted_at,excluded.deleted_at);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER capture_record_deletion AFTER DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_deletion('contacts');
--> statement-breakpoint
CREATE TRIGGER capture_record_deletion AFTER DELETE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_deletion('companies');
--> statement-breakpoint
CREATE TRIGGER capture_record_deletion AFTER DELETE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_deletion('deals');
--> statement-breakpoint
CREATE TRIGGER capture_record_deletion AFTER DELETE ON public.portable_tasks
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_deletion('tasks');
--> statement-breakpoint
CREATE TRIGGER capture_record_deletion AFTER DELETE ON public.portable_leads
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_deletion('leads');
--> statement-breakpoint
CREATE TRIGGER capture_record_deletion AFTER DELETE ON public.portable_tickets
  FOR EACH ROW EXECUTE FUNCTION public.harbor_capture_record_deletion('tickets');
