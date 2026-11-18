CREATE TABLE "portable_activity_removals" (
	"workspace_id" uuid NOT NULL,
	"record_kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"removed_at" bigint NOT NULL,
	"removed_by_id" text NOT NULL,
	"removed_by" text NOT NULL,
	CONSTRAINT "portable_activity_removals_workspace_id_record_kind_id_pk" PRIMARY KEY("workspace_id","record_kind","id"),
	CONSTRAINT "portable_activity_removal_home" CHECK ("portable_activity_removals"."record_kind" IN ('contacts','companies','deals'))
);
--> statement-breakpoint
ALTER TABLE "portable_activity_removals" ADD CONSTRAINT "portable_activity_removals_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_activity_removal_order" ON "portable_activity_removals" USING btree ("workspace_id","record_kind","record_id","removed_at","id");