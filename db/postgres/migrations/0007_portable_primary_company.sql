ALTER TABLE "contact_events" ADD COLUMN "previous_primary_company_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_events" ADD COLUMN "primary_company_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "primary_company_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_primary_company_fk" FOREIGN KEY ("workspace_id","primary_company_id") REFERENCES "public"."companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_primary_company" ON "contacts" USING btree ("workspace_id","primary_company_id");