ALTER TABLE "portable_lead_events" ALTER COLUMN "actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_lead_inquiries" ADD COLUMN "route_lead_revision" integer;--> statement-breakpoint
ALTER TABLE "portable_lead_events" ADD COLUMN "intake_form_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_lead_events" ADD CONSTRAINT "portable_lead_event_form_fk" FOREIGN KEY ("workspace_id","intake_form_id") REFERENCES "public"."portable_lead_forms"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_leads_contact_open" ON "portable_leads" USING btree ("workspace_id","contact_id") WHERE "portable_leads"."archived_at" IS NULL AND "portable_leads"."deal_id" IS NULL;--> statement-breakpoint
ALTER TABLE "portable_lead_events" ADD CONSTRAINT "portable_lead_event_source" CHECK (num_nonnulls("portable_lead_events"."actor_id","portable_lead_events"."intake_form_id") = 1);