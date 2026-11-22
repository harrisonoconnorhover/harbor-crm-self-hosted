ALTER TABLE "private_workspaces" ADD COLUMN "account_defaults" jsonb;--> statement-breakpoint
ALTER TABLE "private_workspaces" ADD COLUMN "account_defaults_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_workspace_viewers" ADD COLUMN "tool_policies" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "private_workspaces" ADD CONSTRAINT "workspace_defaults_consistent" CHECK (("private_workspaces"."account_defaults" IS NULL AND "private_workspaces"."account_defaults_revision"=0)
    OR ("private_workspaces"."account_defaults_revision">0 AND "private_workspaces"."account_defaults" IS NOT NULL AND jsonb_typeof("private_workspaces"."account_defaults")='object'
      AND "private_workspaces"."account_defaults" ?& ARRAY['name','timeZone','currency','language','dateFormat','numberFormat']
      AND jsonb_typeof("private_workspaces"."account_defaults"->'name')='string' AND length(btrim("private_workspaces"."account_defaults"->>'name')) BETWEEN 1 AND 100
      AND jsonb_typeof("private_workspaces"."account_defaults"->'timeZone')='string' AND length("private_workspaces"."account_defaults"->>'timeZone') BETWEEN 1 AND 100
      AND coalesce("private_workspaces"."account_defaults"->>'currency' ~ '^[A-Z]{3}$',false)
      AND coalesce("private_workspaces"."account_defaults"->>'language' IN ('en','de','es','fr','it','ja','pt'),false)
      AND coalesce("private_workspaces"."account_defaults"->>'dateFormat' IN ('language','mdy','dmy','ymd'),false)
      AND coalesce("private_workspaces"."account_defaults"->>'numberFormat' IN ('language','en-US','de-DE','fr-FR'),false)));--> statement-breakpoint
ALTER TABLE "portable_workspace_viewers" ADD CONSTRAINT "portable_viewer_tool_policy_keys" CHECK (jsonb_typeof("portable_workspace_viewers"."tool_policies")='object'
    AND ("portable_workspace_viewers"."tool_policies" - ARRAY['contacts','companies','deals','tasks','leads','tickets','custom-objects','segments','team-inbox','knowledge','snippets','reports','dashboards','forecast','goals','meetings','files','recycle-bin','calls','duplicates','sales-workspace'])='{}'::jsonb);