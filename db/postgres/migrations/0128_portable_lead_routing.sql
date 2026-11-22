CREATE TABLE "portable_lead_routing_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"available" boolean NOT NULL,
	"country" text NOT NULL,
	"capacity" integer NOT NULL,
	"time_zone" text NOT NULL,
	"days" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"revision" integer NOT NULL,
	"last_assigned_at" timestamp with time zone,
	CONSTRAINT "portable_lead_routing_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "portable_routing_limits" CHECK ("portable_lead_routing_members"."capacity" BETWEEN 1 AND 10000 AND "portable_lead_routing_members"."revision">0
    AND "portable_lead_routing_members"."days" BETWEEN 1 AND 127 AND "portable_lead_routing_members"."start_minute">=0 AND "portable_lead_routing_members"."end_minute"<=1440 AND "portable_lead_routing_members"."start_minute"<"portable_lead_routing_members"."end_minute"
    AND length("portable_lead_routing_members"."country")<=100 AND length("portable_lead_routing_members"."time_zone") BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "portable_lead_routing_members" ADD CONSTRAINT "portable_lead_routing_members_workspace_id_user_id_portable_workspace_viewers_workspace_id_viewer_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."portable_workspace_viewers"("workspace_id","viewer_id") ON DELETE cascade ON UPDATE no action;