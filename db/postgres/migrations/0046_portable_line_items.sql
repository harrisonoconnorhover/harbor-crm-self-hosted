CREATE TABLE "portable_line_item_sets" (
	"workspace_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"amount_metric" text NOT NULL,
	"items" jsonb NOT NULL,
	CONSTRAINT "portable_line_item_sets_workspace_id_deal_id_pk" PRIMARY KEY("workspace_id","deal_id")
);
--> statement-breakpoint
ALTER TABLE "portable_line_item_sets" ADD CONSTRAINT "portable_line_item_sets_workspace_id_deal_id_deals_workspace_id_id_fk" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE no action ON UPDATE no action;