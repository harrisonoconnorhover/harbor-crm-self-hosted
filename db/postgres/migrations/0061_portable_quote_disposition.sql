ALTER TABLE "portable_quote_events" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "portable_quotes" ADD COLUMN "disposition" text;--> statement-breakpoint
ALTER TABLE "portable_quotes" ADD COLUMN "acceptance" jsonb;