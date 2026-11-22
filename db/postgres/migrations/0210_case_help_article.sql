ALTER TABLE "portable_case_publications" ADD COLUMN "article_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_case_publications" ADD CONSTRAINT "portable_case_article_fk" FOREIGN KEY ("workspace_id","article_id") REFERENCES "public"."portable_knowledge_articles"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.harbor_withdraw_ticket_case() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  UPDATE public.portable_case_publications SET contact_id=NULL, subject=NULL, customer_update=NULL,article_id=NULL, revision=revision+1
    WHERE workspace_id=NEW.workspace_id AND ticket_id=NEW.id AND contact_id IS NOT NULL;
  RETURN NULL;
END
$function$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.harbor_revoke_contact_cases() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  UPDATE public.portable_case_access SET kind='revoked',token_hash=NULL,expires_at=NULL,revision=revision+1
    WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND kind<>'revoked';
  UPDATE public.portable_case_publications SET contact_id=NULL,subject=NULL,customer_update=NULL,article_id=NULL,revision=revision+1
    WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id;
  RETURN NULL;
END
$function$;
