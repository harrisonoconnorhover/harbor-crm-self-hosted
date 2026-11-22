ALTER TABLE "portable_record_access_events" ADD COLUMN "integration_operation" text;--> statement-breakpoint
ALTER TABLE "portable_record_access_events" ADD CONSTRAINT "record_access_integration_operation" CHECK ("portable_record_access_events"."integration_operation" IS NULL OR
    ("portable_record_access_events"."action"='integration' AND "portable_record_access_events"."integration_operation" IN ('read','create','update','archive')
    AND ("portable_record_access_events"."integration_operation"='read' OR cardinality("portable_record_access_events"."record_ids")=1)));