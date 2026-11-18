CREATE TABLE "portable_company_merge_receipts" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"primary_id" uuid NOT NULL,
	"secondary_id" uuid NOT NULL,
	"primary_revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"secondary_data" jsonb NOT NULL,
	"moved" jsonb NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_company_merge_receipts_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id"),
	CONSTRAINT "portable_company_merge_secondary" UNIQUE("workspace_id","secondary_id"),
	CONSTRAINT "portable_company_merge_pair" CHECK ("portable_company_merge_receipts"."primary_id"<>"portable_company_merge_receipts"."secondary_id")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_company_merge_receipts" ADD CONSTRAINT "portable_company_merge_receipts_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_company_merge_receipts" ADD CONSTRAINT "portable_company_merge_primary_fk" FOREIGN KEY ("workspace_id","primary_id") REFERENCES "public"."companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_company_merge_receipts" ADD CONSTRAINT "portable_company_merge_secondary_fk" FOREIGN KEY ("workspace_id","secondary_id") REFERENCES "public"."companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_merged_into_fk" FOREIGN KEY ("workspace_id","merged_into_id") REFERENCES "public"."companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_merged_archived" CHECK ("companies"."merged_into_id" IS NULL OR ("companies"."archived_at" IS NOT NULL AND "companies"."merged_into_id"<>"companies"."id"));