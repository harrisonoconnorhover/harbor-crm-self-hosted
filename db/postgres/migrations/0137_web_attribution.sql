CREATE TABLE "portable_form_conversions" (
	"workspace_id" uuid NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"converted_at" bigint NOT NULL,
	"total" integer NOT NULL,
	"first_source" text NOT NULL,
	"last_source" text NOT NULL,
	"counts" jsonb NOT NULL,
	"path" jsonb NOT NULL,
	CONSTRAINT "portable_form_conversions_workspace_id_inquiry_id_pk" PRIMARY KEY("workspace_id","inquiry_id"),
	CONSTRAINT "form_conversion_valid" CHECK ("portable_form_conversions"."total">0 AND "portable_form_conversions"."converted_at">0 AND jsonb_typeof("portable_form_conversions"."counts")='object'
    AND jsonb_typeof("portable_form_conversions"."path")='array' AND jsonb_array_length("portable_form_conversions"."path")=least(100,"portable_form_conversions"."total"))
);
--> statement-breakpoint
CREATE TABLE "portable_page_events" (
	"site_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sequence" bigserial NOT NULL,
	"visitor_hash" text NOT NULL,
	"at" bigint NOT NULL,
	"path" text NOT NULL,
	"source" text NOT NULL,
	"medium" text NOT NULL,
	"campaign" text NOT NULL,
	CONSTRAINT "portable_page_events_site_id_event_id_pk" PRIMARY KEY("site_id","event_id"),
	CONSTRAINT "page_event_valid" CHECK ("portable_page_events"."visitor_hash" ~ '^[0-9a-f]{64}$' AND "portable_page_events"."at">0 AND left("portable_page_events"."path",1)='/' AND length("portable_page_events"."path")<=1024
    AND length("portable_page_events"."source") BETWEEN 1 AND 256 AND length("portable_page_events"."medium")<=256 AND length("portable_page_events"."campaign")<=256)
);
--> statement-breakpoint
CREATE TABLE "portable_tracking_sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tracking_site_workspace" UNIQUE("workspace_id","id"),
	CONSTRAINT "tracking_site_origin" UNIQUE("workspace_id","origin"),
	CONSTRAINT "tracking_site_definition" CHECK ("portable_tracking_sites"."revision">0 AND length("portable_tracking_sites"."name") BETWEEN 1 AND 100 AND length("portable_tracking_sites"."origin") BETWEEN 1 AND 2048)
);
--> statement-breakpoint
ALTER TABLE "portable_form_conversions" ADD CONSTRAINT "form_conversion_site" FOREIGN KEY ("workspace_id","site_id") REFERENCES "public"."portable_tracking_sites"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_form_conversions" ADD CONSTRAINT "form_conversion_inquiry" FOREIGN KEY ("workspace_id","inquiry_id") REFERENCES "public"."portable_lead_inquiries"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_page_events" ADD CONSTRAINT "portable_page_events_site_id_portable_tracking_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portable_tracking_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_tracking_sites" ADD CONSTRAINT "portable_tracking_sites_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_conversion_site_period" ON "portable_form_conversions" USING btree ("workspace_id","site_id","converted_at");--> statement-breakpoint
CREATE INDEX "form_conversion_workspace_period" ON "portable_form_conversions" USING btree ("workspace_id","converted_at","inquiry_id");--> statement-breakpoint
CREATE INDEX "form_conversion_expiry" ON "portable_form_conversions" USING btree ("converted_at");--> statement-breakpoint
CREATE INDEX "page_event_visitor_journey" ON "portable_page_events" USING btree ("site_id","visitor_hash","at","sequence");--> statement-breakpoint
CREATE INDEX "page_event_site_period" ON "portable_page_events" USING btree ("site_id","at");--> statement-breakpoint
CREATE INDEX "page_event_expiry" ON "portable_page_events" USING btree ("at");