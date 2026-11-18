import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appendFile,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const owner='owner@example.test',address='receipt-fixture@example.test';
const participant='private-participant@second.example';
const receivedAt=new Date(1760000000000).toISOString();
const endpoint='/api/email/inbox';
const refresh='fictional-inbox-refresh';

export function portableInboxFixture(directory){
  const state=join(directory,'gmail-inbox-state.json'),log=join(directory,'gmail-inbox-calls.jsonl'),resume=join(directory,'gmail-inbox-resume');
  return {state,log,resume,env:{HARBOR_PORTABLE_INBOX_ENABLED:'true',HARBOR_PORTABLE_INBOX_OWNER:owner,
    HARBOR_PORTABLE_INBOX_CLIENT_ID:'fictional-inbox-client',HARBOR_PORTABLE_INBOX_CLIENT_SECRET:'fictional-inbox-secret',
    HARBOR_PORTABLE_INBOX_REFRESH_TOKEN:refresh,HARBOR_TEST_INBOX_STATE:state,HARBOR_TEST_INBOX_LOG:log,HARBOR_TEST_INBOX_RESUME:resume}};
}

export async function inboxFetch(url,options){
  const isRefresh=url.href==='https://oauth2.googleapis.com/token'&&options?.body?.get('refresh_token')===refresh;
  if(!isRefresh&&url.origin!=='https://gmail.googleapis.com')return undefined;
  const state=JSON.parse(await readFile(process.env.HARBOR_TEST_INBOX_STATE,'utf8'));
  const log=kind=>appendFile(process.env.HARBOR_TEST_INBOX_LOG,JSON.stringify({kind})+'\n');
  if(isRefresh){
    assert.equal(options.body.get('grant_type'),'refresh_token');
    assert.equal(options.body.get('client_id'),'fictional-inbox-client');
    await log('refresh');
    if(state.mode==='revoked')return Response.json({error:'invalid_grant',error_description:'PRIVATE_PROVIDER_FIXTURE'},{status:400});
    if(state.mode==='outage')return new Response(null,{status:503});
    const scope=state.mode==='missing_scope'?{scope:'https://www.googleapis.com/auth/gmail.send'}:{};
    return Response.json({access_token:'fictional-inbox-access',token_type:'Bearer',expires_in:3600,...scope});
  }
  assert.equal(options?.method??'GET','GET');
  assert.equal(new Headers(options.headers).get('authorization'),'Bearer fictional-inbox-access');
  if(url.pathname==='/gmail/v1/users/me/profile'){
    await log('profile');
    return Response.json({emailAddress:state.mode==='wrong_mailbox'?'another@example.test':owner});
  }
  if(url.pathname==='/gmail/v1/users/me/messages'){
    await log('list');
    if(state.mode==='denied')return Response.json({}, {status:403});
    assert.equal(url.searchParams.get('maxResults'),'10');
    assert.equal(url.searchParams.get('includeSpamTrash'),'false');
    assert.match(url.searchParams.get('q'),/from:"receipt-fixture@example\.test"/);
    assert.ok(url.searchParams.get('q').includes('subject:"Follow-up"'));
    if(state.hosted)return Response.json({messages:[{id:'fresh',threadId:'thread-fresh'}]});
    const entries=['valid','spoof','sent','wrong-thread','ambiguous','valid'];
    if(url.searchParams.get('pageToken')==='inbox-next')return Response.json({messages:[{id:'second',threadId:'thread-second'}]});
    assert.equal(url.searchParams.has('pageToken'),false);
    if(state.mode==='race'){
      for(let i=0;i<180;i++){
        if(await readFile(process.env.HARBOR_TEST_INBOX_RESUME,'utf8').catch(()=>null)==='resume')break;
        await delay(10);
      }
    }
    return Response.json({messages:entries.map(id=>({id,threadId:'thread-'+id})),nextPageToken:'inbox-next'});
  }
  const match=/^\/gmail\/v1\/users\/me\/messages\/([a-z-]+)$/.exec(url.pathname);
  assert.ok(match,'Only read-only inbox calls are allowed in this fixture.');
  const [,id]=match;
  const format=url.searchParams.get('format');
  const names=url.searchParams.getAll('metadataHeaders');
  const preview=format==='full'||names.includes('To');
  await log(format==='full'?'full':preview?'preview_headers':'headers');
  if(format==='full'){
    assert.equal(url.searchParams.get('fields'),'id,threadId,internalDate,labelIds,payload');
    assert.deepEqual(names,[]);
    if(state.mode==='body_race'){
      for(let i=0;i<180;i++){
        if(await readFile(process.env.HARBOR_TEST_INBOX_RESUME,'utf8').catch(()=>null)==='resume')break;
        await delay(10);
      }
    }
  }else{
    assert.equal(format,'metadata');
    assert.deepEqual(names,preview?['From','Subject','To','Cc']:['From','Subject']);
  }
  const from={name:'From',value:'Fictional Sender <'+(id==='spoof'?'spoof@example.test':address)+'>'};
  const subject={name:'Subject',value:'Fictional '+id};
  const participantHeaders=preview?[{name:'To',value:owner},{name:'Cc',value:participant}]:[];
  const headers=[from,subject,...participantHeaders,...(id==='ambiguous'?[subject]:[])];
  const body=state.mode==='large'?'x'.repeat(10_001):
    '<p>Hello &amp; goodbye</p><script>script contents</script><img src="https://tracker.invalid/pixel">';
  return Response.json({id,threadId:id==='wrong-thread'||(format==='full'&&state.mode==='wrong_body')?'unexpected':'thread-'+id,
    internalDate:preview&&state.mode==='wrong_preview_date'?'1760000000001':'1760000000000',
    labelIds:id==='sent'?['SENT']:['INBOX'],payload:{headers,...(format==='full'?{
      mimeType:state.mode==='large'?'text/plain':'text/html',
      body:state.mode==='separate_body'?{attachmentId:'never-fetch'}:{data:Buffer.from(body).toString('base64url')},
    }:{})}});
}

