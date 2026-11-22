-- Use the same release operation as role demotion or departure. Actor and message history stay intact.
CREATE TRIGGER release_inbox_claims_after_tool_change AFTER UPDATE OF tool_policies ON public.portable_workspace_viewers
FOR EACH ROW WHEN (
  OLD.role='editor' AND OLD.edit_scope='all'
  AND coalesce(OLD.tool_policies->'team-inbox'->>'edit','all')='all'
  AND NEW.tool_policies->'team-inbox'->>'edit'='none'
)
EXECUTE FUNCTION public.harbor_release_ineligible_inbox_claims();
--> statement-breakpoint
-- Repair conversations that could be handed off in releases 0233 and 0234.
UPDATE public.portable_inbox_conversations AS c
   SET claimed_by=NULL,revision=c.revision+1,updated_at=statement_timestamp()
  FROM public.portable_workspace_viewers AS m
  JOIN public.private_workspaces AS w ON w.id=m.workspace_id
 WHERE c.workspace_id=m.workspace_id AND c.claimed_by=m.viewer_id AND c.claimed_by<>w.owner_id
   AND m.tool_policies->'team-inbox'->>'edit'='none';
