CREATE TABLE "portable_login_attempt_uses" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"expires_minute" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "portable_login_attempt_expiry" ON "portable_login_attempt_uses" USING btree ("expires_minute");