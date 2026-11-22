ALTER TABLE "login_identities" DROP CONSTRAINT "login_identity_one_provider";--> statement-breakpoint
ALTER TABLE "login_identities" ADD COLUMN "saml_subject" text;--> statement-breakpoint
CREATE UNIQUE INDEX "login_saml_subject_unique" ON "login_identities" USING btree ("saml_subject");--> statement-breakpoint
ALTER TABLE "login_identities" ADD CONSTRAINT "login_identity_one_provider" CHECK (num_nonnulls("login_identities"."google_subject", "login_identities"."microsoft_subject", "login_identities"."saml_subject") = 1);