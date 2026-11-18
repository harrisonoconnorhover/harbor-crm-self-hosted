CREATE TABLE "portable_record_activities" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"company_id" uuid,
	"deal_id" uuid,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"recorded_at" bigint NOT NULL,
	"summary" text NOT NULL,
	CONSTRAINT "portable_record_activities_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_record_activity_home" CHECK (num_nonnulls("portable_record_activities"."company_id","portable_record_activities"."deal_id") = 1),
	CONSTRAINT "portable_record_activity_kind" CHECK ("portable_record_activities"."kind" IN ('Note','Email','Call','Meeting','LinkedIn','SMS','WhatsApp','Postal mail'))
);
--> statement-breakpoint
ALTER TABLE "portable_record_activities" ADD CONSTRAINT "portable_record_activities_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_record_activities" ADD CONSTRAINT "portable_record_activity_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_record_activities" ADD CONSTRAINT "portable_record_activity_deal_fk" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_company_activity_order" ON "portable_record_activities" USING btree ("workspace_id","company_id","occurred_at","id") WHERE "portable_record_activities"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portable_deal_activity_order" ON "portable_record_activities" USING btree ("workspace_id","deal_id","occurred_at","id") WHERE "portable_record_activities"."deal_id" IS NOT NULL;