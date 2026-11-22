ALTER TABLE "portable_team_availability" ADD COLUMN "weekly_days" integer[];--> statement-breakpoint
ALTER TABLE "portable_team_availability" ADD COLUMN "weekly_zone" text;--> statement-breakpoint
ALTER TABLE "portable_team_availability" ADD COLUMN "weekly_start" time;--> statement-breakpoint
ALTER TABLE "portable_team_availability" ADD COLUMN "weekly_end" time;--> statement-breakpoint
ALTER TABLE "portable_team_availability" ADD COLUMN "weekly_live" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_team_availability" ADD CONSTRAINT "portable_team_weekly_hours" CHECK ((
    num_nonnulls("portable_team_availability"."weekly_days","portable_team_availability"."weekly_zone","portable_team_availability"."weekly_start","portable_team_availability"."weekly_end")=0 AND NOT "portable_team_availability"."weekly_live"
  ) OR (
    num_nonnulls("portable_team_availability"."weekly_days","portable_team_availability"."weekly_zone","portable_team_availability"."weekly_start","portable_team_availability"."weekly_end")=4
    AND cardinality("portable_team_availability"."weekly_days") BETWEEN 1 AND 7 AND "portable_team_availability"."weekly_days" <@ ARRAY[1,2,3,4,5,6,7]
    AND length("portable_team_availability"."weekly_zone") BETWEEN 1 AND 100
    AND "portable_team_availability"."weekly_end"-"portable_team_availability"."weekly_start" BETWEEN interval '15 minutes' AND interval '8 hours'
  ));