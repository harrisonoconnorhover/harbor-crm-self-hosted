ALTER TABLE "portable_tasks" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD CONSTRAINT "portable_task_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."companies"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD CONSTRAINT "portable_task_deal_fk" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_task_company_order" ON "portable_tasks" USING btree ("workspace_id","company_id","id");--> statement-breakpoint
CREATE INDEX "portable_task_deal_order" ON "portable_tasks" USING btree ("workspace_id","deal_id","id");--> statement-breakpoint
ALTER TABLE "portable_tasks" ADD CONSTRAINT "portable_task_single_link" CHECK (num_nonnulls("portable_tasks"."contact_id","portable_tasks"."company_id","portable_tasks"."deal_id") <= 1);