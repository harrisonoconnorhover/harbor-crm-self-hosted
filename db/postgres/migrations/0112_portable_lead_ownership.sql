ALTER TABLE "portable_leads" ADD COLUMN "assignee_id" text;--> statement-breakpoint
ALTER TABLE "portable_leads" ADD COLUMN "assignee_label" text;--> statement-breakpoint
ALTER TABLE "portable_leads" ADD CONSTRAINT "portable_leads_assignee_id_login_identities_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_leads_workspace_assignee" ON "portable_leads" USING btree ("workspace_id","assignee_id","id");--> statement-breakpoint
ALTER TABLE "portable_leads" ADD CONSTRAINT "portable_leads_assignee_label" CHECK (("portable_leads"."assignee_id" IS NULL) = ("portable_leads"."assignee_label" IS NULL));