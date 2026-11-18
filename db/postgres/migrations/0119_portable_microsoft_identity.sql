ALTER TABLE "login_identities" ALTER COLUMN "google_subject" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "login_identities" ADD COLUMN "microsoft_subject" text;--> statement-breakpoint
CREATE UNIQUE INDEX "login_microsoft_subject_unique" ON "login_identities" USING btree ("microsoft_subject");--> statement-breakpoint
ALTER TABLE "login_identities" ADD CONSTRAINT "login_identity_one_provider" CHECK (num_nonnulls("login_identities"."google_subject", "login_identities"."microsoft_subject") = 1);