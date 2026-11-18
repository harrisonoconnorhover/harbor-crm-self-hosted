CREATE TABLE "portable_contact_activities" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"recorded_at" bigint NOT NULL,
	"summary" text NOT NULL,
	CONSTRAINT "portable_contact_activities_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_contact_activity_kind" CHECK ("portable_contact_activities"."kind" IN ('Call','Meeting','Email'))
);
--> statement-breakpoint
ALTER TABLE "portable_contact_activities" ADD CONSTRAINT "portable_contact_activities_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_contact_activities" ADD CONSTRAINT "portable_contact_activities_workspace_id_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_contact_activity_order" ON "portable_contact_activities" USING btree ("workspace_id","contact_id","occurred_at","id");