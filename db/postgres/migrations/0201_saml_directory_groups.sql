ALTER TABLE "portable_directory_groups" ALTER COLUMN "tenant" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_directory_groups" ALTER COLUMN "external_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_directory_groups" ADD COLUMN "saml_issuer" text;--> statement-breakpoint
ALTER TABLE "portable_directory_groups" ADD COLUMN "saml_group_name" text;--> statement-breakpoint
ALTER TABLE "portable_directory_groups" ADD COLUMN "saml_external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_directory_saml_group_mapping" ON "portable_directory_groups" USING btree ("workspace_id",md5("saml_issuer"),lower("saml_group_name")) WHERE "portable_directory_groups"."saml_issuer" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_directory_saml_group_name" ON "portable_directory_groups" USING btree ("workspace_id",md5("saml_issuer"),lower("display_name")) WHERE "portable_directory_groups"."saml_issuer" IS NOT NULL AND "portable_directory_groups"."group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_directory_saml_group_external" ON "portable_directory_groups" USING btree ("workspace_id",md5("saml_issuer"),"saml_external_id") WHERE "portable_directory_groups"."saml_external_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_directory_groups" ADD CONSTRAINT "portable_directory_group_provider" CHECK ((
    "portable_directory_groups"."tenant" IS NOT NULL AND "portable_directory_groups"."external_id" IS NOT NULL AND "portable_directory_groups"."saml_issuer" IS NULL AND "portable_directory_groups"."saml_group_name" IS NULL AND "portable_directory_groups"."saml_external_id" IS NULL
  ) OR (
    "portable_directory_groups"."tenant" IS NULL AND "portable_directory_groups"."external_id" IS NULL AND "portable_directory_groups"."saml_issuer" IS NOT NULL AND "portable_directory_groups"."saml_group_name" IS NOT NULL
    AND length(trim("portable_directory_groups"."saml_group_name")) BETWEEN 1 AND 120 AND ("portable_directory_groups"."saml_external_id" IS NULL OR "portable_directory_groups"."group_id" IS NOT NULL)
  ));