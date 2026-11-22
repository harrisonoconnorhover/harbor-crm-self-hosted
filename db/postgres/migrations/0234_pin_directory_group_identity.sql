ALTER TABLE "portable_directory_groups" DROP CONSTRAINT "portable_directory_group_provider";--> statement-breakpoint
ALTER TABLE "portable_directory_groups" ADD CONSTRAINT "portable_directory_group_provider" CHECK ((
    "portable_directory_groups"."tenant" IS NOT NULL AND "portable_directory_groups"."external_id" IS NOT NULL AND "portable_directory_groups"."saml_issuer" IS NULL AND "portable_directory_groups"."saml_group_name" IS NULL AND "portable_directory_groups"."saml_external_id" IS NULL
  ) OR (
    "portable_directory_groups"."tenant" IS NULL AND "portable_directory_groups"."external_id" IS NULL AND "portable_directory_groups"."saml_issuer" IS NOT NULL AND "portable_directory_groups"."saml_group_name" IS NOT NULL
    AND length(trim("portable_directory_groups"."saml_group_name")) BETWEEN 1 AND 120 AND ("portable_directory_groups"."saml_external_id" IS NULL OR length("portable_directory_groups"."saml_external_id") BETWEEN 1 AND 254)
  ));