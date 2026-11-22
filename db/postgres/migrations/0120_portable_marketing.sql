CREATE TABLE "portable_marketing_audience_accounts" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"generation" uuid NOT NULL,
	"fields" jsonb NOT NULL,
	CONSTRAINT "portable_marketing_audience_accounts_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "portable_marketing_audience_contacts" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"generation" uuid NOT NULL,
	"email" text,
	"account_id" text,
	"eligible" boolean NOT NULL,
	CONSTRAINT "portable_marketing_audience_contacts_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "portable_marketing_audience_related" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"generation" uuid NOT NULL,
	"account_id" text,
	"fields" jsonb NOT NULL,
	CONSTRAINT "portable_marketing_audience_related_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "portable_marketing_audience_sync" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"generation" uuid NOT NULL,
	"source_key" text NOT NULL,
	"state" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"progressed_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"contact_count" integer DEFAULT 0 NOT NULL,
	"account_count" integer DEFAULT 0 NOT NULL,
	"related_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portable_marketing_designs" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"project" text NOT NULL,
	"html" text NOT NULL,
	"plain_text" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "portable_marketing_designs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "portable_marketing_form_deliveries" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"destination" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"next_at" bigint,
	"issue" text,
	"receipt" text,
	CONSTRAINT "portable_marketing_form_deliveries_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "marketing_form_once" UNIQUE("workspace_id","inquiry_id","kind","destination"),
	CONSTRAINT "marketing_form_delivery_kind" CHECK ("portable_marketing_form_deliveries"."kind" IN ('email','salesforce')),
	CONSTRAINT "marketing_form_delivery_state" CHECK ("portable_marketing_form_deliveries"."state" IN ('pending','sending','succeeded','uncertain','failed','skipped')),
	CONSTRAINT "marketing_form_delivery_due" CHECK (("portable_marketing_form_deliveries"."next_at" IS NOT NULL) = ("portable_marketing_form_deliveries"."state" IN ('pending','sending')))
);
--> statement-breakpoint
CREATE TABLE "portable_marketing_form_routes" (
	"workspace_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"recipients" jsonb NOT NULL,
	"salesforce_target" text,
	CONSTRAINT "portable_marketing_form_routes_workspace_id_form_id_pk" PRIMARY KEY("workspace_id","form_id")
);
--> statement-breakpoint
CREATE TABLE "portable_marketing_campaign_activations" (
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	CONSTRAINT "marketing_campaign_activation_pk" PRIMARY KEY("workspace_id","campaign_id")
);
--> statement-breakpoint
CREATE TABLE "portable_marketing_campaigns" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb NOT NULL,
	"source_key" text NOT NULL,
	"design_id" uuid NOT NULL,
	"design_revision" integer NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"plain_text" text NOT NULL,
	"created_at" bigint NOT NULL,
	"send_after" bigint,
	"paused" boolean DEFAULT false NOT NULL,
	"audience_size" integer NOT NULL,
	CONSTRAINT "portable_marketing_campaigns_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "portable_marketing_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"email" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"due_at" bigint DEFAULT 0 NOT NULL,
	"provider_id" text,
	"last_issue" text,
	CONSTRAINT "portable_marketing_once_per_recipient" UNIQUE("workspace_id","campaign_id","email"),
	CONSTRAINT "portable_marketing_recipient_state" CHECK ("portable_marketing_recipients"."state" IN ('queued','sending','accepted','delivered','retry','uncertain','failed','skipped','bounced','complained'))
);
--> statement-breakpoint
ALTER TABLE "portable_marketing_audience_accounts" ADD CONSTRAINT "portable_marketing_audience_accounts_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_audience_contacts" ADD CONSTRAINT "portable_marketing_audience_contacts_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_audience_related" ADD CONSTRAINT "portable_marketing_audience_related_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_audience_sync" ADD CONSTRAINT "portable_marketing_audience_sync_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_designs" ADD CONSTRAINT "portable_marketing_designs_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_form_deliveries" ADD CONSTRAINT "marketing_delivery_source_fk" FOREIGN KEY ("workspace_id","inquiry_id") REFERENCES "public"."portable_lead_inquiries"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_form_deliveries" ADD CONSTRAINT "marketing_delivery_form_fk" FOREIGN KEY ("workspace_id","form_id") REFERENCES "public"."portable_lead_forms"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_form_routes" ADD CONSTRAINT "marketing_route_form_fk" FOREIGN KEY ("workspace_id","form_id") REFERENCES "public"."portable_lead_forms"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_campaign_activations" ADD CONSTRAINT "marketing_campaign_activation_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."portable_marketing_campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_campaigns" ADD CONSTRAINT "portable_marketing_campaigns_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_marketing_recipients" ADD CONSTRAINT "marketing_recipient_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."portable_marketing_campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_marketing_audience_email" ON "portable_marketing_audience_contacts" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "portable_marketing_audience_related_account" ON "portable_marketing_audience_related" USING btree ("workspace_id","account_id");--> statement-breakpoint
CREATE INDEX "marketing_form_delivery_ready" ON "portable_marketing_form_deliveries" USING btree ("workspace_id","next_at","id") WHERE "portable_marketing_form_deliveries"."state" IN ('pending','sending');--> statement-breakpoint
CREATE INDEX "marketing_form_delivery_recent" ON "portable_marketing_form_deliveries" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "portable_marketing_campaign_order" ON "portable_marketing_campaigns" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "portable_marketing_ready" ON "portable_marketing_recipients" USING btree ("workspace_id","due_at","id") WHERE "portable_marketing_recipients"."state" IN ('queued','retry','sending');--> statement-breakpoint
CREATE INDEX "portable_marketing_campaign_state" ON "portable_marketing_recipients" USING btree ("workspace_id","campaign_id","state");