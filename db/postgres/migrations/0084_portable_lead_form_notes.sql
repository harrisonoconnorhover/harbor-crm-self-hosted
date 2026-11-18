CREATE TABLE "portable_lead_form_note_sources" (
	"workspace_id" uuid NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"form_revision" integer NOT NULL,
	"contact_id" uuid,
	"owner_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"state" text NOT NULL,
	"next_at" bigint,
	"issue" text,
	CONSTRAINT "portable_lead_form_note_sources_workspace_id_inquiry_id_pk" PRIMARY KEY("workspace_id","inquiry_id"),
	CONSTRAINT "portable_lead_form_note_source_job" UNIQUE("workspace_id","job_id"),
	CONSTRAINT "portable_lead_form_note_source_state" CHECK ("portable_lead_form_note_sources"."state" IN ('awaiting_contact','waiting','queued','skipped')),
	CONSTRAINT "portable_lead_form_note_source_contact" CHECK ("portable_lead_form_note_sources"."state" NOT IN ('waiting','queued') OR "portable_lead_form_note_sources"."contact_id" IS NOT NULL),
	CONSTRAINT "portable_lead_form_note_source_due" CHECK (("portable_lead_form_note_sources"."state"='waiting') = ("portable_lead_form_note_sources"."next_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "portable_lead_form_note_sources" ADD CONSTRAINT "portable_lead_form_note_sources_owner_id_login_identities_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_lead_form_note_sources" ADD CONSTRAINT "portable_lead_form_note_source_inquiry_fk" FOREIGN KEY ("workspace_id","inquiry_id") REFERENCES "public"."portable_lead_inquiries"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_lead_form_note_sources" ADD CONSTRAINT "portable_lead_form_note_source_form_fk" FOREIGN KEY ("workspace_id","form_id") REFERENCES "public"."portable_lead_forms"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_lead_form_note_source_pending" ON "portable_lead_form_note_sources" USING btree ("workspace_id","form_id") WHERE "portable_lead_form_note_sources"."state" IN ('awaiting_contact','waiting');--> statement-breakpoint
CREATE INDEX "portable_lead_form_note_source_ready" ON "portable_lead_form_note_sources" USING btree ("next_at","workspace_id","inquiry_id") WHERE "portable_lead_form_note_sources"."state"='waiting';