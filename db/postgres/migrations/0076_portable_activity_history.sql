CREATE TABLE "portable_activity_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_activity_id" uuid,
	"record_activity_id" uuid,
	"revision" integer NOT NULL,
	"editor_id" text NOT NULL,
	"editor_name" text NOT NULL,
	"edited_at" bigint NOT NULL,
	"previous_at" bigint NOT NULL,
	"previous_summary" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"summary" text NOT NULL,
	CONSTRAINT "portable_activity_history_contact_revision" UNIQUE("workspace_id","contact_activity_id","revision"),
	CONSTRAINT "portable_activity_history_record_revision" UNIQUE("workspace_id","record_activity_id","revision"),
	CONSTRAINT "portable_activity_history_home" CHECK (num_nonnulls("portable_activity_history"."contact_activity_id","portable_activity_history"."record_activity_id")=1)
);
--> statement-breakpoint
ALTER TABLE "portable_activity_history" ADD CONSTRAINT "portable_activity_history_editor_id_login_identities_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_activity_history" ADD CONSTRAINT "portable_activity_history_contact_fk" FOREIGN KEY ("workspace_id","contact_activity_id") REFERENCES "public"."portable_contact_activities"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_activity_history" ADD CONSTRAINT "portable_activity_history_record_fk" FOREIGN KEY ("workspace_id","record_activity_id") REFERENCES "public"."portable_record_activities"("workspace_id","id") ON DELETE cascade ON UPDATE no action;