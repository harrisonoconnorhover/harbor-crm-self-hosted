import assert from 'node:assert/strict';

export async function verifyPortableTickets({request,origin,headers,other,sql,workspaceId,grantId,contact,company,foreignContact,foreignCompany}){
  const marker='Ticket fixture '+crypto.randomUUID();
  const path='/api/tickets';
  const get=(params={},auth=headers)=>request(path+'?'+new URLSearchParams(params),{headers:auth});
  const post=(body,auth=headers,site=origin,url=path)=>request(url,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const resetBudget=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const create=async(data,links={},auth=headers)=>{
    const response=await post({action:'save',data,...links},auth);
    assert.equal(response.status,201);
    return (await response.json()).record;
  };
  const change=(ticket,status)=>({action:'status',id:ticket.id,expectedRevision:ticket.revision,status});
  const [owner]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspaceId}`;
  await resetBudget();

  try{
    assert.equal((await get({},{})).status,401);
    assert.equal((await post({action:'save',data:{name:marker}},headers,'https://outside.example.test')).status,403);
    assert.equal((await get({workspaceId},other)).status,200);
    assert.equal((await post({action:'save',data:{name:marker}},other,origin,path+'?workspaceId='+workspaceId)).status,403);
    assert.equal((await get({limit:'51'})).status,400);
    assert.equal((await request(path+'?status=New&status=Closed',{headers})).status,400);
    assert.equal((await request(path+'?source=Email&source=Phone',{headers})).status,400);
    assert.equal((await get({priority:'Critical'})).status,400);
    assert.equal((await get({source:'Unknown'})).status,400);
    for(const category of ['Unknown',''])assert.equal((await get({category})).status,400);
    assert.equal((await post({action:'save',data:{name:marker,ticketStatus:'Invalid'}})).status,400);
    assert.equal((await post({action:'save',data:{name:marker,closedAt:new Date().toISOString()}})).status,400);
    assert.equal((await post({action:'save',data:{name:marker},contactId:foreignContact.id})).status,404);
    assert.equal((await post({action:'save',data:{name:marker},companyId:foreignCompany.id})).status,404);

    const initial={name:marker+' % open',owner:'Fictional Support',ticketPriority:'Urgent',description:'Fictional login issue',
      ticketSource:'Email',ticketCategory:'Technical',ticketStatus:'Waiting on us'};
    const open=await create(initial,{contactId:contact.id,companyId:company.id});
    const closed=await create({name:marker+' closed',ticketStatus:'Closed'});
    const foreign=await create({...initial,name:marker+' foreign'},
      {contactId:foreignContact.id,companyId:foreignCompany.id},other);
    assert.deepEqual(open.data,initial);
    assert.deepEqual([open.revision,open.contactName,open.companyName,open.closedAt],[1,contact.data.name,company.data.name,null]);
    assert.equal(closed.closedAt,closed.createdAt,'Closed-on-create uses one timestamp.');
    assert.equal((await get({id:foreign.id})).status,404);
    assert.equal((await get({id:open.id},other)).status,404);
    assert.equal((await post(change(open,'Closed'),other)).status,404);
    await assert.rejects(sql`UPDATE portable_tickets SET contact_id=${foreignContact.id}
      WHERE workspace_id=${workspaceId} AND id=${open.id}`,error=>error.code==='23503');
    await assert.rejects(sql`UPDATE portable_tickets SET company_id=${foreignCompany.id}
      WHERE workspace_id=${workspaceId} AND id=${open.id}`,error=>error.code==='23503');

    const firstResponse=await get({search:marker,limit:'1'});
    assert.equal(firstResponse.headers.get('cache-control'),'private, no-store');
    const first=await firstResponse.json();
    const second=await (await get({search:marker,limit:'1',after:first.next})).json();
    assert.deepEqual([first.records.length,second.records.length,second.next],[1,1,null]);
    assert.deepEqual(new Set([first.records[0].id,second.records[0].id]),new Set([open.id,closed.id]));
    const filtered=(await (await get({search:marker,status:'Closed'})).json()).records;
    assert.deepEqual(filtered.map(record=>record.id),[closed.id]);
    for(const filter of [{search:'%'},{search:'login issue'},{contactId:contact.id},{companyId:company.id}]){
      assert.deepEqual((await (await get(filter)).json()).records.map(record=>record.id),[open.id]);
    }
    assert.deepEqual((await (await get({contactId:foreignContact.id})).json()).records,[]);

    const list=await request('/tickets?search='+encodeURIComponent(marker)+'&status=&category=',{headers});
    assert.equal(list.status,200);
    const listHtml=await list.text();
    assert.match(listHtml,/Create ticket/);
    assert.match(listHtml,/Fictional|Waiting on us/);
    assert.doesNotMatch(listHtml,new RegExp(foreign.id));
    assert.equal((await request('/tickets?status=New&status=Closed',{headers})).status,404);
    assert.equal((await request('/tickets?contactId='+foreignContact.id,{headers})).status,404);
    const related=await request('/tickets?companyId='+company.id,{headers});
    assert.equal(related.status,200);
    assert.match(await related.text(),new RegExp(open.id));
    assert.match(await (await request('/?contact='+contact.id,{headers})).text(),/Linked tickets/);
    const sharedContact=`/?contact=${contact.id}&workspaceId=${workspaceId}`;
    const sharedCompany=`/?kind=companies&record=${company.id}&workspaceId=${workspaceId}`;
    const linkedTickets=(relationship)=>'/tickets?'+new URLSearchParams({...relationship,workspaceId});
    const linkedContactTickets=linkedTickets({contactId:contact.id});
    for(const [recordPage,ticketsPage] of [[sharedContact,linkedContactTickets],[sharedCompany,linkedTickets({companyId:company.id})]]){
      const record=await request(recordPage,{headers:other});
      assert.equal(record.status,200);
      assert.ok((await record.text()).replaceAll('&amp;','&').includes(`href="${ticketsPage}">Linked tickets`));
      const tickets=await request(ticketsPage,{headers:other});
      assert.equal(tickets.status,200);
      const html=(await tickets.text()).replaceAll('&amp;','&');
      assert.ok(html.includes(`href="${recordPage}">Back to `));
      const from=new URL(ticketsPage,origin).searchParams;
      from.delete('workspaceId');
      const ticketPage='/tickets?'+new URLSearchParams({id:open.id,workspaceId,from:from.toString()});
      assert.ok(html.includes(`href="${ticketPage}"`));
      const detail=await request(ticketPage,{headers:other});
      assert.equal(detail.status,200);
      assert.ok((await detail.text()).replaceAll('&amp;','&').includes(`href="/tickets?${from}&workspaceId=${workspaceId}">Back to tickets`));
      assert.ok(!html.includes(`/tickets?id=${closed.id}`)&&!html.includes(`/tickets?id=${foreign.id}`));
    }
    assert.equal((await request(linkedTickets({contactId:foreignContact.id}),{headers:other})).status,404);
    assert.equal((await request(linkedTickets({companyId:foreignCompany.id}),{headers:other})).status,404);
    assert.equal((await request('/tickets?id='+open.id,{headers:other})).status,404);
    const detail=await (await request('/tickets?id='+open.id,{headers})).text();
    assert.match(detail,/Close ticket/);
    assert.match(detail,/Fictional login issue/);

    const filters={search:marker,status:'Waiting on us',priority:'Urgent',source:'Email',category:'Technical'};
    const secondEmail=await create({...initial,name:marker+' second email',description:'=1+1, "fixture"'},{companyId:company.id});
    const phone=await create({...initial,name:marker+' phone',ticketSource:'Phone'},{companyId:company.id});
    const lowerPriority=await create({...initial,name:marker+' lower priority',ticketPriority:'High'},{companyId:company.id});
    const billing=await create({...initial,name:marker+' billing',ticketCategory:'Billing'},{companyId:company.id});
    const matchedFirst=await (await get({...filters,limit:'1'})).json();
    const matchedSecond=await (await get({...filters,limit:'1',after:matchedFirst.next})).json();
    assert.deepEqual([matchedFirst.records.length,matchedSecond.records.length,matchedSecond.next],[1,1,null]);
    assert.deepEqual(new Set([matchedFirst.records[0].id,matchedSecond.records[0].id]),new Set([open.id,secondEmail.id]));
    assert.equal((await get({id:open.id,source:'Email'})).status,400);
    assert.equal((await get({id:open.id,category:'Technical'})).status,400);

    // Recently updated order: three tickets share one microsecond timestamp and break ties by descending ID.
    await resetBudget();
    const tie='2026-01-02 03:04:05.678901+00',tieCursor='2026-01-02T03:04:05.678Z';
    const setUpdated=(ticket,at)=>sql`UPDATE portable_tickets SET updated_at=${at}::timestamptz
      WHERE workspace_id=${workspaceId} AND id=${ticket.id}`;
    for(const ticket of [open,secondEmail,phone])await setUpdated(ticket,tie);
    await setUpdated(lowerPriority,'2026-01-02 03:04:06.5+00');
    await setUpdated(billing,'2026-01-02 03:04:04.9+00');
    const descIds=tickets=>tickets.map(ticket=>ticket.id).sort().reverse();
    const byUpdated=[lowerPriority.id,...descIds([open,secondEmail,phone]),billing.id];
    const pages=async(params,auth=headers)=>{
      const seen=[],cursors=[];
      let cursor={};
      for(let attempt=0;attempt<6;attempt++){
        const response=await get({...params,...cursor},auth);
        assert.equal(response.status,200);
        const page=await response.json();
        seen.push(...page.records.map(record=>record.id));
        cursors.push(page.nextUpdatedAt);
        if(!page.next)return {seen,cursors};
        cursor={after:page.next,afterUpdatedAt:page.nextUpdatedAt};
      }
      assert.fail('Recently updated pagination did not finish.');
    };
    const updatedScope={search:marker,companyId:company.id,sort:'updated',limit:'2'};
    const updatedPages=await pages(updatedScope);
    assert.deepEqual(updatedPages.seen,byUpdated);
    assert.deepEqual(updatedPages.cursors,[tieCursor,tieCursor,null],'A page boundary inside a timestamp tie keeps its place.');
    assert.deepEqual((await pages({...updatedScope,workspaceId},other)).seen,byUpdated,'Shared readers use the same order.');
    assert.deepEqual((await pages({...updatedScope,limit:'1'})).seen,byUpdated);
    const defaultPage=await (await get({search:marker,companyId:company.id})).json();
    assert.deepEqual(defaultPage.records.map(record=>record.id),[...byUpdated].sort());
    assert.equal('nextUpdatedAt' in defaultPage,false,'ID order keeps its existing page shape.');
    const combined=await pages({...filters,companyId:company.id,sort:'updated',limit:'1'});
    assert.deepEqual(combined.seen,descIds([open,secondEmail]));
    assert.deepEqual(combined.cursors,[tieCursor,null]);
    assert.deepEqual((await pages({search:marker,contactId:foreignContact.id,sort:'updated'})).seen,[]);
    for(const invalid of [{sort:'updated',after:open.id},{sort:'updated',afterUpdatedAt:tieCursor},
      {after:open.id,afterUpdatedAt:tieCursor},{sort:'updated',after:open.id,afterUpdatedAt:'2026-01-02T03:04:05Z'},
      {sort:'updated',after:open.id,afterUpdatedAt:'2026-01-02'},{sort:'updated',after:open.id,afterUpdatedAt:'0000-01-01T00:00:00.000Z'},
      {sort:'name'},{sort:''},{id:open.id,sort:'updated'},{id:open.id,afterUpdatedAt:tieCursor}]){
      assert.equal((await get(invalid)).status,400,JSON.stringify(invalid));
    }
    assert.equal((await get({search:marker,limit:'1',after:first.next})).status,200,'Existing ID cursors still work.');
    assert.equal((await request('/tickets?'+new URLSearchParams({sort:'updated',after:open.id}),{headers})).status,404);
    assert.equal((await request('/tickets?'+new URLSearchParams({id:open.id,sort:'updated'}),{headers})).status,404);
    const updatedHtml=await (await request('/tickets?'+new URLSearchParams(updatedScope),{headers})).text();
    assert.match(updatedHtml,/<option value="updated" selected="">Recently updated<\/option>/);
    const updatedNext=updatedHtml.match(/href="([^"]+)">Next tickets</)?.[1];
    assert.ok(updatedNext,'Recently updated list links to its second page.');
    const updatedNextUrl=new URL(updatedNext.replaceAll('&amp;','&'),origin);
    assert.deepEqual(Object.fromEntries(updatedNextUrl.searchParams),{...updatedScope,after:byUpdated[1],afterUpdatedAt:tieCursor});
    const updatedPageTwo=await (await request(updatedNextUrl.pathname+updatedNextUrl.search,{headers})).text();
    const ticketLinks=html=>[...html.matchAll(/href="\/tickets\?id=([0-9a-f-]{36})(?:&amp;workspaceId=[0-9a-f-]{36})?(?:&amp;from=[^"]*)?"/g)]
      .map(([,id])=>id);
    assert.deepEqual(ticketLinks(updatedPageTwo),byUpdated.slice(2,4));
    const sharedUpdatedHtml=await (await request('/tickets?'+new URLSearchParams({...updatedScope,workspaceId}),{headers:other})).text();
    assert.deepEqual(ticketLinks(sharedUpdatedHtml),byUpdated.slice(0,2));
    const sharedNext=sharedUpdatedHtml.match(/href="([^"]+)">Next tickets</)?.[1];
    assert.ok(sharedNext);
    assert.deepEqual(Object.fromEntries(new URL(sharedNext.replaceAll('&amp;','&'),origin).searchParams),
      {...updatedScope,workspaceId,after:byUpdated[1],afterUpdatedAt:tieCursor});
    const csvIds=async params=>(await (await get({export:'csv',...params})).text()).trimEnd().split('\r\n').slice(1)
      .map(line=>line.slice(1,37));
    assert.deepEqual(await csvIds({search:marker,companyId:company.id,sort:'updated'}),byUpdated);
    assert.deepEqual(await csvIds({search:marker,companyId:company.id}),[...byUpdated].sort());
    for(const extra of [{afterUpdatedAt:tieCursor},{after:open.id,afterUpdatedAt:tieCursor},{sort:'name'}]){
      assert.equal((await get({export:'csv',search:marker,sort:'updated',...extra})).status,400);
    }

    const exportParams={export:'csv',...filters,companyId:company.id};
    const exportUrl=path+'?'+new URLSearchParams(exportParams);
    assert.equal((await get(exportParams,{})).status,401);
    assert.equal((await get({...exportParams,workspaceId})).status,403);
    assert.equal((await get({...exportParams,workspaceId},other)).status,403);
    for(const extra of [{id:open.id},{after:open.id},{limit:'500'},{contactId:contact.id},{export:'json'},{category:'Unknown'}]){
      assert.equal((await get({...exportParams,...extra})).status,400);
    }
    assert.equal((await request(exportUrl+'&source=Phone',{headers})).status,400);
    assert.equal((await request(exportUrl+'&category=Billing',{headers})).status,400);
    const exported=await get(exportParams);
    assert.equal(exported.status,200);
    assert.match(exported.headers.get('content-type'),/^text\/csv/);
    assert.equal(exported.headers.get('cache-control'),'private, no-store');
    assert.equal(exported.headers.get('content-disposition'),'attachment; filename="harbor-tickets.csv"');
    assert.equal(exported.headers.get('x-content-type-options'),'nosniff');
    const csv=await exported.text();
    assert.ok(csv.startsWith('"Ticket ID","Name","Status","Priority"'));
    assert.equal(csv.trimEnd().split('\r\n').length,3);
    assert.match(csv,new RegExp(open.id));
    assert.match(csv,new RegExp(secondEmail.id));
    assert.match(csv,/"'=1\+1, ""fixture"""/);
    assert.doesNotMatch(csv,new RegExp([phone.id,lowerPriority.id,billing.id,closed.id,foreign.id].join('|')));
    const head=await request(exportUrl,{method:'HEAD',headers});
    assert.equal(head.status,200);
    assert.equal(head.headers.get('content-disposition'),exported.headers.get('content-disposition'));
    assert.equal(await head.text(),'');
    const otherCsv=await (await get({export:'csv',...filters},other)).text();
    assert.match(otherCsv,new RegExp(foreign.id));
    assert.doesNotMatch(otherCsv,new RegExp([open.id,secondEmail.id].join('|')));
    const contactCsv=await (await get({export:'csv',...filters,contactId:contact.id})).text();
    assert.match(contactCsv,new RegExp(open.id));
    assert.doesNotMatch(contactCsv,new RegExp(secondEmail.id));

    // An open SLA warning belongs to one matching ticket. An overdue ticket
    // from a different source must still be excluded by the source filter.
    await sql`INSERT INTO portable_ticket_close_sla_receipts
      (workspace_id,ticket_id,policy_revision,priority,target_minutes,warning_minutes,started_at,due_at,warning_at,applied_at)
      VALUES
        (${workspaceId},${secondEmail.id},1,'Urgent',120,60,now()-interval '90 minutes',
          now()+interval '30 minutes',now()-interval '30 minutes',now()),
        (${workspaceId},${phone.id},1,'Urgent',120,60,now()-interval '180 minutes',
          now()-interval '60 minutes',now()-interval '120 minutes',now())`;
    const warning=(await (await get({...filters,sla:'due_soon',companyId:company.id})).json()).records;
    assert.deepEqual(warning.map(record=>record.id),[secondEmail.id]);
    assert.deepEqual((await (await get({...filters,sla:'overdue'})).json()).records,[]);
    const warningCsv=await (await get({...exportParams,sla:'due_soon'})).text();
    assert.match(warningCsv,new RegExp(secondEmail.id));
    assert.match(warningCsv,/,"Due soon","\d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(warningCsv,new RegExp([open.id,phone.id].join('|')));
    const emptyCsv=await (await get({...exportParams,sla:'overdue'})).text();
    assert.equal(emptyCsv.trimEnd().split('\r\n').length,1);

    const filteredParams={...filters,companyId:company.id,limit:'1'};
    const pageOne=await request('/tickets?'+new URLSearchParams(filteredParams),{headers});
    assert.equal(pageOne.status,200);
    const pageOneHtml=await pageOne.text();
    assert.match(pageOneHtml,/<select name="priority">/);
    assert.match(pageOneHtml,/<select name="source">/);
    assert.match(pageOneHtml,/<select name="category">.*<option selected="">Technical<\/option>/);
    assert.match(pageOneHtml,/>Export CSV</);
    assert.doesNotMatch(pageOneHtml,new RegExp([foreign.id,phone.id,lowerPriority.id,billing.id].join('|')));
    const nextLink=pageOneHtml.match(/href="([^"]+)">Next tickets</)?.[1];
    assert.ok(nextLink,'Filtered ticket list links to its second page.');
    const nextUrl=new URL(nextLink.replaceAll('&amp;','&'),origin);
    assert.deepEqual(Object.fromEntries(nextUrl.searchParams),{...filteredParams,after:matchedFirst.next});
    const pageTwo=await request(nextUrl.pathname+nextUrl.search,{headers});
    assert.equal(pageTwo.status,200);
    const pageTwoHtml=await pageTwo.text();
    assert.ok(pageTwoHtml.includes(matchedSecond.records[0].data.name));
    assert.match(pageTwoHtml,/>Export CSV</);
    assert.doesNotMatch(pageTwoHtml,/>Next tickets</);

    const edits=await Promise.all([post(change(open,'Closed')),post(change(open,'Closed'))]);
    assert.deepEqual(edits.map(response=>response.status).sort(),[200,409]);
    const closedOpen=(await edits.find(response=>response.ok).json()).record;
    assert.deepEqual([closedOpen.revision,closedOpen.data.ticketStatus,closedOpen.data.description,closedOpen.contactId,closedOpen.companyId],
      [2,'Closed',initial.description,contact.id,company.id]);
    assert.equal(closedOpen.closedAt,closedOpen.updatedAt);
    const edit={action:'save',id:open.id,expectedRevision:2,data:{name:marker+' edited'},companyId:null};
    const updated=(await (await post(edit)).json()).record;
    assert.equal(updated.closedAt,closedOpen.closedAt,'An edit while closed preserves the original close date.');
    assert.deepEqual(updated.data,{...closedOpen.data,name:marker+' edited'});
    assert.deepEqual([updated.revision,updated.contactId,updated.companyId],[3,contact.id,null]);
    const reopened=(await (await post(change(updated,'New'))).json()).record;
    assert.deepEqual([reopened.revision,reopened.closedAt,reopened.data.ticketStatus],[4,null,'New']);
    const reopenedDetail={...reopened,inboxConversationId:null};
    assert.deepEqual(await (await get({id:open.id})).json(),reopenedDetail);
    const sharedPath=path+'?'+new URLSearchParams({workspaceId,grantId});
    const wrongGrant=path+'?'+new URLSearchParams({workspaceId,grantId:crypto.randomUUID()});
    const sharedCreate={action:'save',data:{name:'Shared editor ticket '+crypto.randomUUID()},contactId:contact.id,companyId:company.id};
    assert.equal((await get({id:open.id,workspaceId},other)).status,200);
    const sharedList=await request('/tickets?'+new URLSearchParams({...filters,workspaceId}),{headers:other});
    assert.equal(sharedList.status,200);
    const sharedListHtml=await sharedList.text();
    assert.match(sharedListHtml,new RegExp(secondEmail.id));
    assert.doesNotMatch(sharedListHtml,new RegExp(`>Export CSV<|${billing.id}|${foreign.id}`));
    assert.equal((await get({id:foreign.id,workspaceId},other)).status,404);
    assert.equal((await post(sharedCreate,other,origin,wrongGrant)).status,403);
    assert.equal((await post({...sharedCreate,contactId:foreignContact.id},other,origin,sharedPath)).status,404);
    const [member]=await sql`SELECT role,viewer_id FROM portable_workspace_viewers WHERE id=${grantId}`;
    assert.equal(member.role,'editor');
    await sql`UPDATE portable_workspace_viewers SET role='viewer' WHERE id=${grantId}`;
    try{
      assert.equal((await get({id:open.id,workspaceId},other)).status,200);
      const viewerList=await get({...filters,workspaceId},other);
      assert.equal(viewerList.status,200);
      assert.deepEqual((await viewerList.json()).records.map(record=>record.id),[secondEmail.id]);
      const viewerRecord=await request(sharedContact,{headers:other});
      assert.equal(viewerRecord.status,200);
      assert.ok((await viewerRecord.text()).replaceAll('&amp;','&').includes(`href="${linkedContactTickets}">Linked tickets`));
      const viewerRelated=await request(linkedContactTickets,{headers:other});
      assert.equal(viewerRelated.status,200);
      assert.doesNotMatch(await viewerRelated.text(),/>Create ticket<|>Export CSV</);

      assert.equal((await post(sharedCreate,other,origin,sharedPath)).status,403);
      assert.equal((await post(change(reopened,'Closed'),other,origin,sharedPath)).status,403);
      const view=await request('/tickets?'+new URLSearchParams({id:open.id,workspaceId}),{headers:other});
      assert.equal(view.status,200);
      assert.doesNotMatch(await view.text(),/>Edit ticket<|>Close ticket</);
    }finally{await sql`UPDATE portable_workspace_viewers SET role=${member.role} WHERE id=${grantId}`;}

    const limitFixture=count=>sql`INSERT INTO portable_tickets (workspace_id,id,revision,data,created_at,updated_at)
      SELECT ${workspaceId},gen_random_uuid(),1,
        jsonb_build_object('name',${marker+' ceiling'}::text,'ticketStatus','New','ticketPriority','Medium'),
        now(),now() FROM generate_series(1,${count})`;
    await limitFixture(500);
    const atLimit=await get({export:'csv',search:marker+' ceiling'});
    assert.equal(atLimit.status,200);
    assert.equal((await atLimit.text()).trimEnd().split('\r\n').length,501);
    await limitFixture(1);
    const beyondLimit=await get({export:'csv',search:marker+' ceiling'});
    assert.equal(beyondLimit.status,413);
    assert.match((await beyondLimit.json()).error,/Narrow your filters/);
    const createdByEditor=await post(sharedCreate,other,origin,sharedPath);
    assert.equal(createdByEditor.status,201,await createdByEditor.clone().text());
    const {record:sharedTicket}=await createdByEditor.json();
    const rename={action:'save',id:sharedTicket.id,expectedRevision:1,data:{name:sharedCreate.data.name+' renamed'}};
    assert.equal((await post(rename,other,origin,sharedPath)).status,200);
    const closedByEditor=await post(change({...sharedTicket,revision:2},'Closed'),other,origin,sharedPath);
    assert.equal(closedByEditor.status,200,await closedByEditor.clone().text());
    const savedForOwner=(await (await get({id:sharedTicket.id})).json());
    assert.deepEqual([savedForOwner.revision,savedForOwner.data.ticketStatus,savedForOwner.data.name],[3,'Closed',rename.data.name]);
    const editsByEditor=await sql`SELECT actor_id,revision FROM portable_ticket_events
      WHERE workspace_id=${workspaceId} AND ticket_id=${sharedTicket.id} ORDER BY revision`;
    assert.deepEqual(editsByEditor.map(row=>[row.actor_id,row.revision]),[[member.viewer_id,1],[member.viewer_id,2],[member.viewer_id,3]]);

    const search=await post({kind:'tickets',query:reopened.data.name},headers,origin,'/api/crm/search');
    assert.equal(search.status,200);
    assert.deepEqual((await search.json()).results,[{id:open.id,kind:'tickets',name:reopened.data.name,detail:''}]);
    const history=await sql`SELECT actor_id,revision,previous,data FROM portable_ticket_events
      WHERE workspace_id=${workspaceId} AND ticket_id=${open.id} ORDER BY revision`;
    assert.deepEqual(history.map(row=>[row.actor_id,row.revision,row.previous?.data.ticketStatus,row.data.data.ticketStatus]),[
      [owner.owner_id,1,undefined,'Waiting on us'],[owner.owner_id,2,'Waiting on us','Closed'],
      [owner.owner_id,3,'Closed','Closed'],[owner.owner_id,4,'Closed','New'],
    ]);

    await sql`ALTER TABLE portable_ticket_events ADD CONSTRAINT fixture_ticket_rollback CHECK (revision<>5)`;
    try{
      assert.equal((await post(change(reopened,'Closed'))).status,503);
      assert.deepEqual(await (await get({id:open.id})).json(),reopenedDetail,'A failed history write rolls back the status change.');
    }finally{await sql`ALTER TABLE portable_ticket_events DROP CONSTRAINT fixture_ticket_rollback`;}
    assert.equal((await post(change(reopened,'Closed'))).status,200);
    const [revoked]=await sql`DELETE FROM portable_workspace_viewers WHERE id=${grantId} RETURNING *`;
    try{
      assert.equal(revoked?.id,grantId);
      assert.equal((await request(sharedContact,{headers:other})).status,404);
      assert.equal((await request(linkedContactTickets,{headers:other})).status,404);
      assert.equal((await request(linkedTickets({companyId:company.id}),{headers:other})).status,404);
    }finally{if(revoked)await sql`INSERT INTO portable_workspace_viewers ${sql(revoked)}`;}
    return {id:sharedTicket.id,closedAt:savedForOwner.closedAt,contactId:contact.id,companyId:company.id,actorId:member.viewer_id};
  }finally{
    await sql`DELETE FROM portable_ticket_events e USING portable_tickets t
      WHERE e.workspace_id=t.workspace_id AND e.ticket_id=t.id AND t.data->>'name' LIKE ${marker+'%'}`;
    await sql`DELETE FROM portable_tickets WHERE data->>'name' LIKE ${marker+'%'}`;
    await resetBudget();
  }
}
