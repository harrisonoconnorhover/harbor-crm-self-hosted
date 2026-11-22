CREATE TABLE "portable_custom_record_links" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"left_object_id" uuid NOT NULL,
	"left_record_id" uuid NOT NULL,
	"right_object_id" uuid NOT NULL,
	"right_record_id" uuid NOT NULL,
	CONSTRAINT "portable_custom_record_links_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "custom_link_order" CHECK (("portable_custom_record_links"."left_object_id","portable_custom_record_links"."left_record_id") < ("portable_custom_record_links"."right_object_id","portable_custom_record_links"."right_record_id"))
);
--> statement-breakpoint
ALTER TABLE "portable_custom_record_links" ADD CONSTRAINT "custom_link_left_record" FOREIGN KEY ("workspace_id","left_object_id","left_record_id") REFERENCES "public"."portable_object_records"("workspace_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_custom_record_links" ADD CONSTRAINT "custom_link_right_record" FOREIGN KEY ("workspace_id","right_object_id","right_record_id") REFERENCES "public"."portable_object_records"("workspace_id","object_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_link_pair" ON "portable_custom_record_links" USING btree ("workspace_id","left_object_id","left_record_id","right_object_id","right_record_id");--> statement-breakpoint
CREATE INDEX "custom_link_left_page" ON "portable_custom_record_links" USING btree ("workspace_id","left_object_id","left_record_id","id");--> statement-breakpoint
CREATE INDEX "custom_link_right_page" ON "portable_custom_record_links" USING btree ("workspace_id","right_object_id","right_record_id","id");