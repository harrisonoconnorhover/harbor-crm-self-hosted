CREATE TABLE "portable_lead_form_activations" (
	"form_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portable_lead_forms" (
	"workspace_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "portable_lead_form_workspace_id" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "portable_lead_inquiries" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"received_at" bigint NOT NULL,
	"payload" jsonb,
	"fingerprint" text,
	"status" text NOT NULL,
	"contact_id" uuid,
	"removed_at" bigint,
	CONSTRAINT "portable_lead_inquiries_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portable_request_budgets" DROP CONSTRAINT "portable_request_budget_scope";--> statement-breakpoint
ALTER TABLE "contact_events" ALTER COLUMN "actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_events" ADD COLUMN "intake_form_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_lead_form_activations" ADD CONSTRAINT "portable_lead_form_activations_form_id_portable_lead_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."portable_lead_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_lead_forms" ADD CONSTRAINT "portable_lead_forms_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_lead_inquiries" ADD CONSTRAINT "portable_lead_inquiries_workspace_id_form_id_portable_lead_forms_workspace_id_id_fk" FOREIGN KEY ("workspace_id","form_id") REFERENCES "public"."portable_lead_forms"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_lead_inquiries_by_day" ON "portable_lead_inquiries" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "portable_lead_inquiries_by_form" ON "portable_lead_inquiries" USING btree ("workspace_id","form_id","received_at","id");--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_workspace_id_intake_form_id_portable_lead_forms_workspace_id_id_fk" FOREIGN KEY ("workspace_id","intake_form_id") REFERENCES "public"."portable_lead_forms"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_workspace_email" ON "contacts" USING btree ("workspace_id",lower("data"->>'email'));--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_event_attribution" CHECK (("contact_events"."actor_id" IS NULL) <> ("contact_events"."intake_form_id" IS NULL));--> statement-breakpoint
ALTER TABLE "portable_request_budgets" ADD CONSTRAINT "portable_request_budget_scope" CHECK (
    ("portable_request_budgets"."scope" IN ('login_start','login_callback') AND "portable_request_budgets"."subject"='')
    OR ("portable_request_budgets"."scope" IN ('api_read','api_write','public_form') AND "portable_request_budgets"."subject"<>'')
  );