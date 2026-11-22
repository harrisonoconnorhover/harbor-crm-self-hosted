ALTER TABLE "portable_forecast_goals" DROP CONSTRAINT "forecast_goal_scope";--> statement-breakpoint
ALTER TABLE "private_workspaces" ADD COLUMN "fiscal_start_month" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_forecast_goals" ADD COLUMN "period" text DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_forecast_goals" ADD CONSTRAINT "forecast_goal_period_scope" UNIQUE NULLS NOT DISTINCT("workspace_id","month","period","pipeline_id","owner_id");--> statement-breakpoint
ALTER TABLE "private_workspaces" ADD CONSTRAINT "workspace_fiscal_start_month" CHECK ("private_workspaces"."fiscal_start_month" BETWEEN 1 AND 12);--> statement-breakpoint
ALTER TABLE "portable_forecast_goals" ADD CONSTRAINT "forecast_goal_period" CHECK ("portable_forecast_goals"."period" IN ('month','quarter'));