CREATE TABLE "portable_ticket_events" (
	"workspace_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"previous" jsonb,
	"data" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_ticket_events_workspace_id_ticket_id_revision_pk" PRIMARY KEY("workspace_id","ticket_id","revision")
);
--> statement-breakpoint
CREATE TABLE "portable_tickets" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"data" jsonb NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_tickets_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_ticket_close_date" CHECK (("portable_tickets"."data"->>'ticketStatus' = 'Closed') IS NOT DISTINCT FROM ("portable_tickets"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "portable_ticket_events" ADD CONSTRAINT "portable_ticket_events_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_ticket_events" ADD CONSTRAINT "portable_ticket_event_ticket_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."portable_tickets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_tickets" ADD CONSTRAINT "portable_tickets_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_tickets" ADD CONSTRAINT "portable_ticket_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_tickets" ADD CONSTRAINT "portable_ticket_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_ticket_contact_order" ON "portable_tickets" USING btree ("workspace_id","contact_id","id");--> statement-breakpoint
CREATE INDEX "portable_ticket_company_order" ON "portable_tickets" USING btree ("workspace_id","company_id","id");--> statement-breakpoint
CREATE INDEX "portable_ticket_status_order" ON "portable_tickets" USING btree ("workspace_id",("data"->>'ticketStatus'),"id");