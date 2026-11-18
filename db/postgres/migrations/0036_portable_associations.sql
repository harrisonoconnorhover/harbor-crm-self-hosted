CREATE TABLE "portable_associations" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"first_kind" text NOT NULL,
	"first_id" uuid NOT NULL,
	"second_kind" text NOT NULL,
	"second_id" uuid NOT NULL,
	"labels" jsonb NOT NULL,
	CONSTRAINT "portable_associations_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_association_pair" UNIQUE("workspace_id","first_kind","first_id","second_kind","second_id"),
	CONSTRAINT "portable_association_kinds" CHECK ("portable_associations"."first_kind" IN ('companies','contacts','deals') AND "portable_associations"."second_kind" IN ('companies','contacts','deals')),
	CONSTRAINT "portable_association_order" CHECK (("portable_associations"."first_kind","portable_associations"."first_id") < ("portable_associations"."second_kind","portable_associations"."second_id"))
);
--> statement-breakpoint
ALTER TABLE "portable_associations" ADD CONSTRAINT "portable_associations_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_association_first" ON "portable_associations" USING btree ("workspace_id","first_kind","first_id","id");--> statement-breakpoint
CREATE INDEX "portable_association_second" ON "portable_associations" USING btree ("workspace_id","second_kind","second_id","id");