import assert from 'node:assert/strict';

const slaPath=(recordId)=>recordId?'/api/ticket-sla?'+new URLSearchParams({recordId}):'/api/ticket-sla';
const policyFields=({revision,enabled,targets,warningMinutes})=>({revision,enabled,targets,warningMinutes});
const slaFields=({receipt,status})=>({receipt,status});

async function checked(response,expected=200){
  assert.equal(response.status,expected,await response.clone().text());
  return response.json();
}

export async function verifyPortableTicketSla({request,origin,headers,other,sql,workspaceId}){
  const marker='Fictional close SLA '+crypto.randomUUID();
  const get=(url,auth=headers)=>request(url,{headers:auth});
  const post=(url,body,auth=headers,site=origin)=>request(url,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const readSla=id=>get(slaPath(id)).then(response=>checked(response));
  const setPolicy=body=>post(slaPath(),body).then(response=>checked(response));
  const create=async(label,priority,status='New')=>(await checked(await post('/api/tickets',{
    action:'save',data:{name:marker+' '+label,ticketPriority:priority,ticketStatus:status},
  }),201)).record;
  const transition=(ticket,status)=>post('/api/tickets',{
    action:'status',id:ticket.id,expectedRevision:ticket.revision,status,
  });
  const bySla=(sla)=>get('/api/tickets?'+new URLSearchParams({search:marker,sla})).then(response=>checked(response));
  const resetBudget=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await resetBudget();
  try{
    const initial=await readSla();
    assert.equal(initial.enabled,false);
    assert.equal(initial.revision,0);
    assert.equal((await get(slaPath(),{})).status,401);
    assert.equal((await get(slaPath()+'?workspaceId='+workspaceId,other)).status,403);

    const legacy=await create('before policy','High');
    const targets={Urgent:60,High:30,Medium:null,Low:15};
    const settings={revision:0,enabled:true,targets,warningMinutes:15};
    assert.equal((await post(slaPath(),settings,headers,'https://outside.example.test')).status,403);
    assert.equal((await post(slaPath(),{...settings,warningMinutes:16})).status,400);
    assert.equal((await post(slaPath(),{...settings,targets:{Urgent:null,High:null,Medium:null,Low:null}})).status,400);

    const policyAttempts=await Promise.all([post(slaPath(),settings),post(slaPath(),settings)]);
    assert.deepEqual(policyAttempts.map(response=>response.status).sort(),[200,409]);
    const saved=policyFields(await policyAttempts.find(response=>response.ok).json());
    assert.deepEqual(saved,{...settings,revision:1});
    assert.equal((await post(slaPath(),settings)).status,409);
    const unchanged=await setPolicy(saved);
    assert.deepEqual(unchanged,await checked(await get(slaPath())));
    assert.equal(unchanged.revision,saved.revision);
    const head=await request(slaPath(),{method:'HEAD',headers});
    assert.equal(head.status,200);
    assert.equal(await head.text(),'');
    assert.equal((await readSla(legacy.id)).receipt,null);
    assert.equal((await checked(await get(slaPath(),other))).enabled,false);

    const open=await create('tracked high','High');
    const dueSoon=await create('tracked low','Low');
    const closedOnCreate=await create('initially closed','Urgent','Closed');
    const untracked=await create('no configured target','Medium');
    const first=await readSla(open.id);
    assert.equal(first.status,'active');
    const {receipt}=first;
    assert.equal(receipt.recordId,open.id);
    assert.deepEqual([receipt.policyRevision,receipt.priority,receipt.targetMinutes,receipt.warningMinutes],
      [saved.revision,'High',30,15]);
    assert.equal(receipt.startedAt,open.createdAt);
    assert.equal(Date.parse(receipt.dueAt)-Date.parse(receipt.startedAt),30*60_000);
    assert.equal(Date.parse(receipt.dueAt)-Date.parse(receipt.warningAt),15*60_000);
    assert.equal(receipt.completedAt,null);
    assert.equal((await readSla(untracked.id)).receipt,null);
    assert.equal((await readSla(closedOnCreate.id)).receipt.completedAt,closedOnCreate.createdAt);
    assert.equal((await readSla(closedOnCreate.id)).status,'met');
    assert.equal((await get(slaPath(open.id),other)).status,404);
    assert.equal((await get(slaPath(open.id),{})).status,401);
    const {records:dueRows}=await bySla('due_soon');
    assert.deepEqual(dueRows.map(row=>row.id),[dueSoon.id]);
    assert.equal(dueRows[0].sla.status,'due_soon');

    const changed=policyFields(await setPolicy({...saved,targets:{...targets,High:45}}));
    assert.equal(changed.revision,2);
    const newer=await create('changed target','High');
    assert.equal((await readSla(newer.id)).receipt.targetMinutes,45);
    const disabled=policyFields(await setPolicy({...changed,enabled:false}));
    assert.equal(disabled.revision,3);
    const off=await create('created with policy off','High');
    assert.equal((await readSla(off.id)).receipt,null);
    assert.deepEqual((await readSla(open.id)).receipt,receipt);
    const priorityEdit=(await checked(await post('/api/tickets',{
      action:'save',id:open.id,expectedRevision:open.revision,data:{name:open.data.name,ticketPriority:'Urgent'},
    }))).record;
    assert.deepEqual((await readSla(open.id)).receipt,receipt);

    await sql`ALTER TABLE portable_ticket_events ADD CONSTRAINT fixture_sla_rollback CHECK (revision<>3) NOT VALID`;
    try{
      assert.equal((await transition(priorityEdit,'Closed')).status,503);
      assert.deepEqual((await readSla(open.id)).receipt,receipt);
      const ticket=await checked(await get('/api/tickets?id='+open.id));
      assert.equal(ticket.revision,priorityEdit.revision);
      assert.equal(ticket.closedAt,null);
    }finally{await sql`ALTER TABLE portable_ticket_events DROP CONSTRAINT fixture_sla_rollback`;}

    const closed=(await checked(await transition(priorityEdit,'Closed'))).record;
    const met=await readSla(open.id);
    assert.equal(met.status,'met');
    assert.deepEqual(met.receipt,{...receipt,completedAt:closed.closedAt});
    const reopened=(await checked(await transition(closed,'New'))).record;
    assert.deepEqual((await readSla(open.id)).receipt,receipt);

    await sql`UPDATE portable_ticket_close_sla_receipts SET started_at=started_at-interval '2 hours',
      due_at=due_at-interval '2 hours',warning_at=warning_at-interval '2 hours'
      WHERE workspace_id=${workspaceId} AND ticket_id=${open.id}`;
    const overdue=await readSla(open.id);
    assert.equal(overdue.status,'overdue');
    const {records:overdueRows}=await bySla('overdue');
    assert.deepEqual(overdueRows.map(row=>row.id),[open.id]);
    assert.deepEqual(slaFields(overdueRows[0].sla),slaFields(overdue));
    await checked(await transition(reopened,'Closed'));
    const late=await readSla(open.id);
    assert.equal(late.status,'late');
    assert.equal(late.receipt.dueAt,overdue.receipt.dueAt);
    assert.deepEqual((await bySla('overdue')).records,[]);
    return {policy:disabled,ticketId:open.id,recordSla:slaFields(late),legacyId:legacy.id};
  }finally{await resetBudget();}
}

export async function verifyRestoredPortableTicketSla({request,owner,other,fixture}){
  const read=(url,headers=owner)=>request(url,{headers});
  assert.deepEqual(policyFields(await checked(await read(slaPath()))),fixture.policy);
  assert.deepEqual(slaFields(await checked(await read(slaPath(fixture.ticketId)))),fixture.recordSla);
  const ticket=await checked(await read('/api/tickets?id='+fixture.ticketId));
  assert.deepEqual(slaFields(ticket.sla),fixture.recordSla);
  assert.equal((await checked(await read(slaPath(fixture.legacyId)))).receipt,null);
  assert.equal((await read(slaPath(fixture.ticketId),other)).status,404);
}
