CREATE TABLE "portable_inbox_ticket_links" (
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	CONSTRAINT "portable_inbox_ticket_links_workspace_id_conversation_id_pk" PRIMARY KEY("workspace_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "portable_inbox_ticket_links" ADD CONSTRAINT "inbox_ticket_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."portable_inbox_conversations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_inbox_ticket_links" ADD CONSTRAINT "inbox_ticket_record_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."portable_tickets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_inbox_ticket_by_ticket" ON "portable_inbox_ticket_links" USING btree ("workspace_id","ticket_id");