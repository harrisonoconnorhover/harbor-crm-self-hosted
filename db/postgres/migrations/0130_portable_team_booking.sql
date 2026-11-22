CREATE TABLE "portable_team_booking_hosts" (
	"workspace_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "portable_team_booking_hosts_workspace_id_booking_id_user_id_pk" PRIMARY KEY("workspace_id","booking_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "portable_team_bookings" (
	"id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"title" text NOT NULL,
	"email" text NOT NULL,
	"start_at" bigint NOT NULL,
	"end_at" bigint NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "portable_team_bookings_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_team_booking_span" CHECK ("portable_team_bookings"."end_at">"portable_team_bookings"."start_at")
);
--> statement-breakpoint
CREATE TABLE "portable_team_availability" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"grant_id" uuid,
	"windows" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"last_assigned_at" bigint,
	CONSTRAINT "portable_team_offer_limits" CHECK ("portable_team_availability"."revision">0 AND jsonb_typeof("portable_team_availability"."windows")='array' AND jsonb_array_length("portable_team_availability"."windows")<=12)
);
--> statement-breakpoint
CREATE TABLE "portable_team_calendars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"mode" text NOT NULL,
	"public_enabled" boolean DEFAULT false NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"duration" integer NOT NULL,
	"hosts" uuid[] NOT NULL,
	CONSTRAINT "portable_team_calendar_limits" CHECK (length("portable_team_calendars"."title") BETWEEN 1 AND 100 AND "portable_team_calendars"."mode" IN ('collective','rotation')
    AND "portable_team_calendars"."duration" IN (15,30,60) AND cardinality("portable_team_calendars"."hosts") BETWEEN 1 AND 12)
);
--> statement-breakpoint
ALTER TABLE "portable_team_booking_hosts" ADD CONSTRAINT "portable_team_booking_hosts_user_id_login_identities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_team_booking_hosts" ADD CONSTRAINT "portable_team_booking_hosts_workspace_id_booking_id_portable_team_bookings_workspace_id_id_fk" FOREIGN KEY ("workspace_id","booking_id") REFERENCES "public"."portable_team_bookings"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_team_bookings" ADD CONSTRAINT "portable_team_bookings_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_team_availability" ADD CONSTRAINT "portable_team_availability_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_team_availability" ADD CONSTRAINT "portable_team_availability_user_id_login_identities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_team_availability" ADD CONSTRAINT "portable_team_availability_grant_id_portable_workspace_viewers_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portable_workspace_viewers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "portable_team_calendars" ADD CONSTRAINT "portable_team_calendars_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_booked_host" ON "portable_team_booking_hosts" USING btree ("user_id","workspace_id","booking_id");--> statement-breakpoint
CREATE INDEX "portable_team_booking_upcoming" ON "portable_team_bookings" USING btree ("workspace_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portable_team_offer_member" ON "portable_team_availability" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "portable_team_calendar_workspace" ON "portable_team_calendars" USING btree ("workspace_id");