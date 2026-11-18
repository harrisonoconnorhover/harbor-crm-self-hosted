CREATE TABLE "portable_google_attempts" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"session_hash" text NOT NULL,
	"state_hash" text NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"claimed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "portable_google_attempts_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "portable_google_grants" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"id" text NOT NULL,
	"email" text NOT NULL,
	"refresh_token" text NOT NULL,
	"needs_reconnect" boolean DEFAULT false NOT NULL,
	CONSTRAINT "portable_google_grants_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "portable_google_attempts" ADD CONSTRAINT "portable_google_attempts_user_id_login_identities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."login_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_google_attempts" ADD CONSTRAINT "portable_google_attempts_session_hash_login_sessions_token_hash_fk" FOREIGN KEY ("session_hash") REFERENCES "public"."login_sessions"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_google_grants" ADD CONSTRAINT "portable_google_grants_user_id_login_identities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."login_identities"("id") ON DELETE cascade ON UPDATE no action;