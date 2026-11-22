import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {checkStandalone} from '../scripts/check-standalone.mjs';
import {postgresReplyProxy} from './portable-hosting-fixture.mjs';

export async function verifyPortableIntake({request,origin,headers,other,sql,sharing,database,restartWithDatabase}){
  const id=randomUUID(),manager='/api/lead-forms',publicPage='/forms/'+id,endpoint='/api/public/forms/'+id;
  const inbox=manager+'?formId='+id,reviewInbox=inbox+'&filter=needs_review';
  const reviewPage='/?view=forms&formId='+id+'&filter=needs_review';
  const get=(path,auth={})=>request(path,{headers:auth});
  const post=(path,auth,body,site=origin)=>request(path,{method:'POST',headers:{
    ...auth,origin:site,'content-type':'application/json',
  },body:typeof body==='string'?body:JSON.stringify(body)});
  const action=(data,auth=headers)=>post(manager,auth,data);
  const list=async()=>await (await get(inbox,headers)).json();
  const settings={action:'save',id,revision:0,definition:{title:'Fictional intake',description:'Ask a question.',
    embedOrigin:'https://website.example.test',captureContacts:true,showMessageOnContact:true}};
  const attempt={id:randomUUID(),revision:2,payload:{name:'Trial prospect',email:'TRIAL-PROSPECT@example.test',message:'Fictional question'}};
  const send=(data=attempt,site=origin)=>post(endpoint,{},data,site);
  // Give this synthetic operator scenario its own request budget.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  assert.equal((await get(manager)).status,401);
  assert.equal((await action(settings)).status,200);
  assert.equal((await action(settings)).status,200);
  assert.equal((await action({...settings,definition:{...settings.definition,queueWorkflows:true}})).status,400);
  for(const embedOrigin of ['https://website.example.test/contact','https://user@website.example.test',
    'http://outside.example.test','https://example.test;frame-src','https://*.example.test']){
    assert.equal((await action({...settings,definition:{...settings.definition,embedOrigin}})).status,400);
  }
  const disabled=await get(publicPage);
  assert.equal(disabled.status,404);
  assert.match(disabled.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await send()).status,404);
  assert.equal((await get(inbox,other)).status,404);
  assert.equal((await action({action:'setEnabled',id,revision:1,enabled:true},other)).status,404);
  assert.equal((await action({action:'setEnabled',id,revision:1,enabled:true})).status,200);
  const page=await get(publicPage);
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors https:\/\/website\.example\.test/);
  assert.equal(page.headers.get('cache-control'),'no-store');
  const privatePage=await get('/?view=forms&formId='+id,headers);
  assert.match(privatePage.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const managerHtml=await privatePage.text();
  assert.match(managerHtml,/Embed on your website/);
  assert.match(managerHtml,/Show captured inquiry messages on the Contact timeline/);
  assert.ok(managerHtml.includes(origin+publicPage));
  assert.match(await page.text(),/Fictional intake/);
  const probeOrigin='https://harbor-probe.example.test';
  const checks=await checkStandalone(probeOrigin,(url,options)=>{
    const target=new URL(url);
    return request(target.pathname+target.search,options);
  },undefined,{portable:true,publicFormId:id,expectedEmbedOrigin:settings.definition.embedOrigin});
  assert.deepEqual(checks.find(check=>check.name.startsWith('Enabled public form')),
    {name:'Enabled public form renders with the expected framing policy',status:200,ok:true});
  assert.equal((await send(attempt,'https://outside.example.test')).status,403);
  assert.equal((await send('x'.repeat(33_000))).status,413);
  const superseded=await send({...attempt,revision:1});
  assert.equal(superseded.status,409);
  assert.equal((await superseded.json()).code,'superseded_form');
  const bot={...attempt,id:randomUUID(),website:'spam'};
  assert.deepEqual(await (await send(bot)).json(),{accepted:true});
  assert.deepEqual((await list()).results,[]);

  const second={...attempt,id:randomUUID(),payload:{...attempt.payload,name:'Another claim',
    email:'trial-prospect@example.test',message:'a'.repeat(4000)}};
  for(const response of await Promise.all([send(),send(),send(second)])){
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{accepted:true});
  }
  const saved=(await list()).results;
  assert.deepEqual(saved.map(row=>row.status).sort(),['created','linked']);
  assert.equal(new Set(saved.map(row=>row.contactId)).size,1);
  const openPath=inbox+'&filter=open',handledPath=inbox+'&filter=handled';
  const results=async path=>(await (await get(path,headers)).json()).results;
  const mark={action:'setInquiryHandled',formId:id,submissionId:attempt.id,handled:true,triageRevision:0};
  const reopen={...mark,handled:false,triageRevision:1};
  const openRow=(await results(openPath)).find(row=>row.id===attempt.id);
  assert.equal(openRow.handled,false);
  assert.equal((await action(mark,{})).status,401);
  assert.equal((await action(mark,other)).status,404);
  assert.equal((await action({...mark,formId:randomUUID()})).status,404);
  assert.equal((await action(mark)).status,200);
  assert.equal((await action(mark)).status,200);
  assert.deepEqual(await results(handledPath),[{...openRow,handled:true,triageRevision:1}]);
  assert.deepEqual((await results(openPath)).map(row=>row.id),[second.id]);
  const handledHtml=await (await get('/?view=forms&formId='+id+'&filter=handled',headers)).text();
  assert.match(handledHtml,/>Reopen<\/button>/);
  assert.equal((await action(reopen)).status,200);
  assert.equal((await action(mark)).status,409);
  assert.deepEqual((await results(openPath)).find(row=>row.id===attempt.id),{...openRow,triageRevision:2});
  const contactId=saved[0].contactId;
  const [history]=await sql`SELECT actor_id,intake_form_id FROM contact_events WHERE contact_id=${contactId}`;
  assert.deepEqual({...history},{actor_id:null,intake_form_id:id});
  const contact=await (await get('/api/crm?id='+contactId,headers)).json();
  assert.equal(contact.data.email,'trial-prospect@example.test');
  assert.equal(contact.data.name,saved.find(row=>row.status==='created').payload.name);
  assert.equal((await get('/?contact='+contactId,headers)).status,200);
  assert.equal((await get('/?contact='+contactId,other)).status,404);
  const activityPath='/api/logged-activities?contactId='+contactId;
  const timeline=async(path=activityPath)=>{
    const response=await get(path,headers);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  assert.equal((await get(activityPath)).status,401);
  assert.equal((await get(activityPath,other)).status,404);
  assert.equal((await get(activityPath+'&workspaceId='+randomUUID(),other)).status,404);
  const entries=await timeline();
  const sharedTimeline=await get(activityPath+'&workspaceId='+sharing.workspaceId,other);
  assert.equal(sharedTimeline.status,200);
  assert.deepEqual(await sharedTimeline.json(),entries);
  assert.equal(entries.items.length,2);
  assert.equal(entries.lastContacted,null);
  assert.equal(entries.lastActivity,entries.items[0].occurredAt);
  const fromFirst=entries.items.find(row=>row.summary===attempt.payload.message);
  const fromSecond=entries.items.find(row=>row.summary===second.payload.message);
  for(const row of [fromFirst,fromSecond]){
    assert.equal(row?.fromInquiry,true);
    assert.equal(row.kind,'Note');
    assert.equal((await post(activityPath,headers,{action:'remove',id:row.id,expectedRevision:row.revision})).status,404);
  }
  assert.equal((await post(activityPath,headers,{id:fromFirst.id,kind:'Note',
    occurredAt:fromFirst.occurredAt,summary:'Fictional conflicting activity ID'})).status,409);
  const manualIds=Array.from({length:25},()=>randomUUID());
  await sql`INSERT INTO portable_contact_activities(workspace_id,id,contact_id,actor_id,kind,occurred_at,recorded_at,summary)
    SELECT w.id,manual.id,${contactId},w.owner_id,'Note',${entries.lastActivity},${entries.lastActivity},'Fictional manual note'
    FROM private_workspaces w CROSS JOIN unnest(${manualIds}::uuid[]) AS manual(id) WHERE w.id=${sharing.workspaceId}`;
  try{
    const first=await timeline();
    assert.equal(first.items.length,25);
    const secondPage=await timeline(activityPath+'&'+new URLSearchParams({afterAt:String(first.next.at),afterId:first.next.id}));
    assert.equal(secondPage.next,null);
    assert.equal(secondPage.lastActivity,entries.lastActivity);
    const all=[...first.items,...secondPage.items];
    const expected=[...manualIds.map(id=>({id,occurredAt:entries.lastActivity})),...entries.items]
      .sort((a,b)=>b.occurredAt-a.occurredAt||(a.id<b.id?1:a.id>b.id?-1:0));
    assert.deepEqual(all.map(item=>item.id),expected.map(item=>item.id));
  }finally{
    await sql`DELETE FROM portable_contact_activities WHERE workspace_id=${sharing.workspaceId} AND id=ANY(${manualIds}::uuid[])`;
  }
  const changed={...attempt,payload:{...attempt.payload,message:'Changed replay'}};
  const conflictingReplay=await send(changed);
  assert.equal(conflictingReplay.status,409);
  assert.equal((await conflictingReplay.json()).code,undefined);
  const remove={action:'removeInquiry',formId:id,submissionId:attempt.id};
  assert.equal((await action(remove,other)).status,404);
  assert.equal((await action({...mark,triageRevision:2})).status,200);
  assert.equal((await action(remove)).status,200);
  assert.equal((await send(changed)).status,200);
  assert.equal((await list()).results.find(row=>row.id===attempt.id).payload,null);
  assert.equal((await action({...reopen,triageRevision:3})).status,404);
  assert.deepEqual(await results(handledPath),[]);
  assert.ok((await results(openPath)).every(row=>row.id!==attempt.id));
  assert.deepEqual((await timeline()).items,[fromSecond]);
  assert.equal((await get('/api/crm?id='+contactId,headers)).status,200);

  const duplicate=await post('/api/crm',headers,{action:'save',kind:'contacts',
    data:{name:'Duplicate fixture',email:attempt.payload.email}});
  assert.equal(duplicate.status,201);
  const {record}=await duplicate.json();
  const ambiguous={...attempt,id:randomUUID()};
  const heldResponse=await send(ambiguous);
  assert.equal(heldResponse.status,200);
  assert.deepEqual(await heldResponse.json(),{accepted:true});
  const ambiguousReceipt=()=>list().then(page=>page.results.find(row=>row.id===ambiguous.id));
  assert.equal((await ambiguousReceipt()).status,'needs_review');
  assert.equal((await ambiguousReceipt()).reviewReason,'duplicate_email');
  assert.match(await (await get(reviewPage,headers)).text(),/More than one Contact has this email/);
  await sql`UPDATE portable_lead_inquiries SET review_reason=NULL WHERE workspace_id=${sharing.workspaceId} AND id=${ambiguous.id}`;
  assert.match(await (await get(reviewPage,headers)).text(),/Retry contact matching to check this inquiry again/);
  assert.equal((await action({action:'retry',formId:id,submissionId:ambiguous.id})).status,200);
  assert.equal((await ambiguousReceipt()).reviewReason,'duplicate_email');
  assert.deepEqual((await (await get(reviewInbox,headers)).json()).results.map(row=>row.id),[ambiguous.id]);
  assert.deepEqual((await (await get(inbox+'&filter=unmatched',headers)).json()).results.map(row=>row.id),[ambiguous.id]);
  assert.equal((await get(reviewInbox)).status,401);
  assert.equal((await get(reviewInbox,other)).status,404);
  assert.equal((await get(reviewPage,other)).status,404);
  assert.equal((await get(manager+'?filter=needs_review',headers)).status,400);
  assert.equal((await get(inbox+'&filter=invalid',headers)).status,400);
  assert.equal((await post('/api/crm',headers,{action:'save',kind:'contacts',id:record.id,
    expectedRevision:record.revision,data:{...record.data,email:'different@example.test'}})).status,200);
  assert.equal((await action({action:'retry',formId:id,submissionId:ambiguous.id})).status,200);
  assert.equal((await ambiguousReceipt()).contactId,contactId);
  assert.equal((await ambiguousReceipt()).reviewReason,null);
  assert.deepEqual(await (await get(reviewInbox,headers)).json(),{results:[],next:null});
  assert.equal((await timeline()).items.filter(row=>row.summary===ambiguous.payload.message).length,1);

  const racing={...attempt,id:randomUUID()};
  let pending;
  await sql.begin(async tx=>{
    await tx`SELECT id FROM private_workspaces WHERE id=${sharing.workspaceId} FOR NO KEY UPDATE`;
    await tx`DELETE FROM portable_lead_form_activations WHERE form_id=${id}`;
    pending=send(racing);
    let waiting=false;
    for(let i=0;i<80&&!waiting;i++){
      const [row]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE '%from "private_workspaces"%for no key update%') AS waiting`;
      waiting=row.waiting;
      if(!waiting)await delay(25);
    }
    assert.ok(waiting,'Public submission should wait behind workspace settings.');
  });
  assert.equal((await pending).status,404);
  assert.equal((await list()).results.some(row=>row.id===racing.id),false);
  assert.equal((await action({action:'setEnabled',id,revision:2,enabled:true})).status,200);
  const quota=Array.from({length:27},()=>randomUUID());
  await sql`INSERT INTO portable_lead_inquiries(workspace_id,form_id,id,received_at,status)
    SELECT ${sharing.workspaceId},${id},id,${Date.now()},'removed' FROM unnest(${quota}::uuid[]) AS ids(id)`;
  assert.equal((await send(second)).status,200);
  assert.equal((await send({...attempt,id:randomUUID(),revision:3})).status,429);
  const first=await list();
  assert.equal(first.results.length,25);
  const rest=await (await get(inbox+'&afterAt='+first.next.at+'&afterId='+first.next.id,headers)).json();
  assert.equal(rest.results.length,5);
  assert.equal(rest.next,null);
  const heldIds=Array.from({length:26},()=>randomUUID()).sort().reverse();
  const heldAt=Date.UTC(2000,0,1),heldPayload={...attempt.payload,name:'Older 100%_ held inquiry'};
  const decoyId=randomUUID(),decoyPayload={...heldPayload,name:'Older 100AA held inquiry',message:'100%_ held'};
  const term='100%_ HeLD';
  const inquirySearch=value=>new URLSearchParams({inquirySearch:value}).toString();
  const byName=inquirySearch(term),paddedName=inquirySearch('  '+term+'  ');
  try{
    await sql`INSERT INTO portable_lead_inquiries(workspace_id,form_id,id,received_at,payload,status)
      SELECT ${sharing.workspaceId},${id},id,${heldAt},${sql.json(heldPayload)}::jsonb,'needs_review'
      FROM unnest(${heldIds}::uuid[]) AS ids(id)`;
    await sql`INSERT INTO portable_lead_inquiries(workspace_id,form_id,id,received_at,payload,status)
      VALUES (${sharing.workspaceId},${id},${decoyId},${heldAt+1},${sql.json(decoyPayload)},'needs_review')`;
    assert.ok((await list()).results.every(row=>row.status!=='needs_review'));
    const found=await get(reviewInbox+'&'+paddedName,headers);
    assert.equal(found.status,200,await found.clone().text());
    const held=await found.json();
    assert.deepEqual(held.results.map(row=>row.id),heldIds.slice(0,25));
    const cursor=new URLSearchParams({afterAt:String(held.next.at),afterId:held.next.id});
    const last=await (await get(reviewInbox+'&'+byName+'&'+cursor,headers)).json();
    assert.deepEqual(last.results.map(row=>row.id),heldIds.slice(25));
    assert.equal(last.next,null);
    assert.equal((await action({...mark,submissionId:heldIds[25]})).status,200);
    assert.deepEqual((await results(handledPath+'&'+byName)).map(row=>row.id),heldIds.slice(25));
    const firstReview=await get(reviewPage+'&'+paddedName,headers);
    assert.equal(firstReview.status,200);
    const html=await firstReview.text();
    assert.match(html,/<h3>Older 100%_ held inquiry<\/h3>/);
    assert.doesNotMatch(html,/<h3>Older 100AA held inquiry<\/h3>/);
    assert.match(html,/<input (?=[^>]*name="inquirySearch")(?=[^>]*value="100%_ HeLD")/);
    const nextLink=html.match(/href="([^"]+)"[^>]*>Older inquiries<\/a>/)?.[1]?.replaceAll('&amp;','&');
    assert.equal(nextLink,reviewPage+'&'+byName+'&'+cursor+'#form-inquiries');
    const latestLink=html.match(/href="([^"]+)"[^>]*>Latest inquiries<\/a>/)?.[1]?.replaceAll('&amp;','&');
    assert.equal(latestLink,reviewPage+'&'+byName+'#form-inquiries');
    const lastPage=await get(nextLink,headers);
    assert.equal(lastPage.status,200);
    assert.equal((await lastPage.text()).match(/<h3>Older 100%_ held inquiry<\/h3>/g)?.length,1);
    const signedOutSearch=await get(reviewPage+'&'+paddedName);
    assert.ok([302,303,307].includes(signedOutSearch.status));
    const returnTo=new URL(signedOutSearch.headers.get('location'),origin).searchParams.get('return_to');
    assert.deepEqual(Object.fromEntries(new URL(returnTo,origin).searchParams),
      {view:'forms',formId:id,filter:'needs_review',inquirySearch:term});
    assert.equal((await get(reviewInbox+'&'+byName,other)).status,404);
    for(const invalid of [byName+'&'+byName,inquirySearch('X'.repeat(121)),inquirySearch('bad\0value')]){
      assert.equal((await get(reviewInbox+'&'+invalid,headers)).status,400);
      assert.equal((await get(reviewPage+'&'+invalid,headers)).status,404);
    }
    for(const value of [byName,inquirySearch('')]){
      assert.equal((await get(manager+'?'+value,headers)).status,400);
      assert.equal((await get(manager+'?followUp=open&'+value,headers)).status,400);
      assert.equal((await get('/?view=forms&'+value,headers)).status,404);
      assert.equal((await get('/?view=job-queue&'+value,headers)).status,404);
    }
  }finally{
    await sql`DELETE FROM portable_lead_inquiries WHERE workspace_id=${sharing.workspaceId} AND form_id=${id}
      AND id=ANY(${[...heldIds,decoyId]}::uuid[])`;
  }
  const secondForm=randomUUID(),secondEndpoint='/api/public/forms/'+secondForm;
  const inboxOnly={...settings,id:secondForm,definition:{title:'Inbox review',embedOrigin:''}};
  assert.equal((await action(inboxOnly)).status,200);
  assert.equal((await action({action:'setEnabled',id:secondForm,revision:1,enabled:true})).status,200);
  // An older editor which omits the setting cannot turn capture on.
  assert.equal((await action({...inboxOnly,revision:2})).status,200);
  assert.match((await get('/forms/'+secondForm)).headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const listSecond=async()=>await (await get(manager+'?formId='+secondForm,headers)).json();
  const inquiry={...attempt,id:randomUUID(),revision:3,payload:{...attempt.payload,name:'Reviewed prospect',email:'review@example.test'}};
  const inboxPending={...inquiry,id:randomUUID(),payload:{...inquiry.payload,name:'Later claim'}};
  assert.equal((await post('/api/crm',other,{action:'save',kind:'contacts',
    data:{name:'Foreign workspace contact',email:inquiry.payload.email}})).status,201);
  for(const response of await Promise.all([post(secondEndpoint,{},inquiry),post(secondEndpoint,{},inquiry),post(secondEndpoint,{},inboxPending)])){
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{accepted:true});
  }
  const beforeCapture=(await listSecond()).results;
  assert.equal(beforeCapture.length,2);
  assert.ok(beforeCapture.every(row=>row.status==='inbox_only'&&row.contactId===null));
  const workspaceQueue=manager+'?inquiries=workspace',workspacePage='/?view=forms&inquiries=workspace';
  const queued=await results(workspaceQueue);
  assert.ok(queued.some(row=>row.formId===id&&row.formTitle===settings.definition.title));
  assert.ok(queued.some(row=>row.id===inquiry.id&&row.formId===secondForm&&row.formTitle==='Inbox review'));
  assert.deepEqual((await (await get(workspaceQueue,other)).json()).results,[]);
  assert.equal((await get(workspaceQueue)).status,401);
  assert.equal((await get(workspaceQueue+'&formId='+id,headers)).status,400);
  const workspaceHtml=await (await get(workspacePage,headers)).text();
  assert.match(workspaceHtml,/<h2 id="form-inquiries">Workspace inquiries<\/h2>/);
  assert.match(workspaceHtml,/>Refresh inquiries<\/button>/);
  assert.match(workspaceHtml,/<h3>Reviewed prospect<\/h3>/);
  assert.match(workspaceHtml,/>Mark handled<\/button>/);
  const overdueQueue=workspaceQueue+'&filter=overdue&'+inquirySearch('review@');
  const overduePage=workspacePage+'&filter=overdue&'+inquirySearch('review@');
  assert.ok(!(await results(overdueQueue)).some(row=>row.id===inquiry.id));
  const [{received_at:receivedAt}]=await sql`UPDATE portable_lead_inquiries SET received_at=
    received_at-86400000 WHERE workspace_id=${sharing.workspaceId} AND id=${inquiry.id} RETURNING received_at+86400000 AS received_at`;
  assert.ok((await results(overdueQueue)).some(row=>row.id===inquiry.id));
  assert.ok((await results(manager+'?formId='+secondForm+'&filter=overdue')).some(row=>row.id===inquiry.id));
  assert.ok(!(await results(manager+'?formId='+id+'&filter=overdue')).some(row=>row.id===inquiry.id));
  assert.deepEqual((await (await get(overdueQueue,other)).json()).results,[]);
  const overdueHtml=await (await get(overduePage,headers)).text();
  assert.match(overdueHtml,/<h3>Reviewed prospect<\/h3>/);
  assert.doesNotMatch(overdueHtml,/<h3>Later claim<\/h3>/);
  const moved=queued.find(row=>row.id===inquiry.id);
  const triage={action:'setInquiryHandled',formId:moved.formId,submissionId:moved.id,handled:true,triageRevision:moved.triageRevision};
  assert.equal((await action(triage)).status,200);
  assert.ok(!(await results(workspaceQueue)).some(row=>row.id===moved.id));
  assert.ok(!(await results(overdueQueue)).some(row=>row.id===moved.id));
  assert.ok((await results(workspaceQueue+'&filter=handled')).some(row=>row.id===moved.id));
  assert.equal((await action({...triage,handled:false,triageRevision:moved.triageRevision+1})).status,200);
  assert.ok((await results(overdueQueue)).some(row=>row.id===moved.id));
  await sql`UPDATE portable_lead_inquiries SET received_at=${receivedAt} WHERE workspace_id=${sharing.workspaceId} AND id=${inquiry.id}`;
  const tied=Array.from({length:26},()=>randomUUID()).sort().reverse(),tiedAt=Date.now()+60_000;
  await sql`INSERT INTO portable_lead_inquiries(workspace_id,id,form_id,received_at,payload,status)
    SELECT ${sharing.workspaceId},item.id,CASE WHEN item.n%2=0 THEN ${id}::uuid ELSE ${secondForm}::uuid END,${tiedAt},
      '{"name":"Fictional queue paging","email":"queue@example.test","phone":"","message":""}'::jsonb,'inbox_only'
    FROM unnest(${tied}::uuid[]) WITH ORDINALITY item(id,n)`;
  try{
    const byEmail=inquirySearch('QUEUE@exa');
    const first=await (await get(workspaceQueue+'&'+byEmail,headers)).json();
    assert.deepEqual(first.results.map(row=>row.id),tied.slice(0,25));
    const cursor=new URLSearchParams({afterAt:String(first.next.at),afterId:first.next.id});
    const older=await results(workspaceQueue+'&filter=open&'+byEmail+'&'+cursor);
    assert.deepEqual(older.map(row=>row.id),tied.slice(25));
    const paged=await (await get(workspacePage+'&filter=open&'+byEmail+'&'+cursor,headers)).text();
    assert.equal((paged.match(/<h3>Fictional queue paging<\/h3>/g)||[]).length,1);
    const isolated=await get(workspaceQueue+'&'+byEmail,other);
    assert.equal(isolated.status,200);
    assert.deepEqual(await isolated.json(),{results:[],next:null});
  }finally{
    await sql`DELETE FROM portable_lead_inquiries WHERE workspace_id=${sharing.workspaceId} AND id=ANY(${tied}::uuid[])`;
  }
  const unmatchedPath=manager+'?formId='+secondForm+'&filter=unmatched';
  const flags=async auth=>(await (await get(manager,auth)).json()).forms;
  const followUp=async auth=>(await (await get(manager+'?followUp=open',auth)).json()).forms;
  assert.equal((await flags(headers)).find(row=>row.id===secondForm).hasUnmatchedInquiries,true);
  assert.ok(!(await flags(other)).some(row=>row.id===secondForm));
  assert.equal((await get(unmatchedPath,other)).status,404);
  const listing=await (await get('/?view=forms',headers)).text();
  assert.match(listing,/Needs contact matching · Inbox review/);
  assert.match(listing,/Open inquiries · Inbox review/);
  const openShortcut='/?view=forms&formId='+secondForm+'&filter=open';
  assert.match(listing,new RegExp(openShortcut.replace('?','\\?').replaceAll('&','&amp;')+'#form-inquiries'));
  assert.ok((await followUp(headers)).some(row=>row.id===secondForm));
  assert.ok(!(await followUp(other)).some(row=>row.id===secondForm));
  assert.equal((await get(manager+'?formId='+secondForm+'&followUp=open',headers)).status,400);
  const filteredListing=await (await get('/?view=forms&followUp=open',headers)).text();
  assert.match(filteredListing,/aria-current="page">Needs follow-up/);
  assert.match(filteredListing,/Open inquiries · Inbox review/);
  const filteredShortcut=openShortcut+'&followUp=open';
  const signedOut=await get(filteredShortcut);
  assert.ok([302,303,307].includes(signedOut.status));
  assert.equal(new URL(signedOut.headers.get('location'),origin).searchParams.get('return_to'),filteredShortcut);
  const contactsForReview=()=>sql`SELECT id,data FROM contacts WHERE workspace_id=${sharing.workspaceId}
    AND lower(data->>'email')=${inquiry.payload.email}`;
  assert.deepEqual(Array.from(await contactsForReview()),[]);
  const capture={action:'retry',formId:secondForm,submissionId:inquiry.id};
  assert.equal((await action(capture,other)).status,404);
  const captureResponses=await Promise.all([action(capture),action(capture)]);
  const contactsAfter=await contactsForReview();
  assert.equal(contactsAfter.length,1);
  for(const response of captureResponses){
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,capturedContact:{id:contactsAfter[0].id,status:'created'}});
  }
  assert.equal(contactsAfter[0].data.name,inquiry.payload.name);
  assert.equal((await listSecond()).results.find(row=>row.id===inquiry.id).contactId,contactsAfter[0].id);
  assert.equal((await listSecond()).results.find(row=>row.id===inboxPending.id).status,'inbox_only');
  assert.deepEqual((await (await get(unmatchedPath,headers)).json()).results.map(row=>row.id),[inboxPending.id]);
  assert.deepEqual((await timeline('/api/logged-activities?contactId='+contactsAfter[0].id)).items,[]);
  assert.match(await (await get('/?view=forms&formId='+secondForm,headers)).text(),/Create or link contact/);
  for(const entry of (await listSecond()).results){
    assert.equal((await action({...mark,formId:secondForm,submissionId:entry.id,triageRevision:entry.triageRevision})).status,200);
  }
  const afterFollowUp=(await flags(headers)).find(row=>row.id===secondForm);
  assert.equal(afterFollowUp.hasUnmatchedInquiries,true);
  assert.equal(afterFollowUp.hasOpenInquiries,false);
  assert.ok(!(await followUp(headers)).some(row=>row.id===secondForm));
  assert.doesNotMatch(await (await get('/?view=forms&followUp=open',headers)).text(),/Inbox review/);
  assert.doesNotMatch(await (await get('/?view=forms',headers)).text(),/Open inquiries · Inbox review/);
  const reviewed=(await listSecond()).results.find(row=>row.id===inquiry.id);
  assert.equal((await action({...reopen,formId:secondForm,submissionId:inquiry.id,triageRevision:reviewed.triageRevision})).status,200);
  assert.equal((await flags(headers)).find(row=>row.id===secondForm).hasOpenInquiries,true);

  const legacy=randomUUID(),legacySettings={...inboxOnly,id:legacy};
  assert.equal((await action(legacySettings)).status,200);
  await sql`UPDATE portable_lead_forms SET definition=definition-'captureContacts' WHERE id=${legacy}`;
  assert.equal((await action({...legacySettings,revision:1})).status,200);
  assert.equal((await action({action:'setEnabled',id:legacy,revision:2,enabled:true})).status,200);
  const legacyInquiry={...inquiry,id:randomUUID(),payload:{...inquiry.payload,email:'legacy-form@example.test'}};
  assert.equal((await post('/api/public/forms/'+legacy,{},legacyInquiry)).status,200);
  const legacyInbox=await (await get(manager+'?formId='+legacy,headers)).json();
  assert.equal(legacyInbox.results[0].status,'created');
  assert.ok(legacyInbox.results[0].contactId);
  const daily=Array.from({length:70},()=>randomUUID());
  await sql`INSERT INTO portable_lead_inquiries(workspace_id,form_id,id,received_at,status)
    SELECT ${sharing.workspaceId},${id},id,${Date.now()},'removed' FROM unnest(${daily}::uuid[]) AS ids(id)`;
  try{
    assert.equal((await post(secondEndpoint,{}, {...attempt,id:randomUUID(),revision:3})).status,429);
  }finally{
    await sql`DELETE FROM portable_lead_inquiries WHERE form_id=${id} AND id=ANY(${daily}::uuid[])`;
  }
  const lostReply={...inquiry,id:randomUUID(),payload:{...inquiry.payload,email:'form-commit-proof@example.test'}};
  const commitToken=await post('/api/api-tokens',headers,{name:'Fictional commit test',objects:['inquiries'],permission:'read_write',days:30});
  assert.equal(commitToken.status,201,await commitToken.clone().text());
  const {token,info}=await commitToken.json();
  const webhook='/api/v1/forms/'+secondForm+'/inquiries';
  const tokenHeaders={authorization:'Bearer '+token};
  const lostWebhook={id:randomUUID(),payload:{...lostReply.payload,email:'webhook-commit-proof@example.test'}};
  const revokedWebhook={id:randomUUID(),payload:{...lostReply.payload,email:'revoked-commit-proof@example.test'}};
  await confirmLostInquiryReply({request,sql,database,restartWithDatabase,workspaceId:sharing.workspaceId,
    path:secondEndpoint,input:lostReply,headers:{origin},readInbox:listSecond});
  await confirmLostInquiryReply({request,sql,database,restartWithDatabase,workspaceId:sharing.workspaceId,
    path:webhook,input:lostWebhook,headers:tokenHeaders,readInbox:listSecond});
  await confirmLostInquiryReply({request,sql,database,restartWithDatabase,workspaceId:sharing.workspaceId,
    path:webhook,input:revokedWebhook,headers:tokenHeaders,readInbox:listSecond,afterCommit:async()=>{
      await sql`UPDATE portable_api_tokens SET revoked_at=${Date.now()} WHERE id=${info.id}`;
    }});
  assert.equal((await action({action:'setEnabled',id:secondForm,revision:3,enabled:false})).status,200);
  assert.equal((await followUp(headers)).find(row=>row.id===secondForm)?.enabled,false);
  assert.equal((await flags(headers)).find(row=>row.id===secondForm).hasOpenInquiries,true);
  assert.equal((await action({action:'setEnabled',id:legacy,revision:3,enabled:false})).status,200);

  const archiveForm=randomUUID(),archiveEmail=archiveForm+'@example.test',foreignEmail=archiveForm+'-foreign@example.test';
  const archiveEndpoint='/api/public/forms/'+archiveForm,archiveInbox=manager+'?formId='+archiveForm;
  const archiveSubmission={...attempt,id:randomUUID(),payload:{...attempt.payload,email:archiveEmail}};
  const retryArchive={action:'retry',formId:archiveForm,submissionId:archiveSubmission.id};
  const contactsFor=()=>sql`SELECT workspace_id,id,archived_at,data,revision FROM contacts
    WHERE lower(data->>'email') IN (${archiveEmail},${foreignEmail})`;
  const receipt=async()=>((await (await get(archiveInbox,headers)).json()).results.find(row=>row.id===archiveSubmission.id));
  const seed=async(auth,email)=>{
    const response=await post('/api/crm',auth,{action:'save',kind:'contacts',data:{name:'Fictional archive match',email}});
    assert.equal(response.status,201);
    return (await response.json()).record.id;
  };
  const counts=async(contactId)=>(await sql`SELECT
    (SELECT count(*)::int FROM contact_events WHERE workspace_id=${sharing.workspaceId} AND contact_id=${contactId}) AS revisions,
    (SELECT count(*)::int FROM contact_events WHERE workspace_id=${sharing.workspaceId} AND intake_form_id=${archiveForm}) AS creates,
    (SELECT count(*)::int FROM portable_contact_activities WHERE workspace_id=${sharing.workspaceId} AND contact_id=${contactId}) AS activities,
    (SELECT count(*)::int FROM portable_jobs WHERE workspace_id=${sharing.workspaceId} AND contact_id=${contactId}) AS jobs`)[0];
  try{
    assert.equal((await action({...settings,id:archiveForm})).status,200);
    assert.equal((await action({action:'setEnabled',id:archiveForm,revision:1,enabled:true})).status,200);
    const archivedId=await seed(headers,archiveEmail);
    const original=(await contactsFor()).find(row=>row.id===archivedId);
    const beforeEffects=await counts(archivedId);
    let queuedSubmission;
    await sql.begin(async tx=>{
      await tx`SELECT id FROM private_workspaces WHERE id=${sharing.workspaceId} FOR NO KEY UPDATE`;
      await tx`UPDATE contacts SET archived_at=now() WHERE workspace_id=${sharing.workspaceId} AND id=${archivedId}`;
      queuedSubmission=post(archiveEndpoint,{},archiveSubmission);
      let waiting=false;
      for(let i=0;i<80&&!waiting;i++){
        [{waiting}]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
          AND query LIKE '%from "private_workspaces"%for no key update%') AS waiting`;
        if(!waiting)await delay(25);
      }
      assert.ok(waiting,'Public submission should wait behind a Contact archive in its workspace.');
    });
    const accepted=await queuedSubmission;
    assert.equal(accepted.status,200);
    assert.deepEqual(await accepted.json(),{accepted:true});
    assert.equal((await post(archiveEndpoint,{},archiveSubmission)).status,200);
    const archivedReceipt=await receipt();
    assert.equal(archivedReceipt.status,'needs_review');
    assert.equal(archivedReceipt.reviewReason,'archived_contact');
    assert.match(await (await get('/?view=forms&formId='+archiveForm+'&filter=needs_review',headers)).text(),
      /A matching Contact is in the Recycle Bin/);
    assert.equal(archivedReceipt.contactId,null);
    assert.equal(archivedReceipt.payload.message,archiveSubmission.payload.message);
    assert.equal((await get(archiveInbox,other)).status,404);
    assert.equal((await action(retryArchive,other)).status,404);
    assert.equal((await action(retryArchive)).status,200);
    assert.deepEqual(await receipt(),archivedReceipt);
    const [archived]=await contactsFor();
    assert.ok(archived.archived_at);
    assert.deepEqual({...archived,archived_at:null},original);
    assert.equal((await contactsFor()).length,1,'An archived-only email must not create another Contact.');
    assert.deepEqual(await counts(archivedId),beforeEffects);
    const activeId=await seed(headers,archiveEmail);
    assert.equal((await action(retryArchive)).status,200);
    const linked={...archivedReceipt,status:'linked',contactId:activeId,reviewReason:null,contactAvailable:true};
    assert.deepEqual(await receipt(),linked);
    const inboxPage='/?view=forms&formId='+archiveForm;
    const openContact='href="/?contact='+activeId+'"';
    assert.ok((await (await get(inboxPage,headers)).text()).includes(openContact));
    const active=(await contactsFor()).find(row=>row.id===activeId);
    const archive=await post('/api/recycle-bin',headers,{action:'archive',id:activeId,
      expectedRevision:active.revision,requestId:randomUUID()});
    assert.equal(archive.status,200,await archive.clone().text());
    const archivedLink=await receipt();
    assert.deepEqual(archivedLink,{...linked,contactAvailable:false});
    assert.equal((await get('/?contact='+activeId,headers)).status,404);
    const archivedInbox=await (await get(inboxPage,headers)).text();
    assert.match(archivedInbox,/Linked Contact unavailable/);
    assert.ok(!archivedInbox.includes(openContact));
    const archivedRetry=await action(retryArchive);
    assert.equal(archivedRetry.status,200);
    assert.deepEqual(await archivedRetry.json(),{ok:true});
    assert.equal((await get(inboxPage,other)).status,404);
    const restored=await post('/api/recycle-bin',headers,{action:'restore',id:activeId,
      expectedRevision:(await archive.json()).receipt.revision,requestId:randomUUID()});
    assert.equal(restored.status,200,await restored.clone().text());
    assert.deepEqual(await receipt(),linked);
    assert.ok((await (await get(inboxPage,headers)).text()).includes(openContact));
    assert.equal((await get('/?contact='+activeId,headers)).status,200);
    assert.ok((await contactsFor()).find(row=>row.id===archivedId).archived_at);

    const foreignId=await seed(other,foreignEmail);
    await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id<>${sharing.workspaceId} AND id=${foreignId}`;
    const foreignOnly={...archiveSubmission,id:randomUUID(),payload:{...archiveSubmission.payload,email:foreignEmail}};
    assert.equal((await post(archiveEndpoint,{},foreignOnly)).status,200);
    const ownNew=(await contactsFor()).find(row=>row.workspace_id===sharing.workspaceId&&row.data.email===foreignEmail);
    assert.ok(ownNew&&ownNew.id!==foreignId&&ownNew.archived_at===null);
    const receipts=await (await get(archiveInbox,headers)).json();
    assert.equal(receipts.results.length,2);
    assert.equal(receipts.results.find(row=>row.id===foreignOnly.id).contactId,ownNew.id);
  }finally{
    const ids=(await contactsFor()).map(row=>row.id);
    await sql`DELETE FROM portable_lead_inquiries WHERE form_id=${archiveForm}`;
    await sql`DELETE FROM portable_contact_archive_receipts WHERE contact_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM contact_events WHERE contact_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM contacts WHERE id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM portable_lead_form_activations WHERE form_id=${archiveForm}`;
    await sql`DELETE FROM portable_lead_forms WHERE id=${archiveForm}`;
  }
  assert.equal((await action({...mark,submissionId:second.id})).status,200);
  sharing.handledInquiryId=second.id;
  sharing.intakeForm=id;
  sharing.inboxOnlyForm=secondForm;
  sharing.intakeCommitReceipts=[lostReply,lostWebhook,revokedWebhook].map(input=>({id:input.id,email:input.payload.email}));
  sharing.inquiryTimeline={contactId,path:activityPath,preserved:fromSecond,removedId:fromFirst.id};
}


async function confirmLostInquiryReply({request,sql,database,restartWithDatabase,workspaceId,path,input,headers,readInbox,afterCommit}){
  const gate=810683411;
  const proxy=await postgresReplyProxy(database);
  const send=()=>request(path,{method:'POST',headers:{...headers,'content-type':'application/json'},
    body:JSON.stringify(input),signal:AbortSignal.timeout(8000)});
  let response;
  try{
    await sql.unsafe(`CREATE FUNCTION harbor_test_inquiry_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER harbor_test_inquiry_commit_gate AFTER INSERT ON portable_lead_inquiries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.id = '${input.id}')
      EXECUTE FUNCTION harbor_test_inquiry_commit_gate()`).simple();
    await restartWithDatabase(proxy.url.href);
    await sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(${gate}::bigint)`;
      response=send();
      void response.catch(()=>{});
      let waiting=false;
      for(let i=0;i<80&&!waiting;i++){
        [{waiting}]=await tx`SELECT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND objid=${gate} AND NOT granted) AS waiting`;
        if(!waiting)await delay(25);
      }
      assert.ok(waiting,'The inquiry reached its commit gate.');
      proxy.block();
    });
    for(let i=0;i<80&&!proxy.stalled.size;i++)await delay(25);
    assert.equal(proxy.stalled.size,1,'The commit reply was dropped.');
    assert.equal((await sql`SELECT status FROM portable_lead_inquiries
      WHERE workspace_id=${workspaceId} AND id=${input.id}`)[0].status,'inbox_only');
    await afterCommit?.();
    proxy.unblock();
    for(const client of proxy.stalled)client.destroy();
    const confirmed=await response;
    assert.equal(confirmed.status,afterCommit?403:200,await confirmed.clone().text());
    if(!afterCommit)assert.deepEqual(await confirmed.json(),{accepted:true});
    const readReceipt=()=>readInbox().then(page=>page.results.filter(row=>row.id===input.id));
    const saved=await readReceipt();
    assert.equal(saved.length,1);
    assert.equal(saved[0].contactId,null);
    assert.equal((await send()).status,afterCommit?401:200);
    assert.deepEqual(await readReceipt(),saved);
  }finally{
    await proxy.close();
    await Promise.allSettled([response]);
    await sql.unsafe('DROP TRIGGER IF EXISTS harbor_test_inquiry_commit_gate ON portable_lead_inquiries; DROP FUNCTION IF EXISTS harbor_test_inquiry_commit_gate()').simple();
    await restartWithDatabase(database);
  }
}
