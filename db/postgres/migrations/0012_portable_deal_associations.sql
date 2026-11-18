ALTER TABLE "deal_events" ADD COLUMN "previous_company_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_events" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_events" ADD COLUMN "previous_primary_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_events" ADD COLUMN "primary_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "primary_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_workspace_id_company_id_companies_workspace_id_id_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_workspace_id_primary_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","primary_contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deals_workspace_company" ON "deals" USING btree ("workspace_id","company_id");--> statement-breakpoint
CREATE INDEX "deals_workspace_contact" ON "deals" USING btree ("workspace_id","primary_contact_id");