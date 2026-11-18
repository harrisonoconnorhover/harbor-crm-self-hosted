CREATE TABLE "portable_duplicate_dismissals" (
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"record_a" uuid NOT NULL,
	"record_b" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portable_duplicate_dismissals_workspace_id_record_a_record_b_pk" PRIMARY KEY("workspace_id","record_a","record_b"),
	CONSTRAINT "portable_duplicate_dismissal_order" CHECK ("portable_duplicate_dismissals"."record_a"<"portable_duplicate_dismissals"."record_b"),
	CONSTRAINT "portable_duplicate_dismissal_kind" CHECK ("portable_duplicate_dismissals"."kind" IN ('contacts','companies'))
);
--> statement-breakpoint
ALTER TABLE "portable_duplicate_dismissals" ADD CONSTRAINT "portable_duplicate_dismissals_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_duplicate_dismissals" ADD CONSTRAINT "portable_duplicate_dismissals_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_duplicate_dismissal_kind" ON "portable_duplicate_dismissals" USING btree ("workspace_id","kind");