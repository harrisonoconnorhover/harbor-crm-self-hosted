CREATE TABLE "contact_events" (
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"previous" jsonb,
	"data" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contact_events_workspace_id_contact_id_revision_pk" PRIMARY KEY("workspace_id","contact_id","revision")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contacts_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "private_workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	CONSTRAINT "private_workspaces_owner_id_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_workspace_id_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_workspaces" ADD CONSTRAINT "private_workspaces_owner_id_login_identities_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_events_time" ON "contact_events" USING btree ("workspace_id","occurred_at");