import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

export async function verifyInboxExchangeUpgrade(sql,workspaceId,ownerId){
  const migration=await readFile(new URL('../db/postgres/migrations/0228_inbox_unanswered_queue.sql',import.meta.url),'utf8');
  const rollback=new Error('Completed inbox upgrade rehearsal');
  await assert.rejects(sql.begin(async tx=>{
    await tx`DROP TRIGGER inbox_exchange_after_receipt ON portable_inbox_messages`;
    await tx`DROP FUNCTION public.harbor_track_inbox_exchange()`;
    await tx`ALTER TABLE portable_inbox_conversations DROP COLUMN last_received_at, DROP COLUMN last_replied_at`;
    const [tie]=await tx`INSERT INTO portable_inbox_conversations(workspace_id,id,mailbox,sender,subject)
      VALUES (${workspaceId},gen_random_uuid(),'support@example.test','fiction@example.test','Simultaneous customer mail and reply') RETURNING id`;
    await tx`INSERT INTO portable_inbox_messages(workspace_id,id,conversation_id,mailbox,direction,state,provider_id,actor_id,internet_id,body)
      VALUES (${workspaceId},gen_random_uuid(),${tie.id},'support@example.test','incoming','received','fixture-in',NULL,NULL,'Customer message'),
      (${workspaceId},gen_random_uuid(),${tie.id},'support@example.test','outgoing','sent',NULL,${ownerId},'fixture-out','Reply')`;
    // Use the pre-upgrade rule, including its tie-break, as an independent comparison.
    const expected=await tx`SELECT c.id,c.updated_at::text,c.revision FROM portable_inbox_conversations c
      WHERE c.workspace_id=${workspaceId} AND c.status='open' AND (SELECT m.state FROM portable_inbox_messages m
        WHERE m.workspace_id=c.workspace_id AND m.conversation_id=c.id AND m.state IN ('received','sent')
        ORDER BY m.created_at DESC,(m.state='received') DESC LIMIT 1)='received' ORDER BY c.id`;
    assert.ok(expected.some(row=>row.id===tie.id));
    for(const statement of migration.split('--> statement-breakpoint'))await tx.unsafe(statement);
    const indexed=await tx`SELECT id,updated_at::text,revision FROM portable_inbox_conversations WHERE workspace_id=${workspaceId}
      AND status='open' AND last_received_at>=coalesce(last_replied_at,'-infinity'::timestamptz) ORDER BY id`;
    assert.deepEqual([...indexed],[...expected]);
    throw rollback;
  }),err=>err===rollback);
}
