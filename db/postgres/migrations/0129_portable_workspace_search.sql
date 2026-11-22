CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
--> statement-breakpoint
CREATE FUNCTION public.harbor_search_values(doc jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT coalesce(string_agg(lower((value #>> '{}') COLLATE pg_unicode_fast), chr(10) ORDER BY ordinal), '')
  FROM jsonb_path_query(doc, 'strict $.** ? (@.type() != "object" && @.type() != "array" && @.type() != "null")')
    WITH ORDINALITY AS scalars(value, ordinal)
$function$;
--> statement-breakpoint
CREATE INDEX "contacts_search_values" ON "contacts" USING gin ((public.harbor_search_values("data") COLLATE "C") public.gin_trgm_ops) WHERE "contacts"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "companies_search_values" ON "companies" USING gin ((public.harbor_search_values("data") COLLATE "C") public.gin_trgm_ops) WHERE "companies"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "deals_search_values" ON "deals" USING gin ((public.harbor_search_values("data") COLLATE "C") public.gin_trgm_ops) WHERE "deals"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "portable_tasks_search_values" ON "portable_tasks" USING gin ((public.harbor_search_values("data") COLLATE "C") public.gin_trgm_ops) WHERE "portable_tasks"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "portable_leads_search_values" ON "portable_leads" USING gin ((public.harbor_search_values("data") COLLATE "C") public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "portable_knowledge_text_search" ON "portable_knowledge_articles" USING gin (("search_text" COLLATE "C") public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "portable_knowledge_managed_category" ON "portable_knowledge_articles" USING btree ("workspace_id",("content"->>'categoryId'));--> statement-breakpoint
CREATE INDEX "portable_tickets_search_values" ON "portable_tickets" USING gin ((public.harbor_search_values("data") COLLATE "C") public.gin_trgm_ops);
