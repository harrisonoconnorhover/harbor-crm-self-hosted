import {verifyFirstResponseQueue} from './portable-first-response-queue-fixture.mjs';
import assert from 'node:assert/strict';

export async function verifyFirstResponse({request,origin,headers,other,sql}){
  const api='/api/tickets',settings='/api/ticket-sla?kind=first-response',sharing='/api/workspaces';
  const get=(path,auth=headers)=>request(path,{headers:auth});
  async function post(path,input,auth=headers){
    const send=()=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(input)});
    const response=await send();
    if(response.status!==429)return response;
    const seconds=Number(response.headers.get('retry-after'));
    assert.ok(seconds>0&&seconds<=60);
    await response.body?.cancel();
    await new Promise(resolve=>setTimeout(resolve,seconds*1000));
    return send();
  }
  async function ok(value){const r=await value;assert.ok(r.ok,await r.clone().text());return r.json();}
  assert.equal((await get(settings,{})).status,401);
  const defaults=await ok(get(settings));
  assert.equal(defaults.enabled,false);
  const newTicket=async(name,priority='High')=>(await ok(post(api,{action:'save',data:{name,ticketPriority:priority}}))).record;
  const old=await newTicket('Before response targets');
  const open={...defaults,enabled:true,targets:{Urgent:10,High:30,Medium:90,Low:null},
    calendar:{zone:'UTC',week:Array(7).fill({open:0,close:1440}),holidays:[]}};
  const concurrent=await Promise.all([post(settings,open),post(settings,open)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  assert.ok(!(await ok(get(api+'?id='+old.id))).firstResponse);
  assert.ok(!(await newTicket('No Low priority target','Low')).firstResponse);
  const a=await newTicket('Device will not start'),b=await newTicket('Display is blank');
  assert.equal(a.firstResponse.status,'waiting');
  assert.equal(Date.parse(a.firstResponse.dueAt)-Date.parse(a.createdAt),30*60000);
  const waiting=await ok(get(api+'?response=waiting'));
  assert.deepEqual(waiting.records.map(t=>t.id).sort(),[a.id,b.id].sort());
  await ok(post(settings,{...defaults,enabled:false,revision:1}));
  assert.equal((await ok(get(settings,other))).revision,0);
  assert.equal((await ok(get(api+'?id='+a.id))).firstResponse.policyRevision,1);
  const closed=(await ok(post(api,{action:'status',id:a.id,status:'Closed',expectedRevision:a.revision}))).record;
  assert.equal(closed.firstResponse.respondedAt,null);
  const grantState=await ok(post(sharing,{action:'grant',email:'other@example.test'}));
  let grant=grantState.viewers.find(v=>v.email==='other@example.test');
  const scoped=()=>api+'?'+new URLSearchParams({workspaceId:grantState.owned,grantId:grant.id});
  const entry={action:'first_response',expectedRevision:closed.revision,id:a.id,channel:'Phone',summary:'Walked the customer through a power reset.'};
  assert.equal((await post(scoped(),entry,other)).status,403);
  const take={action:'take_first_response',id:b.id,expectedRevision:b.revision};
  assert.equal((await post(scoped(),take,other)).status,403);
  assert.equal((await post(api,{...take,id:a.id,expectedRevision:closed.revision})).status,409);
  const editors=await ok(post(sharing,{action:'role',role:'editor',id:grant.id}));
  grant=editors.viewers.find(v=>v.email==='other@example.test');
  assert.equal((await post(scoped(),{...entry,at:'1999-01-01T00:00:00.000Z'},other)).status,400);
  const candidates=[entry,{...entry,summary:'Provided restart instructions by phone.'}];
  const racers=await Promise.all(candidates.map(input=>post(scoped(),input,other)));
  assert.deepEqual(racers.map(r=>r.status).sort(),[200,409]);
  const winner=candidates[racers.findIndex(r=>r.ok)];
  const response=(await ok(post(scoped(),winner,other))).record.firstResponse;
  assert.equal(response.summary,winner.summary);assert.equal(response.status,'met');assert.equal(response.channel,'Phone');
  const [rep]=await sql`SELECT id,full_name,email FROM login_identities WHERE email='other@example.test'`;
  assert.equal(response.actorId,rep.id);assert.equal(response.recordedBy,rep.full_name||rep.email);assert.ok(response.workingMs>=0);
  const status=await ok(post(api,{action:'status',id:a.id,status:'New',expectedRevision:closed.revision}));
  assert.equal(status.record.firstResponse.respondedAt,response.respondedAt);
  // Age this fictional receipt by a day to exercise a missed deadline without waiting for it.
  await sql`UPDATE portable_ticket_first_responses SET started_at=started_at-interval '1 day',due_at=due_at-interval '1 day' WHERE ticket_id=${b.id}`;
  assert.deepEqual((await ok(get(api+'?response=overdue'))).records.map(t=>t.id),[b.id]);
  const late=(await ok(post(api,{...entry,id:b.id,expectedRevision:b.revision}))).record.firstResponse;
  assert.equal(late.status,'late');assert.ok(late.workingMs>=86400000);
  assert.deepEqual((await ok(get(api+'?response=late'))).records.map(t=>t.id),[b.id]);
  const csv=await get(api+'?export=csv&response=met');assert.equal(csv.status,200);
  const text=await csv.text();assert.ok(text.includes(a.id)&&!text.includes(b.id));assert.match(text,/Response working minutes/);
  const queue=await verifyFirstResponseQueue({request,origin,headers,other,sql,workspaceId:grantState.owned,grantId:grant.id,newTicket,post,get,ok,open});
  const dashboardPath=await verifyResponseReport({origin,headers,other,get,post,ok,sql,workspace:grantState.owned,lateTicket:b});
  const restricted=await ok(post(sharing,{action:'record_scope',id:grant.id,viewScope:'all',editScope:'owned'}));
  grant=restricted.viewers.find(v=>v.email==='other@example.test');
  const visibleQueue=(await ok(get(queue,other))).records;
  assert.ok(visibleQueue.length>0);
  const restrictedQueue=await get('/tickets'+queue.slice(queue.indexOf('?')),other);
  assert.doesNotMatch((await restrictedQueue.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''),/>Take ticket</);
  const candidate=visibleQueue.find(ticket=>ticket.assigneeId!==rep.id);
  assert.ok(candidate);
  assert.equal((await post(scoped(),{...take,id:candidate.id,expectedRevision:candidate.revision},other)).status,404);
  const visible=await get('/tickets?id='+b.id+'&workspaceId='+grantState.owned,other);
  assert.equal(visible.status,200);
  const rendered=(await visible.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  assert.match(rendered,/Shared workspace · View only/);
  assert.doesNotMatch(rendered,/>Edit ticket<|>Close ticket</);
  assert.equal((await post(scoped(),winner,other)).status,404);
  const policy=await ok(get(settings));
  await ok(post(settings,{...open,revision:policy.revision}));
  const assigned=(await ok(post(scoped(),{action:'save',data:{name:'Assigned support question',ticketPriority:'High'}},other))).record;
  assert.equal(assigned.assigneeId,rep.id);
  const assignedReply={...entry,id:assigned.id,expectedRevision:assigned.revision,summary:'Answered assigned ticket.'};
  const logged=(await ok(post(scoped(),assignedReply,other))).record;
  assert.equal(logged.firstResponse.actorId,rep.id);
  await ok(post(settings,{...policy,revision:(await ok(get(settings))).revision}));
  const ownOnly=await ok(post(sharing,{action:'record_scope',id:grant.id,viewScope:'owned',editScope:'owned'}));
  grant=ownOnly.viewers.find(v=>v.email==='other@example.test');
  const personal=queue+'&assignee=me';
  const scopedTickets=(await ok(get(personal,other))).records;
  assert.equal(scopedTickets.length,1);
  assert.deepEqual((await ok(get(queue+'&assignee='+rep.id,other))).records.map(t=>t.id),scopedTickets.map(t=>t.id));
  assert.deepEqual((await ok(get(queue+'&assignee='+candidate.assigneeId,other))).records,[]);
  assert.ok(scopedTickets.every(t=>t.assigneeId===rep.id));
  assert.deepEqual((await ok(get(queue+'&assignee=unassigned',other))).records,[]);
  // Rehearse a support handoff with both open and closed tickets on the departing editor.
  const [{owner_id:ownerId}]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${grantState.owned}`;
  // This separate work session follows a full policy, queue and dashboard rehearsal.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN (${ownerId},${rep.id})`;
  const handoff=(name,assigneeId,ticketStatus='New')=>ok(post(api,{action:'save',assigneeId,data:{name:'Handoff drill '+name,ticketStatus}}));
  const first=(await handoff('one',rep.id)).record,second=(await handoff('two',rep.id,'Waiting on us')).record;
  const finished=(await handoff('closed',rep.id,'Closed')).record;
  const retained=(await handoff('owner',ownerId)).record;
  await handoff('unassigned',null);
  const filter='assignee=unavailable&search=Handoff+drill';
  const handoffList=api+'?'+filter;
  assert.deepEqual((await ok(get(handoffList))).records,[]);
  grant=await verifyTicketCoverage({origin,headers,other,get,post,ok,sql,rep,grant,ownerId,workspaceId:grantState.owned,first,second,finished,retained,filter,open,settings});
  const demoted=await ok(post(sharing,{action:'role',role:'viewer',id:grant.id}));
  grant=demoted.viewers.find(v=>v.email==='other@example.test');
  const ids=[first.id,second.id].sort();
  assert.deepEqual((await ok(get(handoffList))).records.map(t=>t.id),ids);
  await ok(post(sharing,{action:'revoke',id:grant.id}));
  const firstPage=await ok(get(handoffList+'&limit=1'));
  assert.deepEqual(firstPage.records.map(t=>t.id),ids.slice(0,1));
  assert.deepEqual((await ok(get(handoffList+'&limit=1&after='+firstPage.next))).records.map(t=>t.id),ids.slice(1));
  assert.deepEqual((await ok(get(handoffList+'&workspaceId='+grantState.owned,other))).records,[]);
  const exported=await get(handoffList+'&export=csv');
  assert.equal(exported.status,200);
  const csvText=await exported.text();
  for(const id of ids)assert.ok(csvText.includes(id));
  for(const id of [finished.id,retained.id])assert.ok(!csvText.includes(id));
  await reassignTicketInBrowser({origin,headers,first,ownerId});
  assert.deepEqual((await ok(get(handoffList))).records.map(t=>t.id),[second.id]);
  const reassigned=await ok(get(api+'?id='+first.id));
  assert.equal(reassigned.assigneeId,ownerId);
  assert.deepEqual((await ok(get(personal,other))).records,[]);
  assert.deepEqual((await ok(get(queue,other))).records,[]);
  assert.equal((await get(dashboardPath,other)).status,404);
  assert.equal((await post(scoped(),winner,other)).status,403);
  return {id:a.id,workspaceId:grantState.owned};
}

async function verifyTicketCoverage({origin,headers,other,get,post,ok,sql,rep,grant,ownerId,workspaceId,first,second,finished,retained,filter,open,settings}){
  const api='/api/tickets',roster='/api/workspaces';
  const setAccess=async edit=>{
    const result=await ok(post(roster,{action:'tool_permissions',ids:[grant.id],tool:'tickets',
      policy:{view:'owned',edit,create:true,delete:false}}));
    grant=result.viewers.find(member=>member.email===rep.email);
  };
  const current=await ok(get(settings));
  await ok(post(settings,{...open,revision:current.revision}));
  const {record}=await ok(post(api,{action:'save',data:{name:'Customer waiting for coverage',ticketPriority:'High'},assigneeId:rep.id}));
  const policy=await ok(get(settings));
  await ok(post(settings,{...current,revision:policy.revision}));
  assert.ok(record.firstResponse?.dueAt);
  const take=ticket=>({action:'take_unavailable',id:ticket.id,expectedRevision:ticket.revision,previousAssigneeId:ticket.assigneeId});
  await setAccess('none');
  assert.deepEqual((await ok(get(api+'?'+filter))).records.map(row=>row.id).sort(),[first.id,second.id].sort());
  const asRep=api+'?'+new URLSearchParams({workspaceId,grantId:grant.id});
  const intake=(await ok(post(asRep,{action:'save',data:{name:'Received by intake specialist'}},other))).record;
  assert.equal(intake.assigneeId,rep.id);
  assert.equal((await post(asRep,take(intake),other)).status,403);
  const csv=await (await get(api+'?'+filter+'&export=csv')).text();
  assert.ok(csv.includes(first.id)&&csv.includes(second.id)&&!csv.includes(finished.id)&&!csv.includes(retained.id));
  assert.equal((await post(api,{action:'save',data:{name:'Cannot be assigned'},assigneeId:rep.id})).status,400);
  assert.equal((await post(api,take(finished))).status,409);
  assert.equal((await post(api,{...take(record),previousAssigneeId:ownerId})).status,409);
  await setAccess('owned');
  assert.deepEqual((await ok(get(api+'?'+filter))).records,[]);
  assert.equal((await post(api,take(record))).status,409,'Access was restored after the queue loaded.');
  await setAccess('none');
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/tickets?id='+retained.id);
    await page.getByRole('button',{name:'Edit ticket',exact:true}).click();
    assert.equal(await page.locator('select[name="assigneeId"] option[value="'+rep.id+'"]').count(),0);
    await page.goto(origin+'/tickets');
    await page.getByRole('link',{name:'First responses needing reassignment'}).click();
    await page.getByRole('button',{name:'Take over ticket: '+record.data.name,exact:true}).click();
    await page.getByRole('heading',{name:record.data.name,exact:true}).waitFor();
  }finally{await browser.close();}
  const saved=await ok(get(api+'?id='+record.id));
  assert.deepEqual([saved.assigneeId,saved.revision,saved.firstResponse.dueAt,saved.firstResponse.respondedAt],
    [ownerId,record.revision+1,record.firstResponse.dueAt,record.firstResponse.respondedAt]);
  assert.equal((await post(api,take(record))).status,409);
  const [event]=await sql`SELECT actor_id,previous,data FROM portable_ticket_events WHERE workspace_id=${workspaceId} AND ticket_id=${record.id} AND revision=${saved.revision}`;
  assert.deepEqual([event.actor_id,event.previous.assigneeId,event.data.assigneeId],[ownerId,rep.id,ownerId]);
  await setAccess('owned');
  return grant;
}

async function verifyResponseReport({origin,headers,other,get,post,ok,sql,workspace,lateTicket}){
  const api='/api/reporting',definition={name:'Support first responses',kind:'tickets',groupBy:'firstResponseOutcome'};
  for(const invalid of [{...definition,kind:'deals'},{kind:'tasks',name:'Task response',ticketResponse:'late'},
    {...definition,kind:'deals',groupBy:'firstResponseChannel'},{kind:'leads',name:'Lead replies',firstResponseChannel:'Phone'},
    {...definition,firstResponseChannel:'Unsupported'}]){
    assert.equal((await post(api,{action:'report',definition:invalid})).status,400);
  }
  await ok(post('/api/tickets',{action:'save',data:{name:'Second workspace inquiry'}},other));
  const {item:report}=await ok(post(api,{action:'report',definition}));
  const {item:dashboard}=await ok(post(api,{action:'dashboard',teamVisible:true,definition:{
    name:'Support response review',cards:[{reportId:report.id,wide:false}]}}));
  const path=api+'?view=dashboard&id='+dashboard.id+'&workspaceId='+workspace;
  const [{result}]=(await ok(get(path,other))).cards;
  const tickets=await ok(get('/api/tickets?limit=50&workspaceId='+workspace,other));
  assert.equal(tickets.next,null);
  const outcomes=new Map();
  for(const ticket of tickets.records){
    const status=ticket.firstResponse?.status??'no_target';
    if(!outcomes.has(status))outcomes.set(status,[]);
    outcomes.get(status).push(ticket.id);
  }
  assert.deepEqual([...outcomes.keys()].sort(),['late','met','no_target','overdue','waiting']);
  assert.equal(Number(result.count),tickets.records.length);
  assert.equal(result.rows.length,outcomes.size);
  for(const {key,count} of result.rows){
    const drill=await ok(get(api+'?'+new URLSearchParams({view:'dashboardRecords',id:dashboard.id,reportId:report.id,workspaceId:workspace,group:key}),other));
    assert.deepEqual(drill.records.map(row=>row.id).sort(),outcomes.get(key).sort());
    assert.equal(Number(count),drill.records.length);
  }

  const rateDefinition={...definition,name:'First-response targets met',metric:'rate',measure:'firstResponseTargetMet'};
  const assessed=['met','late','overdue'].flatMap(key=>outcomes.get(key));
  const expectedRate=n=>(100*outcomes.get('met').length/n).toFixed(2);
  const preview=async overrides=>post(api,{action:'preview',definition:{...rateDefinition,...overrides}});
  const initialRate=(await ok(preview({}))).result;
  assert.equal(initialRate.total,expectedRate(assessed.length));
  assert.equal(Number(initialRate.count),assessed.length);
  assert.deepEqual(initialRate.rows.map(row=>[row.key,row.value,Number(row.count)]).sort(),[
    ['late','0.00',outcomes.get('late').length],['met','100.00',outcomes.get('met').length],['overdue','0.00',outcomes.get('overdue').length],
  ]);
  assert.deepEqual((await ok(preview({ticketResponse:'waiting'}))).result,{total:null,count:'0',rows:[],truncated:false});
  for(const invalid of [{kind:'deals',groupBy:'stage'},{chart:'share'},{measure:'amount'}])assert.equal((await preview(invalid)).status,400);

  // Advance one fictional waiting deadline. The saved card must reflect it on the next read.
  const [waitingId]=outcomes.get('waiting');
  await sql`UPDATE portable_ticket_first_responses SET started_at=now()-interval '2 hours',due_at=now()-interval '1 hour'
    WHERE workspace_id=${workspace} AND ticket_id=${waitingId}`;
  const refreshed=(await ok(get(path,other))).cards[0].result;
  assert.equal(Number(refreshed.rows.find(row=>row.key==='overdue').count),outcomes.get('overdue').length+1);
  assert.equal(refreshed.count,result.count);

  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    const {item:targetReport}=await ok(post(api,{action:'report',definition:{...definition,name:rateDefinition.name}}));
    await page.goto(origin+'/?view=reports&reportId='+targetReport.id);
    await page.getByText('Edit report',{exact:true}).click();
    await page.getByRole('combobox',{name:/^Measure/}).selectOption({label:'First-response targets met (%)'});
    await page.getByLabel('Default display').selectOption('bar');
    await page.getByRole('button',{name:'Save report',exact:true}).click();
    const bars=page.getByRole('figure',{name:rateDefinition.name+' bar chart'});
    await bars.getByText('100%',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Share of total'}).count(),0);
    await page.getByRole('button',{name:'Table',exact:true}).click();
    const updatedTotal=expectedRate(assessed.length+1);
    const formatted=new Intl.NumberFormat('en-US',{style:'percent',maximumFractionDigits:1}).format(Number(updatedTotal)/100);
    assert.equal(await page.getByRole('table',{name:'Report results'}).locator('tfoot td').innerText(),formatted);
    const {item:rateDashboard}=await ok(post(api,{action:'dashboard',teamVisible:true,definition:{
      name:'Support target attainment',cards:[{reportId:targetReport.id,wide:false}]}}));
    const cardQuery=new URLSearchParams({view:'dashboard',id:rateDashboard.id,workspaceId:workspace});
    const [sharedRate]=(await ok(get(api+'?'+cardQuery,other))).cards;
    assert.equal(sharedRate.result.total,updatedTotal);
    cardQuery.set('view','dashboardRecords');cardQuery.set('reportId',targetReport.id);
    assert.deepEqual((await ok(get(api+'?'+cardQuery,other))).records.map(r=>r.id).sort(),[...assessed,waitingId].sort());
    cardQuery.set('group','overdue');
    assert.deepEqual((await ok(get(api+'?'+cardQuery,other))).records.map(r=>r.id).sort(),[...outcomes.get('overdue'),waitingId].sort());
    const rateCsv=await post(api,{action:'export',id:targetReport.id,revision:targetReport.revision+1});
    assert.equal(rateCsv.status,200);
    const rateLines=(await rateCsv.text()).trimEnd().split('\r\n');
    assert.equal(rateLines[0],'"First-response outcome","First-response targets met (%)","Assessed tickets"');
    assert.equal(rateLines.at(-1),`"All records","${updatedTotal}","${assessed.length+1}"`);
    await page.goto(origin+'/?view=reports&reportId='+report.id);
    await page.getByText('Edit report',{exact:true}).click();
    assert.equal(await page.getByRole('combobox',{name:'Group by'}).inputValue(),'firstResponseOutcome');
    await page.getByRole('combobox',{name:'First-response outcome filter'}).selectOption('late');
    await page.getByRole('button',{name:'Save report',exact:true}).click();
    await page.getByText('First-response outcome is Responded late',{exact:true}).waitFor();
    await page.getByRole('button',{name:'View records for Responded late',exact:true}).click();
    await page.getByRole('region',{name:'Matching records for '+definition.name}).getByRole('link',{name:lateTicket.data.name}).waitFor();
    await verifyWorkingMinutes({page,origin,post,get,ok,sql,dashboard,workspace,other});
    await verifySplitShift({page,origin,post,get,ok});
  }finally{await browser.close();}
  const card=(await ok(get(path,other))).cards[0];
  assert.equal(card.definition.ticketResponse,'late');
  const lateCount=String(outcomes.get('late').length);
  assert.deepEqual(card.result.rows,[{key:'late',label:'Responded late',value:lateCount,count:lateCount}]);
  const csv=await post(api,{action:'export',id:report.id,revision:report.revision+1});
  assert.equal(csv.status,200);
  assert.deepEqual((await csv.text()).trimEnd().split('\r\n'),[
    '"First-response outcome","Record count"',`"Responded late","${lateCount}"`,`"Matching records","${lateCount}"`]);
  return path;
}

async function verifyWorkingMinutes({page,origin,post,get,ok,sql,dashboard,workspace,other}){
  const settings='/api/ticket-sla?kind=first-response',api='/api/reporting';
  const previous=await ok(get(settings));
  await ok(post(settings,{...previous,enabled:true,calendar:{zone:'UTC',week:[null,...Array(5).fill({open:540,close:1020}),null],holidays:['2024-05-27']}}));
  const sample=[];
  const [rep]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const start='2024-05-24T16:45:00.000Z'; // Friday before the Monday holiday.
  for(const [priority,at,minutes] of [
    ['High',start,0],['High','2024-05-28T09:15:30.000Z',30.5],['Urgent','2024-05-28T10:15:00.000Z',90],
    ['High',null,null],['Low',null,null],
  ]){
    const {record}=await ok(post('/api/tickets',{action:'save',assigneeId:sample.length<2?rep.id:null,data:{name:'Form inquiry '+sample.length,ticketSource:'Form',ticketPriority:priority}}));
    if(at){
      // Move only the fictional start into the past, then log the real dated response.
      await sql`UPDATE portable_ticket_first_responses SET started_at=${start} WHERE workspace_id=${workspace} AND ticket_id=${record.id}`;
      const response=await ok(post('/api/tickets',{action:'first_response',id:record.id,expectedRevision:record.revision,at,channel:sample.length===1?'Phone':'Email',summary:'Answered the inquiry.'}));
      assert.equal(response.record.firstResponse.workingMs,minutes*60000);
    }
    sample.push(record);
  }
  const {item}=await ok(post(api,{action:'report',definition:{name:'Form response time',kind:'tickets',ticketSource:'Form',groupBy:'ticketPriority',chart:'share'}}));
  await page.goto(origin+'/?view=reports&reportId='+item.id);
  await page.getByText('Edit report',{exact:true}).click();
  const display=page.getByLabel('Default display');
  assert.equal(await display.inputValue(),'share');
  await page.getByRole('combobox',{name:/^Measure/}).selectOption('average');
  assert.equal(await display.locator('option[value="share"]').count(),0);
  assert.equal(await display.inputValue(),'');
  await display.selectOption('bar');
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  await page.getByRole('figure',{name:'Form response time bar chart'}).waitFor();
  await page.getByText('3 answered tickets included',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Share of total',exact:true}).count(),0);
  await page.getByRole('button',{name:'Table',exact:true}).click();
  assert.equal(await page.getByRole('table',{name:'Report results'}).locator('tfoot td').innerText(),'40.17');

  await ok(post(api,{action:'dashboard',id:dashboard.id,revision:dashboard.revision,teamVisible:true,
    definition:{...dashboard.definition,cards:[...dashboard.definition.cards,{reportId:item.id,wide:false}]}}));
  const query=new URLSearchParams({view:'dashboard',id:dashboard.id,workspaceId:workspace});
  const {cards}=await ok(get(api+'?'+query,other));
  const card=cards.find(card=>card.reportId===item.id);
  assert.ok(card);
  assert.equal(card.definition.name,'Form response time');
  assert.equal(card.result.total,'40.17');assert.equal(card.result.count,'3');
  assert.deepEqual(card.result.rows.map(row=>[row.key,row.value,row.count]).sort(),[['High','15.25','2'],['Urgent','90.00','1']]);
  query.set('view','dashboardRecords');query.set('reportId',item.id);query.set('group','High');
  const drill=await ok(get(api+'?'+query,other));
  assert.deepEqual(drill.records.map(row=>row.id).sort(),sample.slice(0,2).map(row=>row.id).sort());
  const csv=await post(api,{action:'export',id:item.id,revision:item.revision+1});
  assert.equal(csv.status,200);
  const exported=await csv.text();
  assert.match(exported,/^"Ticket priority","Average first response \(working minutes\)","Answered tickets"/);
  assert.match(exported,/"Matching records","40.17","3"/);
  const preview=definition=>post(api,{action:'preview',definition:{...card.definition,...definition}});
  const assignees=await ok(preview({groupBy:'assignee'}));
  assert.equal(assignees.result.total,'40.17');
  assert.deepEqual(Object.fromEntries(assignees.result.rows.map(r=>[r.key,[r.value,r.count]])),{[rep.id]:['15.25','2'],null:['90.00','1']});
  await page.getByText('Edit report',{exact:true}).click();
  await page.getByRole('combobox',{name:/^Group by/}).selectOption({label:'Assigned to'});
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  await page.getByRole('button',{name:'View records for Unassigned',exact:true}).click();
  await page.getByRole('link',{name:'Form inquiry 2',exact:true}).waitFor();
  const regrouped=await ok(get(api+'?'+new URLSearchParams({view:'dashboard',id:dashboard.id,workspaceId:workspace}),other));
  assert.deepEqual(regrouped.cards.find(c=>c.reportId===item.id).result,assignees.result);
  const handedOff=sample[2];
  await ok(post('/api/tickets',{action:'save',id:handedOff.id,expectedRevision:handedOff.revision,assigneeId:rep.id,data:{name:handedOff.data.name}}));
  const afterHandoff=await ok(preview({groupBy:'assignee'}));
  assert.deepEqual(afterHandoff.result.rows.map(r=>[r.key,r.value,r.count]),[[rep.id,'40.17','3']]);
  const empty=await ok(preview({ticketPriority:'Low'}));
  assert.deepEqual(empty.result,{count:'0',total:null,rows:[],truncated:false});
  assert.equal((await preview({chart:'share'})).status,400);

  const byChannel={groupBy:'firstResponseChannel'};
  const counted=await ok(preview({...byChannel,metric:'count',measure:''}));
  assert.equal(counted.result.total,'5');
  assert.deepEqual(counted.result.rows.map(row=>[row.label,row.count]).sort(),
    [['Email','2'],['No recorded first response','2'],['Phone','1']]);
  const averages=await ok(preview(byChannel));
  assert.deepEqual(averages.result.rows.map(row=>[row.key,row.value,row.count]).sort(),[['Email','45.00','2'],['Phone','30.50','1']]);
  const noChat=await ok(preview({...byChannel,firstResponseChannel:'Chat'}));
  assert.equal(noChat.result.total,null);

  await page.goto(origin+'/?view=reports&reportId='+item.id);
  await page.getByText('Edit report',{exact:true}).click();
  await page.getByRole('combobox',{name:'Group by',exact:true}).selectOption('firstResponseChannel');
  await page.getByLabel('First-response channel filter').selectOption('Phone');
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  await page.getByText('First-response channel is Phone',{exact:true}).waitFor();
  const shared=await ok(get(api+'?'+new URLSearchParams({view:'dashboard',id:dashboard.id,workspaceId:workspace}),other));
  const phone=shared.cards.find(c=>c.reportId===item.id);
  assert.deepEqual(phone.result.rows,[{key:'Phone',label:'Phone',count:'1',value:'30.50'}]);
  query.set('group','Phone');
  assert.deepEqual((await ok(get(api+'?'+query,other))).records.map(row=>row.id),[sample[1].id]);
  query.set('group','Email');
  assert.deepEqual((await ok(get(api+'?'+query,other))).records,[]);
  const phoneCsv=await post(api,{action:'export',id:item.id,revision:item.revision+3});
  assert.equal(phoneCsv.status,200);
  assert.deepEqual((await phoneCsv.text()).trimEnd().split('\r\n'),[
    '"First-response channel","Average first response (working minutes)","Answered tickets"',
    '"Phone","30.50","1"','"Matching records","30.50","1"',
  ]);
  const accountSettings='/api/workspace-settings';
  const original=await ok(get(accountSettings));
  const changed=await ok(post(accountSettings,{...original.defaults,revision:original.revision,
    dateFormat:'dmy',language:'de',numberFormat:'de-DE',timeZone:'Pacific/Honolulu'}));
  try{
    for(const [auth,suffix] of [[undefined,''],[other,'&workspaceId='+workspace]]){
      const ticketPage=await get('/tickets?id='+sample[1].id+suffix,auth);
      assert.equal(ticketPage.status,200);
      const html=(await ticketPage.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<!--.*?-->/g,'');
      assert.match(html,/27\/05\/2024 · 23:15/);
      assert.match(html,/30,5 working minutes/);
    }
    const pending=sample[3],due=pending.firstResponse.dueAt;
    await page.goto(origin+'/tickets?id='+pending.id);
    const receipt=page.getByRole('region',{name:'First response'});
    const deadline=await receipt.locator('time').innerText();
    await receipt.getByText('Log first customer response',{exact:true}).click();
    await receipt.getByLabel('Reply time in Pacific/Honolulu (leave blank for now)').waitFor();
    await page.goto(origin+'/tickets?'+new URLSearchParams({search:pending.data.name,response:'unanswered'}));
    assert.equal(await page.locator('time[datetime="'+due+'"]').innerText(),deadline);
  }finally{await ok(post(accountSettings,{...original.defaults,revision:changed.revision}));}

}

async function verifySplitShift({page,origin,post,get,ok}){
  // Make the next staffed date two days from now so the same deadline is provable on any test date.
  const nextDay=new Date();
  nextDay.setUTCDate(nextDay.getUTCDate()+2);
  nextDay.setUTCHours(15,0,0,0);
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const day=days[nextDay.getUTCDay()],settings='/api/ticket-sla?kind=first-response';
  const previous=await ok(get(settings));
  await page.goto(origin+'/tickets');
  await page.getByText('First-response targets and support hours',{exact:true}).click();
  const editor=page.locator('form').filter({has:page.getByRole('button',{name:'Save first-response targets'})});
  await editor.getByLabel('Track first responses on new tickets').check();
  await editor.getByLabel('Support time zone').fill('UTC');
  await editor.getByLabel('Holiday closures',{exact:false}).fill('');
  await editor.getByLabel('High response target (minutes)').fill('300');
  for(const weekday of days)await editor.getByRole('checkbox',{name:weekday,exact:true}).setChecked(weekday===day);
  await editor.getByLabel(day+' opening time',{exact:true}).fill('09:00');
  await editor.getByLabel(day+' closing time',{exact:true}).fill('12:00');
  await editor.getByLabel(day+' second shift',{exact:true}).check();
  await editor.getByLabel(day+' second opening time').fill('11:30');
  await editor.getByLabel(day+' second closing time').fill('17:00');
  await editor.getByRole('button',{name:'Save first-response targets'}).click();
  await page.getByText('Start the second shift after the first shift ends.').waitFor();
  await editor.getByLabel(day+' second opening time').fill('13:00');
  await page.getByText('Preview a ticket deadline',{exact:true}).click();
  const preview=page.getByRole('form',{name:'Preview a ticket deadline'});
  const result=preview.locator('..').getByRole('status');
  const calculate=()=>preview.getByRole('button',{name:'Preview deadline'}).click();
  await preview.getByLabel('Ticket opened').fill(new Date().toISOString().slice(0,16));
  await preview.getByLabel('First reply (optional)').fill(nextDay.toISOString().slice(0,16));
  await calculate();
  const predicted=await result.locator('time').getAttribute('datetime');
  assert.equal(predicted,nextDay.toISOString());
  assert.match(await result.innerText(),/Responded on time · 300 working minutes/);
  await preview.getByLabel('First reply (optional)').fill(new Date(nextDay.getTime()+60000).toISOString().slice(0,16));
  await calculate();
  assert.match(await result.innerText(),/Responded late · 301 working minutes/);
  await editor.getByLabel('Holiday closures',{exact:false}).fill(nextDay.toISOString().slice(0,10));
  assert.equal(await result.count(),0);
  await calculate();
  assert.equal(await result.locator('time').getAttribute('datetime'),new Date(nextDay.getTime()+7*86400000).toISOString());
  await editor.getByLabel('Low response target (minutes)').fill('');
  await preview.getByLabel('Sample priority').selectOption('Low');
  await calculate();
  assert.match(await result.innerText(),/No first-response target is set for Low tickets/);
  await preview.getByLabel('Sample priority').selectOption('High');
  await editor.getByLabel('Support time zone').fill('America/New_York');
  await preview.getByLabel('Ticket opened').fill('2026-03-08T02:30');
  await calculate();
  await preview.locator('..').getByRole('alert').filter({hasText:'does not exist in America/New_York'}).waitFor();
  await editor.getByLabel('Support time zone').fill('UTC');
  await editor.getByLabel('Track first responses on new tickets').uncheck();
  await calculate();
  assert.match(await result.innerText(),/Tracking is off/);
  assert.deepEqual(await ok(get(settings)),previous);
  await editor.getByLabel('Track first responses on new tickets').check();
  await editor.getByLabel('Holiday closures',{exact:false}).fill('');
  await editor.getByRole('button',{name:'Save first-response targets'}).click();
  await page.getByText('First-response targets saved.').waitFor();
  const saved=await ok(get(settings));
  assert.deepEqual(saved.calendar.week[nextDay.getUTCDay()],{open:540,close:720,second:{open:780,close:1020}});
  const {record}=await ok(post('/api/tickets',{action:'save',data:{name:'Split shift customer inquiry',ticketPriority:'High'}}));
  assert.equal(record.firstResponse.dueAt,predicted);
  await page.reload();
  await page.getByText('First-response targets and support hours',{exact:true}).click();
  assert.equal(await editor.getByLabel(day+' second opening time').inputValue(),'13:00');
  await editor.getByLabel(day+' second shift',{exact:true}).uncheck();
  await editor.getByRole('button',{name:'Save first-response targets'}).click();
  await page.getByText('First-response targets saved.').waitFor();
  const amended=await ok(get(settings));
  assert.deepEqual(amended.calendar.week[nextDay.getUTCDay()],{open:540,close:720});
  assert.equal(Date.parse((await ok(get('/api/tickets?id='+record.id))).firstResponse.dueAt),nextDay.getTime());
  await editor.getByRole('button',{name:'Add special hours'}).click();
  await editor.getByLabel('Special date 1',{exact:true}).fill(nextDay.toISOString().slice(0,10));
  await editor.getByLabel('Special date 1 opening time').fill('08:00');
  await editor.getByLabel('Special date 1 closing time').fill('14:00');
  await editor.getByRole('button',{name:'Save first-response targets'}).click();
  await page.getByText('First-response targets saved.').waitFor();
  await page.reload();
  await page.getByText('First-response targets and support hours',{exact:true}).click();
  assert.equal(await editor.getByLabel('Special date 1 closing time').inputValue(),'14:00');
  const revised=(await ok(post('/api/tickets',{action:'save',data:{name:'Special hours inquiry',ticketPriority:'High'}}))).record;
  const deadline=nextDay.getTime()-2*3600000; // Five working hours from 08:00.
  assert.equal(Date.parse(revised.firstResponse.dueAt),deadline);
  assert.equal(Date.parse((await ok(get('/api/tickets?id='+record.id))).firstResponse.dueAt),nextDay.getTime());
  await editor.getByRole('button',{name:'Remove Special date 1'}).click();
  const savedRemoval=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes(settings));
  await editor.getByRole('button',{name:'Save first-response targets'}).click();
  assert.ok((await savedRemoval).ok());
  const restoredWeek=await ok(get(settings));
  assert.equal(restoredWeek.calendar.specialHours,undefined);
  assert.equal(Date.parse((await ok(get('/api/tickets?id='+revised.id))).firstResponse.dueAt),deadline);
  await editor.getByLabel(day+' opening time',{exact:true}).fill('22:00');
  await editor.getByLabel(day+' closing time',{exact:true}).fill('06:00');
  const overnightSave=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().includes(settings));
  await editor.getByRole('button',{name:'Save first-response targets'}).click();
  assert.ok((await overnightSave).ok());
  await page.reload();
  await page.getByText('First-response targets and support hours',{exact:true}).click();
  assert.equal(await editor.getByLabel(day+' closing time',{exact:true}).inputValue(),'06:00');
  const overnight=(await ok(post('/api/tickets',{action:'save',data:{name:'Night shift customer inquiry',ticketPriority:'High'}}))).record;
  // The shift starts at 22:00 on the fixture date. Five working hours finish at 03:00 the next day.
  assert.equal(Date.parse(overnight.firstResponse.dueAt),nextDay.getTime()+12*3600000);
  assert.equal(Date.parse((await ok(get('/api/tickets?id='+record.id))).firstResponse.dueAt),nextDay.getTime());
  const overnightPolicy=await ok(get(settings));
  await ok(post(settings,{...previous,revision:overnightPolicy.revision}));
}


async function reassignTicketInBrowser({origin,headers,first,ownerId}){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    const [name,value]=headers.cookie.split('=');
    await context.addCookies([{name,value,url:origin}]);
    const page=await context.newPage();
    await page.goto(origin+'/?view=workspaces');
    await page.getByText('Review assignments after access changes',{exact:true}).click();
    await page.getByRole('link',{name:'Open tickets with unavailable assignees'}).click();
    await page.getByRole('link',{name:first.data.name,exact:true}).click();
    await page.getByRole('button',{name:'Edit ticket',exact:true}).click();
    await page.locator('select[name="assigneeId"]').selectOption(ownerId);
    await page.getByRole('button',{name:'Save ticket',exact:true}).click();
    await page.getByText('Ticket saved.',{exact:true}).waitFor();
    await page.getByRole('link',{name:'Back to tickets'}).click();
    assert.equal(new URL(page.url()).searchParams.get('assignee'),'unavailable');
    assert.equal(await page.getByRole('link',{name:first.data.name,exact:true}).count(),0);
  }finally{await browser.close();}
}
