CREATE TABLE "portable_job_attempts" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"outcome" text,
	CONSTRAINT "portable_job_attempts_workspace_id_job_id_number_pk" PRIMARY KEY("workspace_id","job_id","number")
);
--> statement-breakpoint
CREATE TABLE "portable_jobs" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"scheduled_for" bigint NOT NULL,
	"available_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" bigint,
	"issue" text,
	"finished_at" bigint,
	CONSTRAINT "portable_jobs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "portable_job_kind" CHECK ("portable_jobs"."kind" IN ('note','external')),
	CONSTRAINT "portable_job_status" CHECK ("portable_jobs"."status" IN ('queued','running','dispatching','succeeded','attention','failed')),
	CONSTRAINT "portable_job_lease" CHECK (CASE WHEN "portable_jobs"."status" IN ('running','dispatching') THEN "portable_jobs"."lease_token" IS NOT NULL AND "portable_jobs"."lease_until" IS NOT NULL ELSE "portable_jobs"."lease_token" IS NULL AND "portable_jobs"."lease_until" IS NULL END)
);
--> statement-breakpoint
CREATE TABLE "portable_notes" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "portable_notes_workspace_id_job_id_pk" PRIMARY KEY("workspace_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "private_workspaces" ADD COLUMN "last_job_claim_at" bigint;--> statement-breakpoint
ALTER TABLE "portable_job_attempts" ADD CONSTRAINT "portable_job_attempts_workspace_id_job_id_portable_jobs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_jobs_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_jobs" ADD CONSTRAINT "portable_jobs_workspace_id_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_notes" ADD CONSTRAINT "portable_notes_workspace_id_job_id_portable_jobs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_jobs_ready" ON "portable_jobs" USING btree ("workspace_id","available_at","id") WHERE "portable_jobs"."status"='queued';--> statement-breakpoint
CREATE INDEX "portable_jobs_active" ON "portable_jobs" USING btree ("workspace_id","lease_until") WHERE "portable_jobs"."status" IN ('running','dispatching');--> statement-breakpoint
CREATE INDEX "portable_jobs_expiry" ON "portable_jobs" USING btree ("lease_until") WHERE "portable_jobs"."status" IN ('running','dispatching');--> statement-breakpoint
CREATE INDEX "portable_jobs_contact" ON "portable_jobs" USING btree ("workspace_id","contact_id","created_at","id");