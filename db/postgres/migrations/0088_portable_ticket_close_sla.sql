CREATE TABLE "portable_ticket_close_sla_policies" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"targets" jsonb NOT NULL,
	"warning_minutes" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portable_ticket_close_sla_receipts" (
	"workspace_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"policy_revision" integer NOT NULL,
	"priority" text NOT NULL,
	"target_minutes" integer NOT NULL,
	"warning_minutes" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"warning_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"applied_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_ticket_close_sla_receipts_workspace_id_ticket_id_pk" PRIMARY KEY("workspace_id","ticket_id")
);
--> statement-breakpoint
ALTER TABLE "portable_ticket_close_sla_policies" ADD CONSTRAINT "portable_ticket_close_sla_policies_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_ticket_close_sla_receipts" ADD CONSTRAINT "portable_ticket_sla_ticket_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."portable_tickets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;