CREATE TABLE "portable_contact_archive_receipts" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "portable_contact_archive_receipts_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id"),
	CONSTRAINT "portable_contact_archive_receipt_action" CHECK (("portable_contact_archive_receipts"."action"='archive' AND "portable_contact_archive_receipts"."archived_at" IS NOT NULL)
    OR ("portable_contact_archive_receipts"."action"='restore' AND "portable_contact_archive_receipts"."archived_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "portable_contact_archive_receipts" ADD CONSTRAINT "portable_contact_archive_receipt_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;