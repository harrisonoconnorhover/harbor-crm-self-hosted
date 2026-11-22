CREATE INDEX "portable_ticket_tags" ON "portable_tickets" USING gin (("data"->'tags') jsonb_path_ops) WHERE "portable_tickets"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "portable_tickets" ADD CONSTRAINT "portable_ticket_tags_shape" CHECK (NOT ("portable_tickets"."data" ? 'tags') OR CASE WHEN jsonb_typeof("portable_tickets"."data"->'tags') = 'array'
    THEN jsonb_array_length("portable_tickets"."data"->'tags') <= 10 AND NOT jsonb_path_exists("portable_tickets"."data"->'tags', '$[*] ? (@.type() != "string")')
    ELSE false END);