export async function verifyPortableInbox({request,origin,headers,other,sql,workspaceId,contactId,foreignContactId,missingContactId,inbox}){
  const lookup=(recordId,after,auth=headers,subject='Follow-up',site=origin)=>request(endpoint,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify({recordId,subject,...(after?{after}:{})})});
  const preview=(recordId,selection,auth=headers)=>request(endpoint,{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify({recordId,preview:selection})});
  const log=(recordId,selection,auth=headers,site=origin)=>request(endpoint,{method:'PUT',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify({recordId,selection})});
  const rulesPath='/api/email/never-log';
  const ruleRequest=(method,body,auth=headers,site=origin)=>request(rulesPath,{method,
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const listRules=async(query='',auth=headers)=>(await request(rulesPath+query,{headers:auth})).json();
  const addRule=async(value,auth=headers,id=randomUUID())=>{
    const response=await ruleRequest('POST',{id,value},auth);
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const removeRule=async(rule,auth=headers)=>assert.equal((await ruleRequest('DELETE',{id:rule.id},auth)).status,200);
  const denied={items:[],next:null,unavailable:0,blocked:true};
  const mode=value=>writeFile(inbox.state,JSON.stringify({mode:value}));
  const calls=async()=>String(await readFile(inbox.log)).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).kind);
  const counts=async()=>(await sql`SELECT (SELECT count(*) FROM portable_jobs)::int AS jobs,
    (SELECT count(*) FROM portable_contact_activities)::int AS activities`)[0];
  await writeFile(inbox.log,'');
  await mode('normal');
  const resetBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await resetBudgets();
  const before=await counts();
  assert.equal((await lookup(contactId,undefined,{})).status,401);
  assert.equal((await lookup(contactId,undefined,headers,'Follow-up','https://outside.example.test')).status,403);
  assert.equal((await lookup(contactId,undefined,other)).status,403);
  assert.equal((await lookup(foreignContactId)).status,404);
  assert.equal((await lookup(missingContactId)).status,400);
  assert.equal((await lookup(contactId,undefined,headers,'Line\nBreak')).status,400);
  assert.equal((await request(endpoint,{headers})).status,404);
  assert.deepEqual(await calls(),[]);

  assert.equal((await request(rulesPath)).status,401);
  assert.equal((await ruleRequest('POST',{id:randomUUID(),value:address},headers,'https://outside.example.test')).status,403);
  assert.equal((await ruleRequest('POST',{id:randomUUID(),value:'*.example.test'})).status,400);
  const exactRule=await addRule(address.toUpperCase());
  assert.equal(exactRule.value,address);
  assert.deepEqual(await addRule(address),exactRule);
  assert.equal((await ruleRequest('POST',{id:exactRule.id,value:'different@example.test'})).status,409);
  assert.deepEqual(await listRules('?query=receipt'),{results:[exactRule],total:1,next:null});
  assert.deepEqual(await listRules('?query=%25'),{results:[],total:0,next:null});
  assert.deepEqual(await listRules('',other),{results:[],total:0,next:null});
  await removeRule(exactRule,other);
  assert.deepEqual(await listRules(),{results:[exactRule],total:1,next:null});
  assert.deepEqual(await (await lookup(contactId)).json(),denied);
  assert.deepEqual(await calls(),[]);
  await removeRule(exactRule);
  const domainRule=await addRule('@EXAMPLE.TEST');
  assert.equal(domainRule.value,'*@example.test');
  assert.deepEqual(await (await lookup(contactId)).json(),denied);
  assert.deepEqual(await calls(),[]);
  await removeRule(domainRule);
  const otherRule=await addRule(address,other);
  const keptRule=await addRule('sales.example.test');

  const ids=Array.from({length:26},()=>randomUUID());
  await sql`INSERT INTO portable_never_log_rules(workspace_id,id,value,created_at)
    SELECT ${workspaceId},id,id||'@test.example',now() FROM unnest(${ids}::uuid[]) AS v(id)`;
  try{
    const first=await listRules();
    assert.equal(first.total,27);
    assert.equal(first.results.length,25);
    assert.equal(first.next,25);
    const second=await listRules('?offset=25');
    assert.equal(second.results.length,2);
    assert.equal(second.next,null);
    assert.deepEqual(await listRules('',other),{results:[otherRule],total:1,next:null});
  }finally{
    await sql`DELETE FROM portable_never_log_rules WHERE workspace_id=${workspaceId} AND id=ANY(${ids}::uuid[])`;
  }

  const page=await lookup(contactId);
  assert.equal(page.status,200,await page.clone().text());
  assert.equal(page.headers.get('cache-control'),'private, no-store');
  const {items,next,unavailable}=await page.json();
  assert.equal(items.length,1);
  const {selection,...header}=items[0];
  assert.deepEqual(header,{id:'valid',sender:'Fictional Sender <'+address+'>',subject:'Fictional valid',
    receivedAt,url:'https://mail.google.com/mail/u/?authuser=owner%40example.test#all/valid'});
  assert.deepEqual(selection,{id:'valid',threadId:'thread-valid',receivedAt,proof:selection.proof});
  assert.match(selection.proof,/^[a-zA-Z0-9_-]{43}$/);
  assert.equal(unavailable,5);
  assert.ok(next?.proof);
  const seen=await calls();
  assert.deepEqual(seen,['refresh','profile','list','headers','headers','headers','headers','headers']);
  assert.equal((await lookup(contactId,next,headers,'Another search')).status,409);
  assert.equal((await lookup(contactId,{...next,token:'tampered'})).status,409);
  assert.deepEqual(await calls(),seen);
  assert.equal((await preview(contactId,{...selection,id:'arbitrary'})).status,409);
  assert.equal((await preview(contactId,{...selection,proof:next.proof})).status,409);
  assert.equal((await preview(foreignContactId,selection)).status,404);
  assert.equal((await preview(contactId,selection,other)).status,403);
  assert.deepEqual(await calls(),seen);
  const displayed=await preview(contactId,selection);
  assert.equal(displayed.status,200,await displayed.clone().text());
  assert.equal(displayed.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await displayed.json(),{body:'Hello & goodbye',truncated:false});
  assert.deepEqual((await calls()).slice(seen.length),['refresh','profile','preview_headers','full']);

  await mode('revoked');
  const revokedStart=(await calls()).length;
  const beforeRejectedLog=await counts();
  for(const action of [()=>lookup(contactId),()=>preview(contactId,selection),()=>log(contactId,selection)]){
    const failure=await action();
    assert.equal(failure.status,409);
    assert.equal(failure.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(await failure.json(),{code:'mailbox_authorization',
      error:'The configured Gmail inbox needs authorization. Ask your Harbor administrator to reauthorize the mailbox.'});
  }
  assert.deepEqual(await counts(),beforeRejectedLog);
  assert.deepEqual((await calls()).slice(revokedStart),['refresh','refresh','refresh']);
  await mode('outage');
  const outage=await preview(contactId,selection);
  assert.equal(outage.status,503);
  assert.equal((await outage.json()).code,undefined);
  await mode('normal');
  assert.equal((await preview(contactId,selection)).status,200);

  const participantRule=await addRule('second.example');
  try{
    const start=(await calls()).length;
    const excluded=await preview(contactId,selection);
    assert.equal(excluded.status,409);
    assert.equal((await excluded.json()).code,'never_log');
    assert.deepEqual((await calls()).slice(start),['refresh','profile','preview_headers']);
  }finally{await removeRule(participantRule);}
  await mode('wrong_preview_date');
  const metadataStart=(await calls()).length;
  assert.equal((await preview(contactId,selection)).status,409);
  assert.deepEqual((await calls()).slice(metadataStart),['refresh','profile','preview_headers']);
  await mode('wrong_body');
  assert.equal((await preview(contactId,selection)).status,409);
  await mode('separate_body');
  assert.equal((await preview(contactId,selection)).status,422);
  await mode('large');
  assert.deepEqual(await (await preview(contactId,selection)).json(),{body:'x'.repeat(10_000),truncated:true});
  await mode('body_race');
  await writeFile(inbox.resume,'');
  const bodyStart=(await calls()).length;
  const pendingBody=preview(contactId,selection);
  for(let i=0;i<100;i++){
    if((await calls()).slice(bodyStart).includes('full'))break;
    await delay(10);
  }
  assert.ok((await calls()).slice(bodyStart).includes('full'));
  const concurrentRule=await addRule(participant);
  try{
    await writeFile(inbox.resume,'resume');
    assert.equal((await pendingBody).status,409);
  }finally{await removeRule(concurrentRule);}
  await writeFile(inbox.resume,'');
  await mode('normal');
  const second=await (await lookup(contactId,next)).json();
  assert.equal(second.items[0].id,'second');
  assert.equal(second.next,null);
  const pageHtml=await (await request('/?contact='+contactId,{headers})).text();
  assert.match(pageHtml,/Find received email/);
  assert.doesNotMatch(pageHtml,/Schedule Gmail email/);

  await mode('wrong_mailbox');
  const wrongMailbox=await lookup(contactId);
  assert.equal(wrongMailbox.status,409);
  assert.equal((await wrongMailbox.json()).code,'mailbox_authorization');
  await mode('missing_scope');
  const beforeScopeCheck=await calls();
  assert.equal((await lookup(contactId)).status,409);
  assert.deepEqual((await calls()).slice(beforeScopeCheck.length),['refresh']);
  await mode('denied');
  assert.equal((await lookup(contactId)).status,503);
  await mode('race');
  const offset=(await calls()).length;
  const pending=lookup(contactId);
  for(let i=0;i<100;i++){
    if((await calls()).slice(offset).includes('list'))break;
    await delay(10);
  }
  assert.ok((await calls()).slice(offset).includes('list'));
  await sql`UPDATE contacts SET archived_at=now() WHERE id=${contactId}`;
  try{
    await writeFile(inbox.resume,'resume');
    assert.equal((await pending).status,409);
    assert.equal((await lookup(contactId)).status,404);
  }finally{await sql`UPDATE contacts SET archived_at=NULL WHERE id=${contactId}`;}
  await writeFile(inbox.resume,'');
  const ruleRaceOffset=(await calls()).length;
  const ruleRace=lookup(contactId);
  for(let i=0;i<100;i++){
    if((await calls()).slice(ruleRaceOffset).includes('list'))break;
    await delay(10);
  }
  assert.ok((await calls()).slice(ruleRaceOffset).includes('list'));
  const addedDuringRead=await addRule(address);
  try{
    await writeFile(inbox.resume,'resume');
    assert.deepEqual(await (await ruleRace).json(),denied);
    const blockedCalls=await calls();
    assert.deepEqual(await (await lookup(contactId,next)).json(),denied);
    assert.deepEqual(await calls(),blockedCalls);
  }finally{await removeRule(addedDuringRead);}
  await mode('normal');
  assert.equal((await lookup(contactId)).status,200);
  assert.deepEqual(await counts(),before);

  const timeline='/api/logged-activities?contactId='+contactId;
  const readTimeline=async()=>(await request(timeline,{headers})).json();
  const updateTimeline=(body)=>request(timeline,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify(body)});
  const priorTimeline=await readTimeline();
  const noAccessCalls=await calls();
  assert.equal((await log(contactId,selection,{})).status,401);
  assert.equal((await log(contactId,selection,other)).status,403);
  assert.equal((await log(contactId,selection,headers,'https://outside.example.test')).status,403);
  assert.equal((await log(contactId,{...selection,id:'arbitrary'})).status,409);
  assert.deepEqual(await calls(),noAccessCalls);

  await mode('body_race');
  await writeFile(inbox.resume,'');
  const logRaceStart=(await calls()).length;
  const pendingLog=log(contactId,selection);
  for(let i=0;i<100;i++){
    if((await calls()).slice(logRaceStart).includes('full'))break;
    await delay(10);
  }
  assert.ok((await calls()).slice(logRaceStart).includes('full'));
  const blockLog=await addRule(participant);
  try{
    await writeFile(inbox.resume,'resume');
    const response=await pendingLog;
    assert.equal(response.status,409);
    assert.equal((await response.json()).code,'never_log');
    assert.deepEqual(await counts(),before);
  }finally{await removeRule(blockLog);}
  await mode('normal');

  const concurrent=await Promise.all([log(contactId,selection),log(contactId,selection)]);
  for(const response of concurrent)assert.equal(response.status,200,await response.clone().text());
  const responses=await Promise.all(concurrent.map(response=>response.json()));
  assert.deepEqual(responses.map(response=>response.alreadyLogged).sort(),[false,true]);
  const activityId=responses[0].activityId;
  assert.ok(activityId);
  assert.deepEqual(responses.map(response=>[response.logged,response.activityId]),[[true,activityId],[true,activityId]]);
  const afterSave=await calls();
  assert.deepEqual(await (await log(contactId,selection)).json(),{logged:true,alreadyLogged:true,activityId});
  assert.deepEqual(await calls(),afterSave);
  const updatedTimeline=await readTimeline();
  const message=updatedTimeline.items.find(item=>item.id===activityId);
  assert.deepEqual(message,{id:activityId,revision:1,kind:'Email',occurredAt:Date.parse(receivedAt),fromGmail:true,
    summary:'From: Fictional Sender <'+address+'>\nSubject: Fictional valid\n\nHello & goodbye'});
  assert.equal(updatedTimeline.lastContacted,Math.max(priorTimeline.lastContacted??0,Date.parse(receivedAt)));
  const editedSummary='Received email note. '+('é'.repeat(3000));
  assert.equal((await updateTimeline({action:'update',id:activityId,expectedRevision:1,
    occurredAt:Date.parse(receivedAt),summary:editedSummary})).status,200);
  const active=(await readTimeline()).items.find(item=>item.id===activityId);
  assert.equal(active.summary,editedSummary);
  assert.equal(active.fromGmail,true);
  const savedSearch=await (await lookup(contactId)).json();
  assert.equal(savedSearch.items[0].logged,true);
  assert.equal(savedSearch.items[0].activityId,undefined);

  const duplicateContact=randomUUID();
  await sql`INSERT INTO contacts (workspace_id,id,revision,data,created_at,updated_at)
    SELECT workspace_id,${duplicateContact},1,data,now(),now() FROM contacts WHERE workspace_id=${workspaceId} AND id=${contactId}`;
  try{
    const duplicatePage=await (await lookup(duplicateContact)).json();
    assert.equal(duplicatePage.items[0].logged,true);
    const beforeDuplicate=await calls();
    assert.equal((await log(duplicateContact,duplicatePage.items[0].selection)).status,409);
    assert.deepEqual(await calls(),beforeDuplicate);
  }finally{await sql`DELETE FROM contacts WHERE workspace_id=${workspaceId} AND id=${duplicateContact}`;}

  const secondSelection=second.items[0].selection;
  const removed=await (await log(contactId,secondSelection)).json();
  assert.equal(removed.alreadyLogged,false);
  assert.equal((await updateTimeline({action:'remove',id:removed.activityId,expectedRevision:1})).status,200);
  const afterRemoval=await calls();
  assert.deepEqual(await (await log(contactId,secondSelection)).json(),{logged:true,alreadyLogged:true,activityId:null});
  assert.deepEqual(await calls(),afterRemoval);
  assert.deepEqual(await counts(),{jobs:before.jobs,activities:before.activities+1});
  await resetBudgets();
  return {owner:keptRule,other:otherRule,contactId,active,selection,secondSelection,inbox};
}


