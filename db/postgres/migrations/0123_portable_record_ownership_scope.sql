ALTER TABLE "portable_workspace_viewers" ADD COLUMN "view_scope" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_workspace_viewers" ADD COLUMN "edit_scope" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_workspace_invites" ADD COLUMN "view_scope" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_workspace_invites" ADD COLUMN "edit_scope" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "portable_workspace_viewers" ADD CONSTRAINT "portable_member_record_scope" CHECK ("portable_workspace_viewers"."view_scope" IN ('owned','team','all')
    AND "portable_workspace_viewers"."edit_scope" IN ('owned','team','all')
    AND ("portable_workspace_viewers"."view_scope"='all' OR "portable_workspace_viewers"."edit_scope"='owned' OR "portable_workspace_viewers"."view_scope"="portable_workspace_viewers"."edit_scope")
    AND (NOT "portable_workspace_viewers"."backup_admin" OR "portable_workspace_viewers"."edit_scope"='all'));--> statement-breakpoint
ALTER TABLE "portable_workspace_invites" ADD CONSTRAINT "portable_invite_record_scope" CHECK ("portable_workspace_invites"."view_scope" IN ('owned','team','all') AND "portable_workspace_invites"."edit_scope" IN ('owned','team','all')
    AND ("portable_workspace_invites"."view_scope"='all' OR "portable_workspace_invites"."edit_scope"='owned' OR "portable_workspace_invites"."view_scope"="portable_workspace_invites"."edit_scope"));