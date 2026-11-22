CREATE TABLE "portable_sales_enrollments" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"sequence_revision" integer NOT NULL,
	"sequence_name" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"contact_name" text NOT NULL,
	"recipient" text,
	"actor_id" text NOT NULL,
	"sender" text NOT NULL,
	"assignee_id" text NOT NULL,
	"assignee_label" text NOT NULL,
	"state" text NOT NULL,
	"issue" text,
	"created_at" bigint NOT NULL,
	"finished_at" bigint,
	CONSTRAINT "portable_sales_enrollments_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "sales_enrollment_state" CHECK ("portable_sales_enrollments"."state" IN ('active','completed','stopped','attention') AND "portable_sales_enrollments"."sequence_revision">0)
);
--> statement-breakpoint
CREATE TABLE "portable_sales_sequence_activations" (
	"workspace_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	CONSTRAINT "portable_sales_sequence_activations_workspace_id_enrollment_id_pk" PRIMARY KEY("workspace_id","enrollment_id")
);
--> statement-breakpoint
CREATE TABLE "portable_sales_sequence_steps" (
	"workspace_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"position" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"state" text NOT NULL,
	"due_at" bigint,
	"job_id" uuid,
	"task_id" uuid,
	"finished_at" bigint,
	"issue" text,
	CONSTRAINT "portable_sales_sequence_steps_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "sales_step_order" UNIQUE("workspace_id","enrollment_id","position"),
	CONSTRAINT "sales_step_position" CHECK ("portable_sales_sequence_steps"."position" BETWEEN 0 AND 19),
	CONSTRAINT "sales_step_state" CHECK ("portable_sales_sequence_steps"."state" IN ('waiting','ready','queued','completed','stopped','attention') AND num_nonnulls("portable_sales_sequence_steps"."job_id","portable_sales_sequence_steps"."task_id")<=1)
);
--> statement-breakpoint
CREATE TABLE "portable_sales_sequences" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "portable_sales_sequences_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "sales_sequence_valid_steps" CHECK ("portable_sales_sequences"."revision">0 AND jsonb_typeof("portable_sales_sequences"."steps")='array' AND jsonb_array_length("portable_sales_sequences"."steps") BETWEEN 1 AND 20)
);
--> statement-breakpoint
ALTER TABLE "private_workspaces" ADD COLUMN "last_sales_sequence_at" bigint;--> statement-breakpoint
ALTER TABLE "portable_sales_enrollments" ADD CONSTRAINT "portable_sales_enrollments_actor_id_login_identities_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_sales_enrollments" ADD CONSTRAINT "portable_sales_enrollments_assignee_id_login_identities_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_sales_enrollments" ADD CONSTRAINT "sales_enrollment_sequence_fk" FOREIGN KEY ("workspace_id","sequence_id") REFERENCES "public"."portable_sales_sequences"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_sales_enrollments" ADD CONSTRAINT "sales_enrollment_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_sales_sequence_activations" ADD CONSTRAINT "sales_activation_enrollment_fk" FOREIGN KEY ("workspace_id","enrollment_id") REFERENCES "public"."portable_sales_enrollments"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_sales_sequence_steps" ADD CONSTRAINT "sales_step_enrollment_fk" FOREIGN KEY ("workspace_id","enrollment_id") REFERENCES "public"."portable_sales_enrollments"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_sales_sequence_steps" ADD CONSTRAINT "sales_step_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_sales_sequence_steps" ADD CONSTRAINT "sales_step_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."portable_tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_sales_sequences" ADD CONSTRAINT "portable_sales_sequences_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_enrollment_open_contact" ON "portable_sales_enrollments" USING btree ("workspace_id","contact_id","sequence_id") WHERE "portable_sales_enrollments"."state" IN ('active','attention');--> statement-breakpoint
CREATE INDEX "sales_enrollment_contact_list" ON "portable_sales_enrollments" USING btree ("workspace_id","contact_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_step_job" ON "portable_sales_sequence_steps" USING btree ("workspace_id","job_id") WHERE "portable_sales_sequence_steps"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_step_task" ON "portable_sales_sequence_steps" USING btree ("workspace_id","task_id") WHERE "portable_sales_sequence_steps"."task_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sales_steps_due" ON "portable_sales_sequence_steps" USING btree ("due_at","workspace_id","id") WHERE "portable_sales_sequence_steps"."state" IN ('ready','queued');