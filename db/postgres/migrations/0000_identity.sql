CREATE TABLE "login_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"google_subject" text NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "login_sessions" ADD CONSTRAINT "login_sessions_user_id_login_identities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."login_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "login_google_subject_unique" ON "login_identities" USING btree ("google_subject");--> statement-breakpoint
CREATE INDEX "login_sessions_user" ON "login_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "login_sessions_expiry" ON "login_sessions" USING btree ("expires_at");