CREATE TABLE "portable_navigation_bookmarks" (
	"user_id" text PRIMARY KEY NOT NULL,
	"items" text[] NOT NULL,
	CONSTRAINT "portable_navigation_bookmark_limit" CHECK (cardinality("portable_navigation_bookmarks"."items") BETWEEN 0 AND 5)
);
--> statement-breakpoint
ALTER TABLE "portable_navigation_bookmarks" ADD CONSTRAINT "portable_navigation_bookmarks_user_id_login_identities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."login_identities"("id") ON DELETE cascade ON UPDATE no action;