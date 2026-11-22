CREATE TABLE "portable_standard_property_access" (
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"restricted" boolean NOT NULL,
	"visible_team_id" uuid,
	"revision" integer NOT NULL,
	CONSTRAINT "portable_standard_property_access_workspace_id_kind_id_pk" PRIMARY KEY("workspace_id","kind","id"),
	CONSTRAINT "portable_standard_property_revision" CHECK ("portable_standard_property_access"."revision" >= 1),
	CONSTRAINT "portable_standard_property_audience" CHECK ("portable_standard_property_access"."restricted" OR "portable_standard_property_access"."visible_team_id" IS NULL),
	CONSTRAINT "portable_standard_property_key" CHECK (("portable_standard_property_access"."kind"='contacts' AND "portable_standard_property_access"."id" IN ('mobilePhone','address','address2','description'))
    OR ("portable_standard_property_access"."kind"='companies' AND "portable_standard_property_access"."id" IN ('annualRevenue','numberOfEmployees','address','address2','description'))
    OR ("portable_standard_property_access"."kind"='deals' AND "portable_standard_property_access"."id" IN ('closedWonReason','closedLostReason','nextStep','description')))
);
--> statement-breakpoint
ALTER TABLE "portable_standard_property_access" ADD CONSTRAINT "portable_standard_property_access_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_standard_property_access" ADD CONSTRAINT "portable_standard_property_visible_team" FOREIGN KEY ("workspace_id","visible_team_id") REFERENCES "public"."portable_workspace_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;