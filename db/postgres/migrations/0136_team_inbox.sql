CREATE TABLE "portable_inbox_conversations" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"mailbox" text NOT NULL,
	"sender" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"claimed_by" text,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portable_inbox_conversations_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "inbox_conversation_mailbox" UNIQUE("workspace_id","mailbox","id"),
	CONSTRAINT "inbox_conversation_valid" CHECK ("portable_inbox_conversations"."revision">0 AND "portable_inbox_conversations"."status" IN ('open','resolved')
    AND length("portable_inbox_conversations"."subject") <= 1000 AND cardinality("portable_inbox_conversations"."tags")<=20
    AND length("portable_inbox_conversations"."mailbox") BETWEEN 3 AND 320 AND length("portable_inbox_conversations"."sender") BETWEEN 3 AND 320)
);
--> statement-breakpoint
CREATE TABLE "portable_inbox_messages" (
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"mailbox" text NOT NULL,
	"direction" text NOT NULL,
	"actor_id" text,
	"body" text NOT NULL,
	"internet_id" text,
	"in_reply_to" text,
	"provider_id" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portable_inbox_messages_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "inbox_message_state" CHECK (("portable_inbox_messages"."direction"='incoming' AND "portable_inbox_messages"."state"='received' AND "portable_inbox_messages"."provider_id" IS NOT NULL AND "portable_inbox_messages"."actor_id" IS NULL)
    OR ("portable_inbox_messages"."direction"='outgoing' AND "portable_inbox_messages"."state" IN ('sending','sent','uncertain','failed') AND "portable_inbox_messages"."actor_id" IS NOT NULL AND "portable_inbox_messages"."internet_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "portable_inbox_snippets" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"revision" integer NOT NULL,
	"slot" integer NOT NULL,
	CONSTRAINT "portable_inbox_snippets_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "inbox_snippet_slot" UNIQUE("workspace_id","slot"),
	CONSTRAINT "inbox_snippet_valid" CHECK ("portable_inbox_snippets"."slot" BETWEEN 1 AND 40 AND "portable_inbox_snippets"."revision">0 AND "portable_inbox_snippets"."name"=btrim("portable_inbox_snippets"."name")
    AND length("portable_inbox_snippets"."name") BETWEEN 1 AND 100 AND length("portable_inbox_snippets"."body") BETWEEN 1 AND 16000 AND length(btrim("portable_inbox_snippets"."body"))>0)
);
--> statement-breakpoint
ALTER TABLE "portable_inbox_conversations" ADD CONSTRAINT "portable_inbox_conversations_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_inbox_conversations" ADD CONSTRAINT "portable_inbox_conversations_claimed_by_login_identities_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_inbox_messages" ADD CONSTRAINT "portable_inbox_messages_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_inbox_messages" ADD CONSTRAINT "inbox_message_conversation" FOREIGN KEY ("workspace_id","mailbox","conversation_id") REFERENCES "public"."portable_inbox_conversations"("workspace_id","mailbox","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_inbox_snippets" ADD CONSTRAINT "portable_inbox_snippets_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_conversation_status_page" ON "portable_inbox_conversations" USING btree ("workspace_id","status","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_incoming_receipt" ON "portable_inbox_messages" USING btree ("workspace_id","mailbox","provider_id") WHERE "portable_inbox_messages"."direction"='incoming';--> statement-breakpoint
CREATE INDEX "inbox_thread_reference" ON "portable_inbox_messages" USING btree ("workspace_id","mailbox","internet_id") WHERE "portable_inbox_messages"."internet_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inbox_message_page" ON "portable_inbox_messages" USING btree ("workspace_id","conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_one_pending_reply" ON "portable_inbox_messages" USING btree ("workspace_id","conversation_id") WHERE "portable_inbox_messages"."state" IN ('sending','uncertain');--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_snippet_name" ON "portable_inbox_snippets" USING btree ("workspace_id",lower("name"));