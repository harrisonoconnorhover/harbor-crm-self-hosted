CREATE TABLE "portable_calendar_meetings" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"account_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"start_at" bigint NOT NULL,
	"end_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"status" text NOT NULL,
	"event_url" text,
	CONSTRAINT "portable_calendar_meetings_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_calendar_meeting_status" CHECK ("portable_calendar_meetings"."status" IN ('submitting','attention','scheduled','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "portable_calendar_meetings" ADD CONSTRAINT "portable_calendar_meetings_owner_id_login_identities_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_calendar_meetings" ADD CONSTRAINT "portable_calendar_meetings_workspace_id_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_calendar_meeting_history" ON "portable_calendar_meetings" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "portable_calendar_meeting_overlap" ON "portable_calendar_meetings" USING btree ("workspace_id","end_at") WHERE "portable_calendar_meetings"."status"<>'cancelled';