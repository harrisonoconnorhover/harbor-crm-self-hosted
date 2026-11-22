CREATE TABLE "portable_quote_signature_receipts" (
	"workspace_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"issuer_id" text NOT NULL,
	"signed_name" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"consent" text NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "portable_quote_signature_receipts_workspace_id_quote_id_version_pk" PRIMARY KEY("workspace_id","quote_id","version"),
	CONSTRAINT "portable_quote_signature_receipts_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "portable_quote_signing_links" (
	"workspace_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"issuer_id" text NOT NULL,
	CONSTRAINT "portable_quote_signing_links_workspace_id_quote_id_version_pk" PRIMARY KEY("workspace_id","quote_id","version"),
	CONSTRAINT "portable_quote_signing_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "portable_quote_signature_receipts" ADD CONSTRAINT "portable_quote_signature_receipts_issuer_id_login_identities_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_quote_signature_receipts" ADD CONSTRAINT "quote_signature_version_fk" FOREIGN KEY ("workspace_id","quote_id","version") REFERENCES "public"."portable_quote_versions"("workspace_id","quote_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_quote_signing_links" ADD CONSTRAINT "portable_quote_signing_links_issuer_id_login_identities_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."login_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_quote_signing_links" ADD CONSTRAINT "quote_signing_link_version_fk" FOREIGN KEY ("workspace_id","quote_id","version") REFERENCES "public"."portable_quote_versions"("workspace_id","quote_id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION public.harbor_preserve_quote_signature() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Quote signature receipts are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER preserve_quote_signature BEFORE UPDATE OR DELETE OR TRUNCATE
ON public.portable_quote_signature_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.harbor_preserve_quote_signature();
