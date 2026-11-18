CREATE TABLE "portable_invoice_events" (
	"workspace_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_invoice_events_workspace_id_invoice_id_revision_pk" PRIMARY KEY("workspace_id","invoice_id","revision")
);
--> statement-breakpoint
CREATE TABLE "portable_invoices" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"deal_created_at" timestamp with time zone NOT NULL,
	"deal_name" text NOT NULL,
	"quote_id" uuid,
	"quote_version" integer,
	"source_note" text NOT NULL,
	"revision" integer NOT NULL,
	"creation_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"total_cents" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_invoices_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portable_invoice_events" ADD CONSTRAINT "portable_invoice_events_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_invoice_events" ADD CONSTRAINT "portable_invoice_events_invoice_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."portable_invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_invoices" ADD CONSTRAINT "portable_invoice_deal_fk" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_invoices" ADD CONSTRAINT "portable_invoice_quote_version_fk" FOREIGN KEY ("workspace_id","quote_id","quote_version") REFERENCES "public"."portable_quote_versions"("workspace_id","quote_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_invoices_by_deal" ON "portable_invoices" USING btree ("workspace_id","deal_id","id");--> statement-breakpoint
CREATE INDEX "portable_invoices_by_quote" ON "portable_invoices" USING btree ("workspace_id","quote_id","id");