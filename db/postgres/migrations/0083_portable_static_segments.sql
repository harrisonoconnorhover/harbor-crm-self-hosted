CREATE TABLE "portable_segment_members" (
	"workspace_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	CONSTRAINT "portable_segment_members_workspace_id_segment_id_contact_id_pk" PRIMARY KEY("workspace_id","segment_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "portable_segment_membership_receipts" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"static_generation" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "portable_segment_membership_receipts_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id"),
	CONSTRAINT "portable_segment_membership_receipts_revision" CHECK ("portable_segment_membership_receipts"."revision" > 1)
);
--> statement-breakpoint
ALTER TABLE "portable_segments" ADD COLUMN "mode" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_segments" ADD COLUMN "static_generation" uuid;--> statement-breakpoint
ALTER TABLE "portable_segment_members" ADD CONSTRAINT "portable_segment_members_segment_fk" FOREIGN KEY ("workspace_id","segment_id") REFERENCES "public"."portable_segments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_segment_members" ADD CONSTRAINT "portable_segment_members_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_segment_membership_receipts" ADD CONSTRAINT "portable_segment_membership_receipts_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_segment_members_contact" ON "portable_segment_members" USING btree ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX "portable_segments_active_picker" ON "portable_segments" USING btree ("workspace_id","id") WHERE "portable_segments"."mode" = 'active';--> statement-breakpoint
ALTER TABLE "portable_segments" ADD CONSTRAINT "portable_segments_mode_identity" CHECK (
    ("portable_segments"."mode" = 'active' AND "portable_segments"."static_generation" IS NULL)
    OR ("portable_segments"."mode" = 'static' AND "portable_segments"."static_generation" IS NOT NULL)
  );