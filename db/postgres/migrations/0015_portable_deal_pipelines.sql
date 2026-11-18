CREATE TABLE "deal_pipeline_stages" (
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"outcome" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "deal_pipeline_stages_workspace_id_pipeline_id_id_pk" PRIMARY KEY("workspace_id","pipeline_id","id"),
	CONSTRAINT "deal_pipeline_stage_outcome" CHECK ("deal_pipeline_stages"."outcome" IN ('open','won','lost'))
);
--> statement-breakpoint
CREATE TABLE "deal_pipelines" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "deal_pipelines_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "deal_events" ADD COLUMN "previous_pipeline_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_events" ADD COLUMN "previous_stage_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_events" ADD COLUMN "pipeline_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_events" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "pipeline_id" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_pipeline_stages" ADD CONSTRAINT "deal_pipeline_stages_workspace_id_pipeline_id_deal_pipelines_workspace_id_id_fk" FOREIGN KEY ("workspace_id","pipeline_id") REFERENCES "public"."deal_pipelines"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_pipelines" ADD CONSTRAINT "deal_pipelines_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_pipeline_stage_order" ON "deal_pipeline_stages" USING btree ("workspace_id","pipeline_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_pipelines_workspace_name" ON "deal_pipelines" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_workspace_id_pipeline_id_stage_id_deal_pipeline_stages_workspace_id_pipeline_id_id_fk" FOREIGN KEY ("workspace_id","pipeline_id","stage_id") REFERENCES "public"."deal_pipeline_stages"("workspace_id","pipeline_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deals_workspace_pipeline" ON "deals" USING btree ("workspace_id","pipeline_id","stage_id","id");--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_custom_stage_pair" CHECK (("deals"."pipeline_id" IS NULL) = ("deals"."stage_id" IS NULL));