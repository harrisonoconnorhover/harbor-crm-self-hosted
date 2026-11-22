CREATE TABLE "portable_workflow_path_receipts" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"path_id" uuid NOT NULL,
	"path_name" text NOT NULL,
	CONSTRAINT "portable_workflow_path_receipts_workspace_id_job_id_pk" PRIMARY KEY("workspace_id","job_id"),
	CONSTRAINT "portable_workflow_path_name" CHECK (length(btrim("portable_workflow_path_receipts"."path_name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "portable_workflow_path_receipts" ADD CONSTRAINT "portable_workflow_path_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."portable_jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;