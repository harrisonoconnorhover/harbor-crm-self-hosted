import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

export async function verifyInboxClaimUpgrade({sql,workspaceId,ownerId,repId}){
  // Rehearse upgrading a populated database inside a rolled-back fixture transaction.
  const migration=await readFile(new URL('../db/postgres/migrations/0169_release_unavailable_inbox_claims.sql',import.meta.url),'utf8');
  const permissions=await readFile(new URL('../db/postgres/migrations/0235_inbox_claim_permissions.sql',import.meta.url),'utf8');
  const done=new Error('Rollback completed upgrade rehearsal');
  await assert.rejects(sql.begin(async tx=>{
    await tx.unsafe('DROP TRIGGER release_inbox_claims_after_tool_change ON portable_workspace_viewers');
    await tx.unsafe('DROP TRIGGER release_inbox_claims_after_removal ON portable_workspace_viewers');
    await tx.unsafe('DROP TRIGGER release_inbox_claims_after_demotion ON portable_workspace_viewers');
    await tx.unsafe('DROP FUNCTION public.harbor_release_ineligible_inbox_claims()');
    const editor=randomUUID(),formerMember=randomUUID();
    for(const id of [editor,formerMember])await tx`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
      VALUES (${id},${id},${id+'@example.test'},1,1)`;
    await tx`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role,view_scope,edit_scope)
      VALUES (${workspaceId},${editor},gen_random_uuid(),'editor','all','all')`;
    const examples=[{previous:ownerId,expected:ownerId},{previous:editor,expected:editor},
      {previous:formerMember,expected:null},{previous:repId,expected:null},{previous:null,expected:null}];
    for(const sample of examples){
      sample.id=randomUUID();
      await tx`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject,claimed_by,revision)
        VALUES (${workspaceId},${sample.id},'support@example.test','customer@example.test','Upgrade example',${sample.previous},7)`;
    }
    for(const statement of migration.split('--> statement-breakpoint'))await tx.unsafe(statement);
    for(const sample of examples){
      const [row]=await tx`SELECT claimed_by,revision FROM portable_inbox_conversations WHERE workspace_id=${workspaceId} AND id=${sample.id}`;
      assert.deepEqual([row.claimed_by,row.revision],[sample.expected,sample.previous===sample.expected?7:8]);
    }
    const assigned=examples.find(row=>row.previous===editor);
    await tx`UPDATE portable_workspace_viewers SET tool_policies='{"team-inbox":{"view":"all","edit":"none","create":false,"delete":false}}'
      WHERE workspace_id=${workspaceId} AND viewer_id=${editor}`;
    for(const statement of permissions.split('--> statement-breakpoint'))await tx.unsafe(statement);
    for(const sample of examples){
      const [row]=await tx`SELECT claimed_by,revision FROM portable_inbox_conversations WHERE workspace_id=${workspaceId} AND id=${sample.id}`;
      assert.deepEqual([row.claimed_by,row.revision],[sample===assigned?null:sample.expected,sample===assigned||sample.previous!==sample.expected?8:7]);
    }
    throw done;
  }),err=>err===done);
}
