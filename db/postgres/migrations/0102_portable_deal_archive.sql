CREATE TABLE "portable_deal_archive_receipts" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "portable_deal_archive_receipts_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id"),
	CONSTRAINT "portable_deal_archive_receipt_action" CHECK (("portable_deal_archive_receipts"."action"='archive' AND "portable_deal_archive_receipts"."archived_at" IS NOT NULL)
    OR ("portable_deal_archive_receipts"."action"='restore' AND "portable_deal_archive_receipts"."archived_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portable_deal_archive_receipts" ADD CONSTRAINT "portable_deal_archive_receipt_deal_fk" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE no action ON UPDATE no action;