ALTER TABLE "login_identities" DROP CONSTRAINT "login_directory_authority_provider";--> statement-breakpoint
ALTER TABLE "portable_directory_groups" DROP CONSTRAINT "portable_directory_group_provider";--> statement-breakpoint
ALTER TABLE "portable_directory_users" DROP CONSTRAINT "portable_directory_saml_pair";--> statement-breakpoint
ALTER TABLE "login_identities" ADD COLUMN "oidc_directory_issuer" text;--> statement-breakpoint
ALTER TABLE "portable_directory_groups" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
ALTER TABLE "portable_directory_users" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_directory_oidc_group_mapping" ON "portable_directory_groups" USING btree ("workspace_id",md5("oidc_issuer"),lower("saml_group_name")) WHERE "portable_directory_groups"."oidc_issuer" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_directory_oidc_group_name" ON "portable_directory_groups" USING btree ("workspace_id",md5("oidc_issuer"),lower("display_name")) WHERE "portable_directory_groups"."oidc_issuer" IS NOT NULL AND "portable_directory_groups"."group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_directory_oidc_group_external" ON "portable_directory_groups" USING btree ("workspace_id",md5("oidc_issuer"),"saml_external_id") WHERE "portable_directory_groups"."saml_external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_directory_oidc_external" ON "portable_directory_users" USING btree ("workspace_id",md5("oidc_issuer"),md5("saml_external_id")) WHERE "portable_directory_users"."oidc_issuer" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "login_identities" ADD CONSTRAINT "login_directory_authority_provider" CHECK (("login_identities"."oidc_directory_issuer" IS NULL AND "login_identities"."saml_directory_issuer" IS NULL AND ("login_identities"."directory_authority" IS NULL OR "login_identities"."microsoft_subject" IS NOT NULL))
    OR ("login_identities"."oidc_directory_issuer" IS NOT NULL AND "login_identities"."saml_directory_issuer" IS NULL AND "login_identities"."directory_authority" IS NOT NULL AND "login_identities"."oidc_subject" IS NOT NULL)
    OR ("login_identities"."oidc_directory_issuer" IS NULL AND "login_identities"."saml_directory_issuer" IS NOT NULL AND "login_identities"."directory_authority" IS NOT NULL AND "login_identities"."saml_subject" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "portable_directory_groups" ADD CONSTRAINT "portable_directory_group_provider" CHECK ((
    "portable_directory_groups"."tenant" IS NOT NULL AND "portable_directory_groups"."external_id" IS NOT NULL AND "portable_directory_groups"."saml_issuer" IS NULL AND "portable_directory_groups"."oidc_issuer" IS NULL AND "portable_directory_groups"."saml_group_name" IS NULL AND "portable_directory_groups"."saml_external_id" IS NULL
  ) OR (
    "portable_directory_groups"."tenant" IS NULL AND "portable_directory_groups"."external_id" IS NULL AND num_nonnulls("portable_directory_groups"."saml_issuer","portable_directory_groups"."oidc_issuer")=1 AND "portable_directory_groups"."saml_group_name" IS NOT NULL
    AND length(trim("portable_directory_groups"."saml_group_name")) BETWEEN 1 AND 120 AND ("portable_directory_groups"."saml_external_id" IS NULL OR length("portable_directory_groups"."saml_external_id") BETWEEN 1 AND 254)
  ));--> statement-breakpoint
ALTER TABLE "portable_directory_users" ADD CONSTRAINT "portable_directory_saml_pair" CHECK (num_nonnulls("portable_directory_users"."saml_issuer","portable_directory_users"."oidc_issuer") = CASE WHEN "portable_directory_users"."saml_external_id" IS NULL THEN 0 ELSE 1 END);