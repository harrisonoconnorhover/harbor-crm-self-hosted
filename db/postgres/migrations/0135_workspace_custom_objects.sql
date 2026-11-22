CREATE TABLE "portable_object_links" (
	"workspace_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"deal_id" uuid,
	CONSTRAINT "portable_object_links_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "object_link_one_target" CHECK (num_nonnulls("portable_object_links"."contact_id","portable_object_links"."company_id","portable_object_links"."deal_id")=1)
);
--> statement-breakpoint
CREATE TABLE "portable_object_records" (
	"workspace_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "portable_object_records_workspace_id_object_id_id_pk" PRIMARY KEY("workspace_id","object_id","id"),
	CONSTRAINT "object_record_valid" CHECK (length("portable_object_records"."name") BETWEEN 1 AND 100 AND "portable_object_records"."revision">0 AND jsonb_typeof("portable_object_records"."data"->'values') IS NOT DISTINCT FROM 'object')
);
--> statement-breakpoint
CREATE TABLE "portable_object_types" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "portable_object_types_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "object_type_definition" CHECK ("portable_object_types"."revision">0 AND jsonb_typeof("portable_object_types"."definition"->'name') IS NOT DISTINCT FROM 'string' AND jsonb_typeof("portable_object_types"."definition"->'fields') IS NOT DISTINCT FROM 'array' AND length("portable_object_types"."definition"->>'name') BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "portable_object_links" ADD CONSTRAINT "object_link_record" FOREIGN KEY ("workspace_id","object_id","record_id") REFERENCES "public"."portable_object_records"("workspace_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_object_links" ADD CONSTRAINT "object_link_contact" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_object_links" ADD CONSTRAINT "object_link_company" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."companies"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_object_links" ADD CONSTRAINT "object_link_deal" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_object_records" ADD CONSTRAINT "object_record_definition" FOREIGN KEY ("workspace_id","object_id") REFERENCES "public"."portable_object_types"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_object_types" ADD CONSTRAINT "portable_object_types_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "object_link_record_page" ON "portable_object_links" USING btree ("workspace_id","object_id","record_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "object_link_contact_id" ON "portable_object_links" USING btree ("workspace_id","contact_id","object_id","record_id") WHERE "portable_object_links"."contact_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "object_link_company_id" ON "portable_object_links" USING btree ("workspace_id","company_id","object_id","record_id") WHERE "portable_object_links"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "object_link_deal_id" ON "portable_object_links" USING btree ("workspace_id","deal_id","object_id","record_id") WHERE "portable_object_links"."deal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "object_record_name_search" ON "portable_object_records" USING gin ("name" public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "object_record_active_page" ON "portable_object_records" USING btree ("workspace_id","object_id","id") WHERE "portable_object_records"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_object_type_name" ON "portable_object_types" USING btree ("workspace_id",lower("definition"->>'name'));