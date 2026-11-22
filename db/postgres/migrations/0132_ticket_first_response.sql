CREATE TABLE "portable_ticket_response_policies" (
	"workspace_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"targets" jsonb NOT NULL,
	"calendar" jsonb NOT NULL,
	CONSTRAINT "portable_ticket_response_policies_workspace_id_revision_pk" PRIMARY KEY("workspace_id","revision"),
	CONSTRAINT "portable_response_policy_version" CHECK ("portable_ticket_response_policies"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "portable_ticket_first_responses" (
	"workspace_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"policy_revision" integer NOT NULL,
	"target_minutes" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"working_ms" bigint,
	"channel" text,
	"summary" text,
	"actor_id" text,
	CONSTRAINT "portable_ticket_first_responses_workspace_id_ticket_id_pk" PRIMARY KEY("workspace_id","ticket_id"),
	CONSTRAINT "portable_response_due" CHECK ("portable_ticket_first_responses"."due_at">"portable_ticket_first_responses"."started_at" AND "portable_ticket_first_responses"."target_minutes">0),
	CONSTRAINT "portable_response_completion" CHECK (num_nonnulls("portable_ticket_first_responses"."responded_at","portable_ticket_first_responses"."working_ms","portable_ticket_first_responses"."channel","portable_ticket_first_responses"."summary","portable_ticket_first_responses"."actor_id") IN (0,5)
    AND ("portable_ticket_first_responses"."responded_at" IS NULL OR ("portable_ticket_first_responses"."responded_at">="portable_ticket_first_responses"."started_at" AND "portable_ticket_first_responses"."working_ms">=0 AND "portable_ticket_first_responses"."channel" IN ('Email','Phone','Chat')
    AND length(trim("portable_ticket_first_responses"."summary")) BETWEEN 1 AND 1000)))
);
--> statement-breakpoint
ALTER TABLE "portable_ticket_response_policies" ADD CONSTRAINT "portable_ticket_response_policies_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_ticket_first_responses" ADD CONSTRAINT "portable_ticket_first_responses_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_ticket_first_responses" ADD CONSTRAINT "portable_response_ticket_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."portable_tickets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_ticket_first_responses" ADD CONSTRAINT "portable_response_policy_fk" FOREIGN KEY ("workspace_id","policy_revision") REFERENCES "public"."portable_ticket_response_policies"("workspace_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_first_response_due" ON "portable_ticket_first_responses" USING btree ("workspace_id","due_at","ticket_id") WHERE "portable_ticket_first_responses"."responded_at" IS NULL;