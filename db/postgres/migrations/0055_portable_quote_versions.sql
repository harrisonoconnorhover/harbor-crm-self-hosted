CREATE TABLE "portable_quote_versions" (
	"workspace_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "portable_quote_versions_workspace_id_quote_id_version_pk" PRIMARY KEY("workspace_id","quote_id","version")
);
--> statement-breakpoint
ALTER TABLE "portable_quotes" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "portable_quotes" ADD COLUMN "published_version" integer;--> statement-breakpoint
ALTER TABLE "portable_quotes" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portable_quote_versions" ADD CONSTRAINT "portable_quote_versions_quote_fk" FOREIGN KEY ("workspace_id","quote_id") REFERENCES "public"."portable_quotes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_quote_workspace_number" ON "portable_quotes" USING btree ("workspace_id","number");