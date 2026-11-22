import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const tables={contacts:'contacts',companies:'companies',deals:'deals',
  tasks:'portable_tasks',leads:'portable_leads',tickets:'portable_tickets'};

// Exercise the database writers directly. Capture must also work for bulk SQL paths.
export async function verifyWebhookCapture(sql){
  const workspace=randomUUID(),foreign=randomUUID(),record=randomUUID(),all=randomUUID(),subset=randomUUID();
  const rollback=new Error('Roll back the fictional webhook workspaces');
  await assert.rejects(sql.begin(async tx=>{
    for(const id of [workspace,foreign]){
      await tx`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
        VALUES(${id},${id},${id+'@example.test'},0,0)`;
      await tx`INSERT INTO private_workspaces(id,owner_id) VALUES(${id},${id})`;
    }
    // Preserve a pre-enrollment row. New subscriptions capture future changes only.
    await tx`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      VALUES(${workspace},${randomUUID()},1,'{"name":"Existing"}',now(),now())`;
    await tx`INSERT INTO portable_webhook_subscriptions(workspace_id,id,destination,objects) VALUES
      (${workspace},${all},'warehouse',${tx.array(Object.keys(tables))}::text[]),
      (${workspace},${subset},'sales',ARRAY['deals']),
      (${foreign},gen_random_uuid(),'warehouse',ARRAY['contacts'])`;
    for(const [kind,table] of Object.entries(tables)){
      const metadata={name:'Private property marker',status:'Not started',ticketStatus:'New'};
      await tx`INSERT INTO ${tx(table)}(workspace_id,id,revision,data,created_at,updated_at)
        VALUES(${workspace},${record},1,${tx.json(metadata)},now(),now())`;
      await tx`UPDATE ${tx(table)} SET data=data WHERE workspace_id=${workspace} AND id=${record}`;
      await tx`UPDATE ${tx(table)} SET data=jsonb_set(data,'{name}','"Revised"'),revision=2
        WHERE workspace_id=${workspace} AND id=${record}`;
      await tx`UPDATE ${tx(table)} SET archived_at=now(),revision=3 WHERE workspace_id=${workspace} AND id=${record}`;
      await tx`UPDATE ${tx(table)} SET archived_at=NULL,revision=4 WHERE workspace_id=${workspace} AND id=${record}`;
      await tx`DELETE FROM ${tx(table)} WHERE workspace_id=${workspace} AND id=${record}`;
      const events=await tx`SELECT * FROM portable_webhook_deliveries
        WHERE subscription_id=${all} AND object_kind=${kind} ORDER BY revision,action DESC`;
      assert.deepEqual(events.map(row=>[row.revision,row.action]),[[1,'created'],[2,'updated'],[3,'archived'],[4,'restored'],[4,'deleted']]);
      for(const row of events){
        assert.equal(row.record_id,record);
        assert.equal(row.workspace_id,workspace);
        assert.equal(row.status,'pending');
        assert.equal(row.attempts,0);
      }
      assert.ok(!JSON.stringify(events).includes('Private property marker'));
    }
    const deliveries=await tx`SELECT workspace_id,id,subscription_id,object_kind FROM portable_webhook_deliveries
      WHERE workspace_id IN (${workspace},${foreign})`;
    assert.equal(deliveries.length,35);
    assert.equal(new Set(deliveries.map(d=>d.id)).size,35);
    assert.equal(deliveries.filter(d=>d.workspace_id===foreign).length,0);
    assert.deepEqual(deliveries.filter(d=>d.subscription_id===subset).map(d=>d.object_kind),Array(5).fill('deals'));
    await tx`DELETE FROM portable_webhook_subscriptions WHERE workspace_id=${workspace} AND id=${subset}`;
    assert.equal((await tx`SELECT count(*)::int AS n FROM portable_webhook_deliveries WHERE workspace_id=${workspace}`)[0].n,30);
    throw rollback;
  }),error=>error===rollback);
  assert.equal((await sql`SELECT count(*)::int AS n FROM portable_webhook_deliveries WHERE record_id=${record}`)[0].n,0);
}
