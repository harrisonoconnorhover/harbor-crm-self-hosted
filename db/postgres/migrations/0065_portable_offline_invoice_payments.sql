CREATE TABLE "portable_invoice_payments" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"creation_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"unapplied_at" timestamp with time zone,
	"unapply_reason" text,
	CONSTRAINT "portable_invoice_payments_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portable_invoice_events" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "portable_invoices" ADD COLUMN "paid_cents" bigint;--> statement-breakpoint
ALTER TABLE "portable_invoice_payments" ADD CONSTRAINT "portable_invoice_payment_invoice_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."portable_invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_invoice_payments_by_revision" ON "portable_invoice_payments" USING btree ("workspace_id","invoice_id","revision");