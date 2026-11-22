CREATE TABLE "portable_forecast_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid,
	"owner_id" text,
	"month" text NOT NULL,
	"amount_cents" bigint,
	"revision" integer NOT NULL,
	CONSTRAINT "forecast_goal_scope" UNIQUE NULLS NOT DISTINCT("workspace_id","month","pipeline_id","owner_id"),
	CONSTRAINT "forecast_goal_month" CHECK ("portable_forecast_goals"."month" ~ '^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "forecast_goal_value" CHECK ("portable_forecast_goals"."amount_cents" BETWEEN 0 AND 100000000000000),
	CONSTRAINT "forecast_goal_revision" CHECK ("portable_forecast_goals"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "portable_forecast_goals" ADD CONSTRAINT "portable_forecast_goals_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_forecast_goals" ADD CONSTRAINT "portable_forecast_goals_owner_id_login_identities_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_forecast_goals" ADD CONSTRAINT "forecast_goal_pipeline" FOREIGN KEY ("workspace_id","pipeline_id") REFERENCES "public"."deal_pipelines"("workspace_id","id") ON DELETE no action ON UPDATE no action;