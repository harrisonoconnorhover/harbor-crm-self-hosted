CREATE TABLE "portable_guest_booking_requests" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"email" text NOT NULL,
	"start" text NOT NULL,
	"end" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"verified_at" bigint,
	"delivery" text DEFAULT 'claimed' NOT NULL,
	"provider_id" text,
	CONSTRAINT "portable_guest_booking_requests_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portable_published_availability" ADD COLUMN "allow_guest_proof" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_guest_booking_requests" ADD CONSTRAINT "portable_guest_booking_requests_workspace_id_private_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."private_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_guest_booking_workspace_time" ON "portable_guest_booking_requests" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "portable_guest_booking_expiry" ON "portable_guest_booking_requests" USING btree ("created_at");