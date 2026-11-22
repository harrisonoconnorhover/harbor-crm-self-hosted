CREATE TABLE "portable_case_access" (
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text,
	"expires_at" bigint,
	CONSTRAINT "portable_case_access_workspace_id_contact_id_pk" PRIMARY KEY("workspace_id","contact_id"),
	CONSTRAINT "portable_case_access_credential" CHECK ("portable_case_access"."revision">0 AND (
    ("portable_case_access"."kind"='revoked' AND "portable_case_access"."token_hash" IS NULL AND "portable_case_access"."expires_at" IS NULL) OR
    ("portable_case_access"."kind" IN ('invited','active') AND "portable_case_access"."token_hash" IS NOT NULL AND "portable_case_access"."token_hash" ~ '^[A-Za-z0-9_-]{43}$'
      AND "portable_case_access"."expires_at" IS NOT NULL AND "portable_case_access"."expires_at">0)))
);
--> statement-breakpoint
CREATE TABLE "portable_case_publications" (
	"workspace_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"contact_id" uuid,
	"revision" integer NOT NULL,
	"subject" text,
	"customer_update" text,
	CONSTRAINT "portable_case_publications_workspace_id_ticket_id_pk" PRIMARY KEY("workspace_id","ticket_id"),
	CONSTRAINT "portable_case_publication_content" CHECK ("portable_case_publications"."revision">0 AND (
    ("portable_case_publications"."contact_id" IS NULL AND "portable_case_publications"."subject" IS NULL AND "portable_case_publications"."customer_update" IS NULL) OR
    ("portable_case_publications"."contact_id" IS NOT NULL AND "portable_case_publications"."subject" IS NOT NULL AND char_length(trim("portable_case_publications"."subject")) BETWEEN 1 AND 200
      AND "portable_case_publications"."customer_update" IS NOT NULL AND char_length("portable_case_publications"."customer_update")<=4000)))
);
--> statement-breakpoint
ALTER TABLE "portable_case_access" ADD CONSTRAINT "portable_case_access_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_case_publications" ADD CONSTRAINT "portable_case_ticket_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."portable_tickets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_case_publications" ADD CONSTRAINT "portable_case_publication_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_case_access_hash" ON "portable_case_access" USING btree ("token_hash") WHERE "portable_case_access"."token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portable_case_publication_list" ON "portable_case_publications" USING btree ("workspace_id","contact_id","ticket_id") WHERE "portable_case_publications"."contact_id" IS NOT NULL;
--> statement-breakpoint
-- Keep withdrawals permanent when a ticket returns to its previous contact, or an
-- archived record is restored. This covers merges and every ticket-writing path.
CREATE FUNCTION public.harbor_withdraw_ticket_case() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  UPDATE public.portable_case_publications SET contact_id=NULL, subject=NULL, customer_update=NULL, revision=revision+1
    WHERE workspace_id=NEW.workspace_id AND ticket_id=NEW.id AND contact_id IS NOT NULL;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER portable_case_ticket_lifecycle AFTER UPDATE OF contact_id, archived_at ON public.portable_tickets
FOR EACH ROW WHEN (OLD.contact_id IS DISTINCT FROM NEW.contact_id OR (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL))
EXECUTE FUNCTION public.harbor_withdraw_ticket_case();
--> statement-breakpoint
CREATE FUNCTION public.harbor_revoke_contact_cases() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  UPDATE public.portable_case_access SET kind='revoked',token_hash=NULL,expires_at=NULL,revision=revision+1
    WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND kind<>'revoked';
  UPDATE public.portable_case_publications SET contact_id=NULL,subject=NULL,customer_update=NULL,revision=revision+1
    WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER portable_case_contact_lifecycle AFTER UPDATE OF archived_at ON public.contacts
FOR EACH ROW WHEN (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
EXECUTE FUNCTION public.harbor_revoke_contact_cases();
--> statement-breakpoint
CREATE FUNCTION public.harbor_close_center_cases() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  UPDATE public.portable_case_access SET kind='revoked',token_hash=NULL,expires_at=NULL,revision=revision+1
    WHERE workspace_id=NEW.workspace_id AND kind<>'revoked';
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER portable_case_center_closed AFTER UPDATE OF enabled ON public.portable_help_centers
FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled)
EXECUTE FUNCTION public.harbor_close_center_cases();
