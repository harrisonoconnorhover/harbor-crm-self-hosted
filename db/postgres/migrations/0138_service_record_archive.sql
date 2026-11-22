CREATE TABLE "portable_service_archive_receipts" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"lead_id" uuid,
	"ticket_id" uuid,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_service_archive_receipts_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id"),
	CONSTRAINT "service_archive_valid" CHECK (num_nonnulls("portable_service_archive_receipts"."lead_id","portable_service_archive_receipts"."ticket_id")=1 AND "portable_service_archive_receipts"."action" IN ('archive','restore') AND "portable_service_archive_receipts"."revision">1)
);
--> statement-breakpoint
ALTER TABLE "portable_leads" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portable_tickets" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portable_service_archive_receipts" ADD CONSTRAINT "portable_service_archive_receipts_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_service_archive_receipts" ADD CONSTRAINT "service_archive_lead" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "public"."portable_leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_service_archive_receipts" ADD CONSTRAINT "service_archive_ticket" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."portable_tickets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_archive_lead_history" ON "portable_service_archive_receipts" USING btree ("workspace_id","lead_id","revision") WHERE "portable_service_archive_receipts"."lead_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "service_archive_ticket_history" ON "portable_service_archive_receipts" USING btree ("workspace_id","ticket_id","revision") WHERE "portable_service_archive_receipts"."ticket_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portable_leads_archive_page" ON "portable_leads" USING btree ("workspace_id","id") WHERE "portable_leads"."archived_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "portable_tickets_archive_page" ON "portable_tickets" USING btree ("workspace_id","id") WHERE "portable_tickets"."archived_at" IS NOT NULL;