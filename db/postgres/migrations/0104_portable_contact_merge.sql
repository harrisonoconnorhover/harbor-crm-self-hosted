CREATE TABLE "portable_contact_merge_receipts" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"primary_id" uuid NOT NULL,
	"secondary_id" uuid NOT NULL,
	"primary_revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"secondary_data" jsonb NOT NULL,
	"secondary_company_id" uuid,
	"moved" jsonb NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_contact_merge_receipts_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id"),
	CONSTRAINT "portable_contact_merge_secondary" UNIQUE("workspace_id","secondary_id"),
	CONSTRAINT "portable_contact_merge_pair" CHECK ("portable_contact_merge_receipts"."primary_id"<>"portable_contact_merge_receipts"."secondary_id")
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_contact_merge_receipts" ADD CONSTRAINT "portable_contact_merge_receipts_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_contact_merge_receipts" ADD CONSTRAINT "portable_contact_merge_primary_fk" FOREIGN KEY ("workspace_id","primary_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_contact_merge_receipts" ADD CONSTRAINT "portable_contact_merge_secondary_fk" FOREIGN KEY ("workspace_id","secondary_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_into_fk" FOREIGN KEY ("workspace_id","merged_into_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_archived" CHECK ("contacts"."merged_into_id" IS NULL OR ("contacts"."archived_at" IS NOT NULL AND "contacts"."merged_into_id"<>"contacts"."id"));