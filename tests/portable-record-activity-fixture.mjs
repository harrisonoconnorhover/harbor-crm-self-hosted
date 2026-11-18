import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const endpoint='/api/logged-activities?';
const path=(kind,recordId)=>endpoint+new URLSearchParams({kind,recordId});
const cursor=({at,id})=>'&'+new URLSearchParams({afterAt:String(at),afterId:id});
const empty={items:[],lastContacted:null,lastActivity:null,next:null};
const log=(request,origin,headers,url,body)=>request(url,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
  body:JSON.stringify(body)});

export async function verifyPortableRecordActivities({request,origin,headers,other,sql,sharing,contact,company,deal,otherCompany,otherDeal}){
  const {workspaceId}=sharing;
  const companyPath=path('companies',company.id),dealPath=path('deals',deal.id);
  const contactPath=endpoint+'contactId='+contact.id;
  const read=(url,auth=headers)=>request(url,{headers:auth});
  const post=(url,body,auth=headers,site=origin)=>log(request,site,auth,url,body);
  const resetBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await resetBudgets();
  const baselineContact=await (await read(contactPath)).json();
  const at=Date.now()-60_000;
  const companyCall={id:randomUUID(),kind:'Call',occurredAt:at,summary:'Fictional Company call'};
  const dealEmail={id:randomUUID(),kind:'Email',occurredAt:at-1000,summary:'Fictional Deal email log'};
  for(const [url,body] of [[companyPath,companyCall],[dealPath,dealEmail]]){
    const response=await read(url);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(await response.json(),empty);
    assert.equal((await read(url,{})).status,401);
    assert.equal((await read(url,other)).status,404);
    assert.equal((await post(url,body,other)).status,404);
    assert.equal((await post(url+'&workspaceId='+workspaceId,body,other)).status,403);
    assert.equal((await read(url+'&grantId='+sharing.grantId,other)).status,400);
    assert.equal((await post(url,{...body,occurredAt:Date.now()+60_000})).status,400);
    assert.equal((await read(url+'&afterAt='+at)).status,400);
    assert.equal((await read(url+'&contactId='+contact.id)).status,400);
  }
  assert.equal((await read(path('companies',otherCompany.id))).status,404);
  assert.equal((await read(path('deals',otherDeal.id))).status,404);
  assert.equal((await post(companyPath,companyCall,headers,'https://outside.example.test')).status,403);
  assert.equal((await read(companyPath+'&recordId='+otherCompany.id)).status,400);
  const attempts=await Promise.all([post(companyPath,companyCall),post(companyPath,companyCall)]);
  assert.deepEqual(attempts.map(response=>response.status).sort(),[200,201]);
  assert.equal((await post(companyPath,{...companyCall,summary:'Other content'})).status,409);
  assert.equal((await post(dealPath,companyCall)).status,409);
  assert.equal((await post(dealPath,dealEmail)).status,201);

  for(const [index,kind] of ['LinkedIn','SMS','WhatsApp','Postal mail','Note'].entries()){
    assert.equal((await post(companyPath,{id:randomUUID(),kind,occurredAt:at+index+1,summary:'Fictional '+kind})).status,201);
  }
  const companyPage=await (await read(companyPath)).json();
  assert.deepEqual(companyPage.items.map(item=>item.kind),['Note','Postal mail','WhatsApp','SMS','LinkedIn','Call']);
  assert.equal(companyPage.lastContacted,at+3);
  assert.equal(companyPage.lastActivity,at+5);
  assert.equal(companyPage.next,null);

  const dealMeeting={id:randomUUID(),kind:'Meeting',occurredAt:at+1,summary:'Fictional logged Deal meeting'};
  const dealNote={id:randomUUID(),kind:'Note',occurredAt:at+2,summary:'Fictional Deal note'};
  assert.equal((await post(dealPath,dealMeeting)).status,201);
  assert.equal((await post(dealPath,dealNote)).status,201);
  const ids=Array.from({length:25},()=>randomUUID());
  const [{owner_id:actor}]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspaceId}`;
  await sql`INSERT INTO portable_record_activities(workspace_id,id,deal_id,actor_id,kind,occurred_at,recorded_at,summary)
    SELECT ${workspaceId},id,${deal.id},${actor},'Email',${dealEmail.occurredAt},${at},'Fictional tie timestamp'
    FROM unnest(${ids}::uuid[]) AS id`;
  const dealFirst=await (await read(dealPath)).json();
  const dealSecond=await (await read(dealPath+cursor(dealFirst.next))).json();
  assert.equal(dealFirst.items.length,25);
  assert.deepEqual(dealFirst.items.slice(0,2),[dealNote,dealMeeting].map(item=>({...item,revision:1})));
  assert.equal(dealSecond.items.length,3);
  assert.equal(dealSecond.next,null);
  assert.deepEqual(new Set([...dealFirst.items,...dealSecond.items].map(item=>item.id)),
    new Set([dealEmail.id,dealMeeting.id,dealNote.id,...ids]));
  assert.equal(dealFirst.lastContacted,dealMeeting.occurredAt);
  assert.equal(dealFirst.lastActivity,dealNote.occurredAt);
  assert.equal(dealSecond.lastContacted,dealFirst.lastContacted);
  assert.equal(dealSecond.lastActivity,dealFirst.lastActivity);
  await verifyRecordActivityFilters({read,post,other,companyPath,dealPath,otherCompany,companyCall,companyPage,dealFirst,dealEmail,ids,at});
  const [receipt]=await sql`SELECT actor_id,company_id,deal_id FROM portable_record_activities WHERE id=${companyCall.id}`;
  assert.deepEqual(receipt,{actor_id:actor,company_id:company.id,deal_id:null});
  await assert.rejects(sql`INSERT INTO portable_record_activities(workspace_id,id,company_id,actor_id,kind,occurred_at,recorded_at,summary)
    VALUES(${workspaceId},${randomUUID()},${otherCompany.id},${actor},'Note',${at},${at},'Foreign activity')`,error=>error.code==='23503');

  assert.deepEqual(await (await read(contactPath)).json(),baselineContact);
  for(const [kind,record] of [['companies',company],['deals',deal]]){
    const url='/?'+new URLSearchParams({kind,record:record.id});
    const page=await read(url);
    assert.equal(page.status,200);
    assert.match(await page.text(),/aria-label="Logged activities"/);
    const recordRead=await (await read('/api/crm?'+new URLSearchParams({kind,id:record.id}))).json();
    assert.equal(recordRead.revision,record.revision);
    if(kind==='deals')assert.equal(recordRead.primaryContactId,record.primaryContactId);
  }
  await verifySharedRecordActivities({read,post,other,sql,sharing,at:at+10,
    cases:[['companies',company,otherCompany,companyPage],['deals',deal,otherDeal,dealFirst]]});
  const savedCompany=await (await read(companyPath)).json();
  const savedDeal=await (await read(dealPath)).json();
  const savedDealSecond=await (await read(dealPath+cursor(savedDeal.next))).json();
  await resetBudgets();
  return {workspaceId,companyPath,companyPage:savedCompany,companyCall,dealPath,dealFirst:savedDeal,dealSecond:savedDealSecond,dealNote};
}

async function verifyRecordActivityFilters({read,post,other,companyPath,dealPath,otherCompany,companyCall,companyPage,dealFirst,dealEmail,ids,at}){
  const day=offset=>new Date(at+offset*86_400_000).toISOString().slice(0,10);
  const filtered=async(url,filters,original)=>{
    const response=await read(url+'&'+new URLSearchParams(filters));
    assert.equal(response.status,200,JSON.stringify(filters));
    const page=await response.json();
    assert.equal(page.lastContacted,original.lastContacted,'Filters never change Last contacted');
    assert.equal(page.lastActivity,original.lastActivity,'Filters never change Last logged activity');
    return page;
  };
  assert.deepEqual((await filtered(companyPath,{channel:'Call'},companyPage)).items,[{...companyCall,revision:1}]);
  assert.deepEqual((await filtered(companyPath,{channel:'Postal mail',to:day(0)},companyPage)).items.map(item=>item.kind),['Postal mail']);
  const later=await filtered(companyPath,{from:day(1)},companyPage);
  assert.deepEqual([later.items,later.next],[[],null]);
  assert.deepEqual((await filtered(companyPath,{from:day(-1),to:day(1)},companyPage)).items,companyPage.items);
  const emails=await filtered(dealPath,{channel:'Email',from:day(-1)},dealFirst);
  assert.equal(emails.items.length,25);
  const moreEmails=await filtered(dealPath,{channel:'Email',from:day(-1),afterAt:String(emails.next.at),afterId:emails.next.id},dealFirst);
  assert.equal(moreEmails.next,null);
  const allEmails=[...emails.items,...moreEmails.items];
  assert.ok(allEmails.every(item=>item.kind==='Email'));
  assert.deepEqual(new Set(allEmails.map(item=>item.id)),new Set([dealEmail.id,...ids]));
  for(const filters of ['channel=Unknown','channel=','from=2026-13-01','from=2026-03-02&to=2026-03-01','channel=Call&channel=Note']){
    assert.equal((await read(companyPath+'&'+filters)).status,400,filters);
  }
  assert.equal((await read(companyPath+'&removed=1&channel=Call')).status,400);
  assert.equal((await post(companyPath+'&channel=Call',{id:randomUUID(),kind:'Call',occurredAt:at,summary:'Fictional filtered write'})).status,400);
  assert.equal((await read(path('companies',otherCompany.id)+'&channel=Call')).status,404);
  assert.equal((await read(companyPath+'&channel=Call',other)).status,404);
}

async function verifySharedRecordActivities({read,post,other,sql,sharing,at,cases}){
  const {workspaceId}=sharing;
  const suffix='&'+new URLSearchParams({workspaceId});
  const targets=cases.map(([kind,record,foreign,original])=>({
    scope:path(kind,record.id)+suffix,foreign:path(kind,foreign.id)+suffix,original,
    screen:'/?'+new URLSearchParams({kind,record:record.id,workspaceId}),
    body:{id:randomUUID(),kind:'Call',occurredAt:at,summary:'Fictional editor activity on '+kind},
    links:{company_id:kind==='companies'?record.id:null,deal_id:kind==='deals'?record.id:null},
  }));
  const email='other@example.test';
  async function change(action){
    const response=await post('/api/workspaces',action);
    assert.equal(response.status,200);
    const current=(await response.json()).viewers.find(viewer=>viewer.email===email);
    if(current)sharing.grantId=current.id;
    return current;
  }
  const changeCurrent=(action,fields)=>change({action,id:sharing.grantId,...fields});
  const write=(scope,body,grantId=sharing.grantId)=>post(scope+'&grantId='+grantId,body,other);
  const originalGrant=(await (await read('/api/workspaces')).json()).viewers.find(viewer=>viewer.email===email);
  assert.equal(originalGrant.role,'editor');
  assert.equal(originalGrant.contactOutreach,true,'The existing Contact permission is active.');
  assert.equal(originalGrant.recordActivities,false,'Company and Deal activity sharing starts Off.');
  assert.equal((await post('/api/workspaces',{action:'record_activities',id:originalGrant.id,enabled:true},other)).status,404);
  for(const {scope,screen,body} of targets){
    assert.equal((await read(scope,other)).status,404);
    assert.equal((await write(scope,body)).status,403);
    const response=await read(screen,other);
    assert.equal(response.status,200);
    const unshared=await response.text();
    assert.doesNotMatch(unshared,/aria-label="Logged activities"/);
    assert.match(unshared,/aria-label="Activity access"/);
    assert.match(unshared,/>Company and deal activities</);
  }
  await changeCurrent('role',{role:'viewer'});
  const shared=await changeCurrent('record_activities',{enabled:true});
  assert.equal(shared.contactOutreach,true);
  assert.equal(shared.recordActivities,true);
  for(const {scope,screen,body,original} of targets){
    assert.deepEqual(await (await read(scope,other)).json(),original);
    const viewerPage=await (await read(screen,other)).text();
    assert.match(viewerPage,/aria-label="Logged activities"/);
    assert.doesNotMatch(viewerPage,/aria-label="Activity access"/);
    assert.doesNotMatch(viewerPage,/>Log activity</);
    assert.equal((await write(scope,body)).status,403);
  }
  const stale=sharing.grantId;
  await changeCurrent('role',{role:'editor'});
  const [{id:editorId}]=await sql`SELECT id FROM login_identities WHERE email=${email}`;
  for(const {scope,foreign,screen,body,links} of targets){
    assert.match(await (await read(screen,other)).text(),/>Log activity</);
    assert.equal((await write(scope,body,stale)).status,403);
    assert.equal((await read(foreign,other)).status,404);
    assert.equal((await write(foreign,body)).status,404);
    assert.equal((await write(scope,{...body,occurredAt:Date.now()+60_000})).status,400);
    assert.equal((await write(scope,body)).status,201);
    assert.equal((await write(scope,body)).status,200);
    assert.equal((await write(scope,{action:'remove',id:body.id,expectedRevision:2})).status,409);
    const page=await (await read(scope,other)).json();
    assert.deepEqual(page.items[0],{...body,revision:1});
    assert.equal(page.lastContacted,body.occurredAt);
    const [row]=await sql`SELECT actor_id,company_id,deal_id FROM portable_record_activities WHERE id=${body.id}`;
    assert.deepEqual(row,{actor_id:editorId,...links});
  }
  const revoked=sharing.grantId;
  await changeCurrent('revoke');
  for(const {scope,body} of targets){
    assert.equal((await read(scope,other)).status,404);
    assert.equal((await write(scope,body,revoked)).status,403);
  }
  const regranted=await change({action:'grant',email});
  assert.equal(regranted.recordActivities,false);
  await changeCurrent('role',{role:originalGrant.role});
  for(const [flag,action] of [['contactFiles','contact_files'],['scheduledNotes','scheduled_notes'],['contactOutreach','contact_outreach']]){
    if(originalGrant[flag])await changeCurrent(action,{enabled:true});
  }
}

export async function verifyRestoredRecordActivities({request,origin,owner,other,activities}){
  const {workspaceId,companyPath,companyPage,companyCall,dealPath,dealFirst,dealSecond,dealNote}=activities;
  for(const [url,page,receipt] of [[companyPath,companyPage,companyCall],[dealPath,dealFirst,dealNote]]){
    assert.deepEqual(await (await request(url,{headers:owner})).json(),page);
    assert.equal((await request(url,{headers:other})).status,404);
    assert.equal((await request(url+'&workspaceId='+workspaceId,{headers:other})).status,404);
    assert.equal((await log(request,origin,owner,url,receipt)).status,200);
    assert.deepEqual(await (await request(url,{headers:owner})).json(),page);
  }
  assert.deepEqual(await (await request(dealPath+cursor(dealFirst.next),{headers:owner})).json(),dealSecond);
}