export async function verifyHostedPortableInbox({proxy,origin,headers,signIn,sql,contactId,inbox}){
  const post=(method,input,auth=headers,site=origin)=>proxy(endpoint,{method,
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify({recordId:contactId,...input})});
  const lookup=auth=>post('POST',{subject:'Follow-up'},auth);
  const preview=(selection,auth)=>post('POST',{preview:selection},auth);
  const log=(selection,auth)=>post('PUT',{selection},auth);
  const mode=value=>writeFile(inbox.state,JSON.stringify({mode:value,hosted:true}));
  const calls=async()=>(await readFile(inbox.log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).kind);
  const activityCount=async()=>(await sql`SELECT count(*)::int AS total FROM portable_contact_activities WHERE contact_id=${contactId}`)[0].total;
  const lookupSelection=async auth=>{
    const response=await lookup(auth);
    assert.equal(response.status,200,await response.clone().text());
    const {items}=await response.json();
    assert.deepEqual(items.map(item=>item.id),['fresh']);
    return items[0].selection;
  };
  await writeFile(inbox.log,'');
  await mode('normal');
  assert.equal((await lookup({})).status,401);
  const otherSession=await signIn('other@example.test',proxy,origin);
  assert.equal((await lookup(otherSession)).status,403);
  assert.equal((await post('POST',{subject:'Follow-up'},headers,'https://outside.example.test')).status,403);
  assert.deepEqual(await calls(),[]);
  const html=await (await proxy('/?contact='+contactId,{headers})).text();
  assert.match(html,/Find received email/);
  const inboxCheck=(auth=headers,site=origin)=>proxy(endpoint,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify({action:'check_connection'})});
  const settings='/?view=email-settings';
  assert.match(await (await proxy(settings,{headers})).text(),/Check Gmail inbox connection/);
  assert.doesNotMatch(await (await proxy(settings,{headers:otherSession})).text(),/Check Gmail inbox connection/);
  assert.equal((await inboxCheck(otherSession)).status,403);
  assert.equal((await proxy('/auth/logout',{method:'POST',headers:{...otherSession,origin},
    body:new URLSearchParams({scope:'current'})})).status,303);
  assert.equal((await inboxCheck({})).status,401);
  assert.equal((await inboxCheck(headers,'https://outside.example.test')).status,403);
  assert.deepEqual(await calls(),[]);
  const activityBeforeCheck=await activityCount();
  for(const [providerMode,status,expectedCalls] of [
    ['normal',200,['refresh','profile']],['revoked',409,['refresh']],
    ['wrong_mailbox',409,['refresh','profile']],['missing_scope',409,['refresh']],
    ['outage',503,['refresh']],['normal',200,['refresh','profile']],
  ]){
    await mode(providerMode);
    const offset=(await calls()).length;
    const response=await inboxCheck();
    assert.equal(response.status,status);
    assert.match(response.headers.get('cache-control'),/no-store/);
    const body=await response.json();
    if(status===200)assert.deepEqual(body,{connection:'ok'});
    if(status===409)assert.equal(body.code,'mailbox_authorization');
    assert.doesNotMatch(JSON.stringify(body),/fictional-inbox|PRIVATE_PROVIDER_FIXTURE|another@example.test/);
    assert.deepEqual((await calls()).slice(offset),expectedCalls);
  }
  assert.equal(await activityCount(),activityBeforeCheck);
  await writeFile(inbox.log,'');
  const selected=await lookupSelection(headers);
  const shown=await preview(selected,headers);
  assert.equal(shown.status,200);
  assert.match(shown.headers.get('cache-control'),/no-store/);
  assert.deepEqual(await shown.json(),{body:'Hello & goodbye',truncated:false});
  const before=await activityCount();

  for(const operation of [preview,log]){
    const guestSession=await signIn(owner,proxy,origin);
    const initial=await calls();
    assert.equal((await preview(selected,guestSession)).status,409);
    assert.deepEqual(await calls(),initial);
    const ownSelection=await lookupSelection(guestSession);
    await mode('body_race');
    await writeFile(inbox.resume,'');
    const offset=(await calls()).length;
    const pending=operation(ownSelection,guestSession);
    try{
      for(let tries=0;tries<100&&!(await calls()).slice(offset).includes('full');tries++)await delay(10);
      assert.ok((await calls()).slice(offset).includes('full'));
      const logout=await proxy('/auth/logout',{method:'POST',headers:{...guestSession,origin},
        body:new URLSearchParams({scope:'current'})});
      assert.equal(logout.status,303);
    }finally{await writeFile(inbox.resume,'resume');}
    const denied=await pending;
    assert.equal(denied.status,401);
    assert.deepEqual(Object.keys(await denied.json()),['error']);
    assert.equal(await activityCount(),before);
    assert.equal((await sql`SELECT activity_id FROM portable_gmail_log_receipts WHERE message_id='fresh'`).length,0);
    await mode('normal');
  }
  const saved=await log(selected,headers);
  assert.equal(saved.status,200,await saved.clone().text());
  assert.equal((await saved.json()).logged,true);
  assert.equal(await activityCount(),before+1);
}
