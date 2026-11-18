CREATE TABLE "portable_calendar_reschedules" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"start_at" bigint NOT NULL,
	"end_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "portable_calendar_reschedules_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_calendar_reschedule_status" CHECK ("portable_calendar_reschedules"."status" IN ('submitting','attention','applied','rejected'))
);
--> statement-breakpoint
ALTER TABLE "portable_calendar_meetings" ADD COLUMN "reschedule_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_calendar_meetings" ADD COLUMN "rescheduled_time_zone" text;--> statement-breakpoint
ALTER TABLE "portable_calendar_reschedules" ADD CONSTRAINT "portable_calendar_reschedules_workspace_id_meeting_id_portable_calendar_meetings_workspace_id_id_fk" FOREIGN KEY ("workspace_id","meeting_id") REFERENCES "public"."portable_calendar_meetings"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_calendar_one_active_reschedule" ON "portable_calendar_reschedules" USING btree ("workspace_id","meeting_id") WHERE "portable_calendar_reschedules"."status" IN ('submitting','attention');--> statement-breakpoint
CREATE INDEX "portable_calendar_reschedule_overlap" ON "portable_calendar_reschedules" USING btree ("workspace_id","end_at") WHERE "portable_calendar_reschedules"."status" IN ('submitting','attention');--> statement-breakpoint
CREATE INDEX "portable_calendar_reschedule_monitor" ON "portable_calendar_reschedules" USING btree ("status","created_at") WHERE "portable_calendar_reschedules"."status" IN ('submitting','attention');