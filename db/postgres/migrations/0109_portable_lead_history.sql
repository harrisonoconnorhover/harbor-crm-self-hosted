CREATE TABLE "portable_lead_events" (
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"previous" jsonb,
	"data" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_lead_events_workspace_id_lead_id_revision_pk" PRIMARY KEY("workspace_id","lead_id","revision")
);
--> statement-breakpoint
ALTER TABLE "portable_lead_events" ADD CONSTRAINT "portable_lead_events_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_lead_events" ADD CONSTRAINT "portable_lead_event_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "public"."portable_leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;