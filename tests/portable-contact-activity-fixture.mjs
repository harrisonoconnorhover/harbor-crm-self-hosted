import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export async function verifyPortableContactOutreach({request,origin,headers,other,record,otherRecord,sql,sharing}){
  const path=contact=>'/api/logged-activities?contactId='+contact.id;
  const read=(contact,auth=headers)=>request(path(contact),{headers:auth});
  const log=(input,contact=record,auth=headers,site=origin)=>request(path(contact),{
    method:'POST',headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(input),
  });
  const [scope]=await sql`SELECT w.id AS workspace_id,w.owner_id FROM private_workspaces w
    JOIN contacts c ON c.workspace_id=w.id WHERE c.id=${record.id}`;
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_write' AND subject=${scope.owner_id}`;
  assert.equal((await read(record,{})).status,401);
  assert.equal((await read(record,other)).status,404);
  assert.equal((await read(otherRecord)).status,404);
  assert.equal((await request(path(record)+'&workspaceId='+sharing.workspaceId,{headers:other})).status,404);
  assert.deepEqual(await (await read(record)).json(),{items:[],lastContacted:null,lastActivity:null,next:null});
  const newest={id:randomUUID(),kind:'Call',occurredAt:Date.now()-10_000,summary:'Fictional call after a product demo'};
  assert.equal((await log(newest,record,other)).status,404);
  assert.equal((await log(newest,record,headers,'https://outside.example.test')).status,403);
  assert.equal((await log({...newest,occurredAt:Date.now()+600_000})).status,400);
  assert.equal((await log({...newest,kind:'Unknown activity'})).status,400);
  const responses=await Promise.all([log(newest),log(newest)]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,201]);
  assert.equal((await log({...newest,summary:'A different call'})).status,409);
  const older={id:randomUUID(),kind:'Meeting',occurredAt:dayStart(utcDay(newest.occurredAt-86_400_000))+43_200_000,summary:'Fictional earlier meeting'};
  assert.equal((await log(older)).status,201);
  const loggedEmail={id:randomUUID(),kind:'Email',occurredAt:older.occurredAt-1000,summary:'Fictional manual email log'};
  assert.equal((await log(loggedEmail)).status,201);
  const ids=Array.from({length:25},()=>randomUUID());
  await sql`INSERT INTO portable_contact_activities(workspace_id,id,contact_id,actor_id,kind,occurred_at,recorded_at,summary)
    SELECT ${scope.workspace_id},id,${record.id},${scope.owner_id},'Call',${loggedEmail.occurredAt},${newest.occurredAt},'Fictional tie timestamp'
    FROM unnest(${ids}::uuid[]) AS id`;
  const first=await (await read(record)).json();
  assert.equal(first.lastContacted,newest.occurredAt);
  assert.deepEqual(first.items.slice(0,2),[newest,older].map(item=>({...item,revision:1})));
  assert.equal(first.items.length,25);
  assert.ok(first.next);
  const second=await (await request(path(record)+'&'+new URLSearchParams({afterAt:first.next.at,afterId:first.next.id}),{headers})).json();
  assert.equal(second.lastContacted,newest.occurredAt);
  assert.equal(second.next,null);
  assert.equal(second.items.length,3);
  assert.deepEqual(new Set([...first.items,...second.items].map(item=>item.id)),new Set([newest.id,older.id,loggedEmail.id,...ids]));
  assert.equal((await sql`SELECT actor_id FROM portable_contact_activities WHERE id=${newest.id}`)[0].actor_id,scope.owner_id);
  const channels=['LinkedIn','SMS','WhatsApp','Note','Postal mail'];
  for(const [index,kind] of channels.entries()){
    assert.equal((await log({id:randomUUID(),kind,occurredAt:newest.occurredAt+1000+index,summary:'Fictional '+kind})).status,201);
  }
  const expanded=await (await read(record)).json();
  assert.deepEqual(expanded.items.slice(0,5).map(item=>item.kind),[...channels].reverse());
  assert.equal(expanded.lastContacted,newest.occurredAt+1002,'Note and postal mail do not advance Last contacted');
  assert.equal(expanded.lastActivity,newest.occurredAt+1004,'postal mail advances Last logged activity');
  const expandedOlder=await (await request(path(record)+'&'+new URLSearchParams({afterAt:expanded.next.at,afterId:expanded.next.id}),{headers})).json();
  assert.equal(expandedOlder.lastContacted,expanded.lastContacted);
  assert.equal(expandedOlder.lastActivity,expanded.lastActivity);
  await verifyActivityFilters({request,origin,headers,other,record,otherRecord,sql,sharing,scope,expanded,
    older:{older,loggedEmail,ids}});
  assert.deepEqual(await (await read(record)).json(),expanded,'Filter reads leave the unfiltered timeline unchanged');
  return expanded;
}

