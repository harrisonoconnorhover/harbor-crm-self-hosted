ALTER TABLE "portable_invoices" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "portable_invoices" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "portable_invoices" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_invoice_workspace_number" ON "portable_invoices" USING btree ("workspace_id","number");