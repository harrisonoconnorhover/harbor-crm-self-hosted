-- Manual and directory-managed access changes use the same membership table.
CREATE FUNCTION public.harbor_release_ineligible_inbox_claims() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  UPDATE public.portable_inbox_conversations AS c
     SET claimed_by=NULL,revision=c.revision+1,updated_at=statement_timestamp()
   WHERE c.workspace_id=OLD.workspace_id AND c.claimed_by=OLD.viewer_id
     AND NOT EXISTS (SELECT 1 FROM public.private_workspaces w
                     WHERE w.id=c.workspace_id AND w.owner_id=c.claimed_by);
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER release_inbox_claims_after_removal AFTER DELETE ON public.portable_workspace_viewers
FOR EACH ROW WHEN (OLD.role='editor' AND OLD.edit_scope='all')
EXECUTE FUNCTION public.harbor_release_ineligible_inbox_claims();
--> statement-breakpoint
CREATE TRIGGER release_inbox_claims_after_demotion AFTER UPDATE OF role,edit_scope ON public.portable_workspace_viewers
FOR EACH ROW WHEN (OLD.role='editor' AND OLD.edit_scope='all' AND (NEW.role<>'editor' OR NEW.edit_scope<>'all'))
EXECUTE FUNCTION public.harbor_release_ineligible_inbox_claims();
--> statement-breakpoint
-- Repair claims left behind by prior releases. Messages, authors and delivery states are independent.
UPDATE public.portable_inbox_conversations AS c
   SET claimed_by=NULL,revision=c.revision+1,updated_at=statement_timestamp()
  FROM public.private_workspaces w
 WHERE w.id=c.workspace_id AND c.claimed_by IS NOT NULL AND c.claimed_by<>w.owner_id
   AND NOT EXISTS (SELECT 1 FROM public.portable_workspace_viewers m
                    WHERE m.workspace_id=c.workspace_id AND m.viewer_id=c.claimed_by
                      AND m.role='editor' AND m.edit_scope='all');