const utcDay=at=>new Date(at).toISOString().slice(0,10);
const dayStart=day=>Date.parse(day+'T00:00:00Z');
async function verifyActivityFilters({request,origin,headers,other,record,otherRecord,sql,sharing,scope,expanded,older:{older,loggedEmail,ids}}){
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const url=(filters,contact=record)=>'/api/logged-activities?'+new URLSearchParams({contactId:contact.id,...filters});
  const list=async(filters,auth=headers)=>{
    const response=await request(url(filters),{headers:auth});
    assert.equal(response.status,200,JSON.stringify(filters));
    const page=await response.json();
    assert.equal(page.lastContacted,expanded.lastContacted,'Filters never change Last contacted');
    assert.equal(page.lastActivity,expanded.lastActivity,'Filters never change Last logged activity');
    return page;
  };
  const after=next=>({afterAt:String(next.at),afterId:next.id});
  const descending=items=>items.every((item,index)=>index===0||items[index-1].occurredAt>item.occurredAt||
    items[index-1].occurredAt===item.occurredAt&&items[index-1].id>item.id);

  // Exact inclusive UTC boundaries on a quiet day three days before the older activities.
  const day=utcDay(older.occurredAt-3*86_400_000),start=dayStart(day),end=start+86_399_999;
  const edges=[['Note',start-1],['Note',start],['SMS',start+1],['Note',end],['Note',end+1]].map(([kind,at])=>({id:randomUUID(),kind,at}));
  for(const {id,kind,at} of edges){
    await sql`INSERT INTO portable_contact_activities(workspace_id,id,contact_id,actor_id,kind,occurred_at,recorded_at,summary)
      VALUES(${scope.workspace_id},${id},${record.id},${scope.owner_id},${kind},${at},${at},'Fictional boundary activity')`;
  }
  try{
    const bounded=await list({from:day,to:day});
    assert.deepEqual(bounded.items.map(item=>item.id),[edges[3].id,edges[2].id,edges[1].id]);
    assert.equal(bounded.next,null);
    const nextDay=utcDay(end+1),previousDay=utcDay(start-1);
    assert.deepEqual((await list({from:nextDay,to:nextDay})).items.map(item=>item.id),[edges[4].id],'Days start at 00:00:00.000 UTC');
    assert.deepEqual((await list({from:previousDay,to:previousDay})).items.map(item=>item.id),[edges[0].id],'Days end at 23:59:59.999 UTC');
    assert.equal((await list({to:previousDay})).items[0].id,edges[0].id,'An open-ended To bound is inclusive');
    assert.deepEqual((await list({from:day,to:day,channel:'Note'})).items.map(item=>item.id),[edges[3].id,edges[1].id]);
    assert.deepEqual((await list({from:day,to:day,channel:'SMS'})).items.map(item=>item.id),[edges[2].id]);
    const none=await list({from:day,to:day,channel:'Postal mail'});
    assert.deepEqual([none.items,none.next],[[],null],'An empty match keeps record-wide dates');

    // A date filter keeps keyset order and stays applied across pages.
    const olderDay=utcDay(older.occurredAt);
    assert.equal(utcDay(loggedEmail.occurredAt),olderDay);
    const first=await list({from:olderDay,to:olderDay});
    assert.equal(first.items.length,25);
    assert.ok(first.next);
    const second=await list({from:olderDay,to:olderDay,...after(first.next)});
    assert.equal(second.next,null);
    const both=[...first.items,...second.items];
    assert.ok(descending(both));
    assert.ok(both.every(item=>utcDay(item.occurredAt)===olderDay));
    assert.deepEqual(new Set(both.map(item=>item.id)),new Set([older.id,loggedEmail.id,...ids]));

    // Channel filters page within the channel only.
    const calls=await list({channel:'Call'});
    assert.equal(calls.items.length,25);
    const moreCalls=await list({channel:'Call',...after(calls.next)});
    const allCalls=[...calls.items,...moreCalls.items];
    assert.ok(allCalls.every(item=>item.kind==='Call'));
    assert.ok(descending(allCalls));
    assert.equal(moreCalls.next,null);
    assert.equal(allCalls.length,26);
    for(const channel of ['Email','Meeting','LinkedIn','SMS','WhatsApp','Note','Postal mail']){
      const page=await list({channel});
      assert.ok(page.items.length>0&&page.items.every(item=>item.kind===channel),channel);
    }

    // Invalid filters, write/removal/history inputs and foreign or revoked scopes.
    for(const filters of [{channel:'Unknown activity'},{channel:''},{from:'2026-02-30'},{to:'2026-1-01'},
      {from:'2026-03-02',to:'2026-03-01'},{from:''}]){
      assert.equal((await request(url(filters),{headers})).status,400,JSON.stringify(filters));
    }
    assert.equal((await request(url({channel:'Call',from:day})+'&channel=Note',{headers})).status,400);
    assert.equal((await request(url({channel:'Call',removed:'1'}),{headers})).status,400);
    assert.equal((await request(url({history:older.id,channel:'Meeting'}),{headers})).status,400);
    const filteredWrite=await request(url({channel:'Call'}),{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
      body:JSON.stringify({id:randomUUID(),kind:'Call',occurredAt:Date.now()-1000,summary:'Fictional filtered write'})});
    assert.equal(filteredWrite.status,400);
    assert.equal((await request(url({channel:'Call'},otherRecord),{headers})).status,404);
    assert.equal((await request(url({channel:'Call',from:day}),{headers:other})).status,404);
    assert.equal((await request(url({channel:'Call',workspaceId:sharing.workspaceId}),{headers:other})).status,404);
    await sql`DELETE FROM portable_contact_activities WHERE id=${edges[2].id}`;
    assert.deepEqual((await list({from:day,to:day,channel:'SMS'})).items,[],'Removed activities leave filtered reads');
  }finally{
    await sql`DELETE FROM portable_contact_activities WHERE id IN ${sql(edges.map(edge=>edge.id))}`;
    await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
      (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  }
}

export async function verifyPortableSharedOutreach({request,origin,headers,other,record,otherRecord,sql,sharing}){
  const base='/api/logged-activities?contactId='+record.id;
  const shared=base+'&workspaceId='+sharing.workspaceId;
  const screen='/?contact='+record.id+'&workspaceId='+sharing.workspaceId;
  const post=(path,auth,data)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  const read=()=>request(shared,{headers:other});
  const write=(input,id=sharing.grantId)=>post(shared+'&grantId='+id,other,input);
  const note={id:randomUUID(),kind:'Call',occurredAt:Date.now()-1000,summary:'Fictional teammate outreach'};
  const [editor]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const [owner]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${sharing.workspaceId}`;
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_write' AND subject IN (${editor.id},${owner.owner_id})`;
  async function change(action,fields){
    const response=await post('/api/workspaces',headers,{action,id:sharing.grantId,...fields});
    assert.equal(response.status,200);
    const grant=(await response.json()).viewers.find(viewer=>viewer.email==='other@example.test');
    sharing.grantId=grant.id;
    assert.equal(grant.scheduledNotes,true);
    return grant;
  }
  assert.equal((await read()).status,404);
  const unshared=await (await request(screen,{headers:other})).text();
  assert.doesNotMatch(unshared,/Logged activities/);
  assert.match(unshared,/aria-label="Activity access"/);
  assert.match(unshared,/>Contact outreach</);
  assert.equal((await write(note)).status,403);
  assert.equal((await post('/api/workspaces',other,{action:'contact_outreach',id:sharing.grantId,enabled:true})).status,404);

  await change('role',{role:'viewer'});
  assert.equal((await change('contact_outreach',{enabled:true})).contactOutreach,true);
  assert.equal((await read()).status,200);
  assert.deepEqual(await (await read()).json(),sharing.outreach);
  const viewerPage=await (await request(screen,{headers:other})).text();
  assert.match(viewerPage,/aria-label="Logged activities"/);
  assert.doesNotMatch(viewerPage,/aria-label="Activity access"/);
  assert.doesNotMatch(viewerPage,/>Log activity</);
  assert.equal((await write(note)).status,403);

  const stale=sharing.grantId;
  await change('role',{role:'editor'});
  assert.equal((await write(note,stale)).status,403);
  assert.equal((await post(shared,other,note)).status,403);
  assert.equal((await post(shared.replace(record.id,otherRecord.id)+'&grantId='+sharing.grantId,other,note)).status,404);
  assert.equal((await write(note)).status,201);
  assert.equal((await write(note)).status,200);
  assert.equal((await post(base,headers,note)).status,409);
  assert.equal((await sql`SELECT actor_id FROM portable_contact_activities WHERE id=${note.id}`)[0].actor_id,editor.id);

  const denied={...note,id:randomUUID()};
  let racingWrite;
  await sql.begin(async tx=>{
    await tx`UPDATE portable_workspace_viewers SET contact_outreach=false WHERE id=${sharing.grantId}`;
    racingWrite=write(denied);
    let waiting=false;
    for(let attempt=0;attempt<80&&!waiting;attempt++){
      const [result]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE '%portable_workspace_viewers%' AND query LIKE '%for share%') AS waiting`;
      waiting=result.waiting;
      if(!waiting)await delay(25);
    }
    assert.ok(waiting,'An outreach write must wait for the owner’s permission change.');
  });
  assert.equal((await racingWrite).status,403);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_contact_activities WHERE id=${denied.id}`)[0].count,0);
  assert.equal((await read()).status,404);
  assert.equal((await write(note)).status,403);
  await change('contact_outreach',{enabled:true});
  sharing.outreach=await (await request(base,{headers})).json();
  assert.ok(sharing.outreach.items.some(item=>item.id===note.id));
  assert.equal(sharing.outreach.lastContacted,note.occurredAt);
  sharing.sharedOutreachAuthor={activityId:note.id,actorId:editor.id};
}
