CREATE TABLE "portable_backup_source" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"source_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "portable_backup_source_singleton" CHECK ("portable_backup_source"."singleton")
);
--> statement-breakpoint
INSERT INTO "portable_backup_source" DEFAULT VALUES;
