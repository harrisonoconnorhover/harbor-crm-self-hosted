ALTER TABLE "login_identities" DROP CONSTRAINT "login_directory_authority_microsoft";--> statement-breakpoint
ALTER TABLE "login_identities" ADD COLUMN "saml_directory_issuer" text;--> statement-breakpoint
ALTER TABLE "portable_directory_users" ADD COLUMN "saml_issuer" text;--> statement-breakpoint
ALTER TABLE "portable_directory_users" ADD COLUMN "saml_external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_directory_saml_external" ON "portable_directory_users" USING btree ("workspace_id",md5("saml_issuer"),md5("saml_external_id")) WHERE "portable_directory_users"."saml_issuer" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "login_identities" ADD CONSTRAINT "login_directory_authority_provider" CHECK (("login_identities"."saml_directory_issuer" IS NULL AND ("login_identities"."directory_authority" IS NULL OR "login_identities"."microsoft_subject" IS NOT NULL))
    OR ("login_identities"."saml_directory_issuer" IS NOT NULL AND "login_identities"."directory_authority" IS NOT NULL AND "login_identities"."saml_subject" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "portable_directory_users" ADD CONSTRAINT "portable_directory_saml_pair" CHECK (("portable_directory_users"."saml_issuer" IS NULL) = ("portable_directory_users"."saml_external_id" IS NULL));