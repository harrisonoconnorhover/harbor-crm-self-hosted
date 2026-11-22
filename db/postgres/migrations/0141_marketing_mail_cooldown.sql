CREATE TABLE "portable_marketing_mail_cooldown" (
	"provider" text PRIMARY KEY NOT NULL,
	"until_ms" bigint NOT NULL,
	CONSTRAINT "portable_marketing_mail_cooldown_provider" CHECK ("portable_marketing_mail_cooldown"."provider"='resend')
);
