import assert from 'node:assert/strict';
import {outlookClient} from './portable-outlook-connection-fixture.mjs';
import {completeAssignedOutreach,logOutlookSequenceReply,reviewUncertainEnrollment} from './portable-sales-sequence-browser.mjs';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import postgres from 'postgres';
import {CreateBucketCommand,DeleteBucketCommand} from '@aws-sdk/client-s3';
import {localFileFixture} from './portable-files-fixture.mjs';

const execute=promisify(execFile);
export async function verifyPortableSalesSequences({request,origin,headers,other,sql,env,directory}){
  const api='/api/sequences';
  async function post(path,body,auth=headers){
    return request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  }
  async function ok(result){
    const response=await result;
    assert.ok(response.ok,await response.clone().text());
    return response.json();
  }
  const get=(path,auth=headers)=>ok(request(path,{headers:auth}));
  const send=(path,body,auth)=>ok(post(path,body,auth));
  assert.equal((await request(api)).status,401);
  const library=await get(api);
  assert.equal(library.readiness.sender,'owner@example.test');
  assert.equal((await get(api,other)).readiness.sender,null);
  const profile='https://www.linkedin.com/in/harbor-fictional-river';
  const {record:contact}=await send('/api/crm',{action:'save',kind:'contacts',data:{name:'River Example',email:'river@example.test',linkedinUrl:profile}});
  const {owned:workspaceId,viewers}=await send('/api/workspaces',{action:'grant',email:'other@example.test'});
  await send('/api/workspaces',{action:'role',id:viewers.find(m=>m.email==='other@example.test').id,role:'editor'});
  const [assignee]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const id=randomUUID();
  const step=(type,fields)=>({id:randomUUID(),type,delayDays:0,...fields});
  const steps=[step('email',{subject:'Introduction',body:'Fictional introduction.'}),
    step('task',{taskType:'LinkedIn',title:'Follow up personally',notes:'Review the fictional inquiry.',timing:{dueAfterMinutes:15,reminderMinutes:15}}),
    step('email',{subject:'Following up',body:'Fictional follow-up.'})];
  const draft={action:'save',id,expectedRevision:0,name:'Three-touch follow-up',steps};
  const {sequence}=await send(api,draft);
  assert.equal(sequence.revision,1);
  const enrollment={action:'enroll',id:randomUUID(),sequenceId:id,expectedRevision:1,contactId:contact.id,
    assigneeId:assignee.id,recipient:contact.data.email};
  async function taskScope(editScope){
    const grants=await get('/api/workspaces');
    const grant=grants.viewers.find(viewer=>viewer.email==='other@example.test');
    await send('/api/workspaces',{action:'record_scope',id:grant.id,viewScope:editScope,editScope});
  }
  await taskScope('owned');
  assert.ok(!(await get(api+'?view=assignees')).items.some(item=>item.id===assignee.id));
  assert.equal((await post(api,enrollment)).status,409);
  const picker=api+'?view=assignees&contactId='+contact.id;
  assert.ok(!(await get(picker)).items.some(item=>item.id===assignee.id));
  assert.equal((await request(picker,{headers:other})).status,404);
  await send('/api/crm',{action:'assignOwners',kind:'contacts',assigneeId:assignee.id,
    records:[{id:contact.id,expectedRevision:contact.revision}]});
  assert.ok((await get(picker)).items.some(item=>item.id===assignee.id));
  async function taskEdit(edit){
    const grant=(await get('/api/workspaces')).viewers.find(viewer=>viewer.email==='other@example.test');
    await send('/api/workspaces',{action:'tool_permissions',ids:[grant.id],tool:'tasks',policy:{view:'owned',edit,create:true,delete:false}});
  }
  const manual={action:'save',kind:'tasks',assigneeId:assignee.id,data:{name:'Renew fictional agreement',dueDate:'2040-11-20',
    repeat:{every:1,unit:'days',timeZone:'UTC'}}};
  const {record:assigned}=await send('/api/crm',manual);
  await taskEdit('none');
  assert.ok(!(await get(picker)).items.some(row=>row.id===assignee.id));
  assert.ok((await get(picker+'&emailOnly=true')).items.some(row=>row.id===assignee.id));
  assert.equal((await post(api,enrollment)).status,409);
  assert.equal((await post('/api/crm',manual)).status,409);
  const recovery=await get('/api/crm?kind=tasks&taskView=unavailable-assignee');
  assert.ok(recovery.records.some(row=>row.id===assigned.id));
  const {nextTaskId}=await send('/api/crm',{action:'save',kind:'tasks',id:assigned.id,expectedRevision:1,data:{...manual.data,status:'Completed'}});
  assert.ok(nextTaskId);
  const nextTask=await get('/api/crm?kind=tasks&id='+nextTaskId);
  assert.equal(nextTask.assigneeId,null);
  assert.equal((await get('/api/crm?kind=tasks&id='+assigned.id)).assigneeId,assignee.id);
  await taskEdit('owned');
  const initial=await send(api,enrollment);
  assert.equal(initial.enrollment.id,enrollment.id);
  assert.equal((await send(api,enrollment)).enrollment.id,enrollment.id);
  assert.equal((await post(api,{...enrollment,id:randomUUID()})).status,409);
  const unavailable=(state)=>api+'?view=enrollments&state='+state+'&assignee=unavailable';
  assert.deepEqual((await get(unavailable('active'))).items,[]);
  await taskEdit('none');
  assert.deepEqual((await get(unavailable('active'))).items.map(row=>row.id),[enrollment.id]);
  assert.deepEqual((await get(unavailable('active'),other)).items,[]);
  await taskEdit('owned');
  assert.deepEqual((await get(unavailable('active'))).items,[]);
  const path=api+'?enrollmentId='+enrollment.id;
  assert.equal((await request(path,{headers:other})).status,404);
  assert.equal((await get(api+'?contactId='+contact.id)).items.length,1);
  await send(api,{...draft,expectedRevision:1,steps:[steps[0]]}); // Enrolled steps retain their reviewed content.
  const log=join(directory,'sequence-mail.jsonl'),mock=join(directory,'sequence-mail.mjs');
  await writeFile(log,'');
  await writeFile(mock,`
    import assert from 'node:assert/strict';
    import {appendFileSync} from 'node:fs';
    globalThis.fetch=async(resource,init={})=>{
      const url=new URL(resource);
      if(url.href==='https://oauth2.googleapis.com/token')return Response.json({access_token:'local-only',expires_in:3600,token_type:'Bearer'});
      assert.equal(url.origin,'https://gmail.googleapis.com');
      if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'owner@example.test'});
      assert.ok(url.pathname.endsWith('/messages/send')&&init.method==='POST');
      const mime=Buffer.from(JSON.parse(init.body).raw,'base64url').toString('utf8');
      appendFileSync(process.env.SEQUENCE_TEST_LOG,JSON.stringify(mime)+'\\n');
      if(process.env.SEQUENCE_TEST_LOST==='true')throw TypeError('Fictional acknowledgment lost');
      return Response.json({id:crypto.randomUUID(),threadId:'fixture-thread'});
    };`);
  const one=(options={},notesOnly=false)=>execute(process.execPath,['--import',mock,'scripts/portable-web.mjs','worker','--once',...(notesOnly?['--notes-only']:[])],{
    env:{...env,HARBOR_PORTABLE_GMAIL_ENABLED:'true',HARBOR_PORTABLE_GMAIL_OWNER:'owner@example.test',
      HARBOR_PORTABLE_GMAIL_CLIENT_ID:'fixture',HARBOR_PORTABLE_GMAIL_CLIENT_SECRET:'fixture',HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN:'fixture',
      HARBOR_SEQUENCE_WORKER_ENABLED:'true',SEQUENCE_TEST_LOG:log,...options},timeout:15000,
  });
  const calls=async()=> (await readFile(log,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const history=()=>get(path);
  async function advance(predicate,options={}){
    for(let i=0;i<12;i++){
      await one(options);
      const detail=await history();
      if(await predicate(detail))return detail;
    }
    assert.fail('Sequence did not reach expected step: '+JSON.stringify(await history()));
  }
  await one({},true);await one({HARBOR_SEQUENCE_WORKER_ENABLED:'false'});
  assert.equal((await calls()).length,0);
  const taskForSequence=async()=>sql`SELECT id FROM portable_tasks WHERE workspace_id=${workspaceId} AND data->>'name'='Follow up personally'`;
  await advance(async()=> (await taskForSequence()).length===1);
  const [task]=await taskForSequence();
  const previews=()=>sql`SELECT id,actor_email,kind,record_ids FROM portable_record_access_events
    WHERE workspace_id=${workspaceId} AND action='related' ORDER BY kind,id`;
  const before=new Set((await previews()).map(row=>row.id));
  assert.equal((await request(path,{headers,method:'HEAD'})).status,200);
  assert.equal((await request(path,{headers:other})).status,404);
  await get(api+'?view=assignees&contactId='+contact.id);
  await get(api+'?view=enrollments&state=stopped');
  assert.equal((await previews()).length,before.size);
  await history();
  const detailEvents=(await previews()).filter(row=>!before.has(row.id));
  assert.deepEqual(detailEvents.map(row=>[row.actor_email,row.kind,[...row.record_ids]]),[
    ['owner@example.test','contacts',[contact.id]],['owner@example.test','tasks',[task.id]],
  ]);
  // An audit failure cannot stop an enrollment and leave its contact disclosure unrecorded.
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_sequence_preview CHECK (action<>'related') NOT VALID`;
  try{
    assert.equal((await request(path,{headers})).status,503);
    assert.equal((await post(api,{action:'stop',id:enrollment.id})).status,503);
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_sequence_preview`;}
  assert.equal((await history()).enrollment.state,'active');
  const taskData=await get('/api/crm?kind=tasks&id='+task.id);
  const sharedTask='/api/crm?kind=tasks&id='+task.id+'&workspaceId='+workspaceId;
  assert.equal((await get(sharedTask,other)).linkedInProfile,profile);
  const visibility=(audience,expectedRevision)=>send('/api/custom-properties',{
    action:'standardAccess',kind:'contacts',id:'linkedinUrl',audience,expectedRevision});
  const restricted=await visibility('owner',0);
  assert.equal((await get(sharedTask,other)).linkedInProfile,null);
  assert.equal(taskData.linkedInProfile,profile);
  await visibility('workspace',restricted.property.revision);
  assert.equal(taskData.assigneeId,assignee.id);
  assert.equal(taskData.contactId,contact.id);
  const reminders='/api/task-reminders?workspaceId='+workspaceId;
  const repReminder=(await get(reminders,other)).items.find(item=>item.id===task.id);
  assert.equal(repReminder.dueAt,taskData.data.dueAt);
  assert.equal(Date.parse(repReminder.dueAt)-Date.parse(repReminder.remindAt),900000);
  assert.ok(!(await get('/api/task-reminders')).items.some(item=>item.id===task.id));
  assert.equal((await calls()).length,1);
  await send('/api/crm',{kind:'tasks',action:'save',data:{name:'Unrelated task',status:'Completed'},related:{kind:'contacts',id:contact.id}});
  await one();await one();
  assert.equal((await calls()).length,1);
  const [member]=await sql`SELECT id FROM portable_workspace_viewers WHERE workspace_id=${workspaceId} AND viewer_id=${assignee.id}`;
  function completeTask(record){
    const data={...record.data,status:'Completed'};
    delete data.dueAt; // The server derives this from the editable date, time and zone.
    return {kind:'tasks',action:'save',id:record.id,expectedRevision:record.revision,data};
  }
  const complete=completeTask(taskData);
  const scopeFor=id=>'/api/crm?'+new URLSearchParams({workspaceId,grantId:id});
  const outreach={contactId:contact.id,kind:'LinkedIn',summary:'Asked for feedback on the fictional sample.'};
  assert.equal(taskData.data.taskType,'LinkedIn');
  assert.equal(taskData.data.notes,steps[1].notes);
  assert.equal((await post(scopeFor(member.id),{...complete,outreach},other)).status,403);
  const unchanged=await get('/api/crm?kind=tasks&id='+task.id);
  assert.equal(unchanged.revision,taskData.revision);assert.equal(unchanged.completedAt,null);
  const enabled=await send('/api/workspaces',{action:'contact_outreach',id:member.id,enabled:true});
  let sharedTasks=scopeFor(enabled.viewers.find(v=>v.email==='other@example.test').id);
  assert.equal((await post(sharedTasks,{...complete,outreach:{...outreach,contactId:randomUUID()}},other)).status,409);
  await completeAssignedOutreach({origin,headers:other,workspaceId,task,profile,taskName:taskData.data.name,summary:outreach.summary});
  assert.ok(!(await get(reminders,other)).items.some(item=>item.id===task.id));
  assert.equal((await post(sharedTasks,{...complete,outreach},other)).status,409);
  const [outreachLog]=await sql`SELECT count(*)::int AS count,max(occurred_at)::float8 AS at FROM portable_contact_activities
    WHERE workspace_id=${workspaceId} AND contact_id=${contact.id} AND actor_id=${assignee.id} AND kind='LinkedIn' AND summary=${outreach.summary}`;
  assert.equal(outreachLog.count,1);
  assert.equal((await get('/api/logged-activities?contactId='+contact.id)).lastContacted,outreachLog.at); // A retried completion cannot release the follow-up twice.
  const done=await advance(detail=>detail.enrollment.state==='completed');
  assert.equal(done.steps.length,3);
  assert.equal((await taskForSequence()).length,1);
  await one();
  const messages=await calls();
  assert.equal(messages.length,2);
  for(const mime of messages)assert.match(mime,/river@example\.test/);
  assert.notDeepEqual(messages[0],messages[1]);

  const fresh={...enrollment,id:randomUUID(),expectedRevision:2};
  await send(api,fresh);
  for(let i=0;i<8;i++){
    await one({SEQUENCE_TEST_LOST:'true'});
    if((await get(api+'?enrollmentId='+fresh.id)).enrollment.state==='attention')break;
  }
  assert.equal((await get(api+'?enrollmentId='+fresh.id)).enrollment.state,'attention');
  await one();
  assert.equal((await calls()).length,3);
  // This receipt is for email alone. Losing Tasks access does not require a handoff.
  await taskEdit('none');
  assert.deepEqual((await get(unavailable('attention'))).items,[]);
  async function memberRole(role){
    const membership=(await get('/api/workspaces')).viewers.find(viewer=>viewer.email==='other@example.test');
    await send('/api/workspaces',{action:'role',id:membership.id,role});
  }
  await memberRole('viewer');
  assert.deepEqual((await get(unavailable('attention'))).items.map(row=>row.id),[fresh.id]);
  const queueUrl='/?view=sequences&section=enrollments&state=attention&enrollmentId='+fresh.id;
  const login=await request(queueUrl);
  assert.equal(new URL(login.headers.get('location'),origin).searchParams.get('return_to'),queueUrl);
  assert.equal((await request(queueUrl+'&workspaceId='+workspaceId,{headers:other})).status,404);
  assert.deepEqual((await get(api+'?view=enrollments&state=attention',other)).items,[]);
  if(process.env.HARBOR_TEST_PLAYWRIGHT){
    const {steps:held}=await get(api+'?enrollmentId='+fresh.id);
    await reviewUncertainEnrollment({origin,headers,id:fresh.id,contactId:contact.id,jobId:held[0].jobId});
  }else await send(api,{action:'stop',id:fresh.id});
  assert.equal((await get(api+'?enrollmentId='+fresh.id)).enrollment.state,'stopped');
  assert.deepEqual((await get(unavailable('attention'))).items,[]);
  await memberRole('editor');
  await taskEdit('owned');
  const replacement=(await get('/api/workspaces')).viewers.find(viewer=>viewer.email==='other@example.test');
  const restoredGrant=await send('/api/workspaces',{action:'contact_outreach',id:replacement.id,enabled:true});
  sharedTasks=scopeFor(restoredGrant.viewers.find(viewer=>viewer.email==='other@example.test').id);
  await one();
  assert.equal((await calls()).length,3);
  const stopped={...fresh,id:randomUUID()};
  await send(api,stopped);await send(api,{action:'stop',id:stopped.id});await one();
  assert.equal((await calls()).length,3);

  const forRestore={...fresh,id:randomUUID()};
  await send(api,forRestore);
  const bucket=localFileFixture();
  assert.ok(bucket,'The sequence restore rehearsal needs disposable file storage.');
  const targetName='harbor_sequence_restore_'+randomUUID().replaceAll('-','');
  const targetUrl=new URL(env.DATABASE_URL);targetUrl.pathname='/'+targetName;
  let copied,created=false;
  try{
    await sql`CREATE DATABASE ${sql(targetName)}`;created=true;
    await bucket.storage.send(new CreateBucketCommand({Bucket:bucket.bucket}));
    const archive=join(directory,'sequence-backup');
    await execute(process.execPath,['scripts/portable-web.mjs','backup',archive],{env});
    await execute(process.execPath,['scripts/portable-web.mjs','restore',archive],{env:{...env,...bucket.env,DATABASE_URL:targetUrl.href}});
    copied=postgres(targetUrl.href,{max:1,onnotice:()=>{}});
    const [restored]=await copied`SELECT state,issue FROM portable_sales_enrollments WHERE id=${forRestore.id}`;
    assert.deepEqual({...restored},{state:'stopped',issue:'restore_requires_reconciliation'});
    assert.equal((await copied`SELECT enrollment_id FROM portable_sales_sequence_activations`).length,0);
    await one({DATABASE_URL:targetUrl.href});
    assert.equal((await calls()).length,3);
    assert.equal((await get(api+'?enrollmentId='+forRestore.id)).enrollment.state,'active');
  }finally{
    await copied?.end({timeout:2});
    if(created)await sql`DROP DATABASE ${sql(targetName)} WITH (FORCE)`;
    try{await bucket.storage.send(new DeleteBucketCommand({Bucket:bucket.bucket}));}finally{bucket.storage.destroy();}
  }
  await send(api,{action:'stop',id:forRestore.id});

  // A received message predating enrollment does not stop it. A later recorded
  // message or confirmed meeting does, even when a task or delay is still open.
  await send(api,{...draft,expectedRevision:2,steps:[{...steps[1],delayDays:1},steps[2]]});
  const delayed={...fresh,expectedRevision:3};
  const taskPath='/api/crm?kind=tasks&workspaceId='+workspaceId;
  const assignedQueue=taskPath+'&taskView=mine&taskType=LinkedIn';
  async function checkWithdrawnTask(task,linkedContact){
    const retained=await get(taskPath+'&id='+task.id,other);
    assert.equal(retained.inactiveSequenceTask,true);
    assert.equal(retained.completedAt,null);
    assert.ok(!(await get(assignedQueue,other)).records.some(row=>row.id===task.id));
    assert.ok(!(await get(reminders,other)).items.some(row=>row.id===task.id));
    const stale=await post(sharedTasks,{...completeTask(task),outreach:{...outreach,contactId:linkedContact}},other);
    assert.equal(stale.status,409);
    assert.match((await stale.json()).error,/sequence step is no longer active/i);
  }
  const immediateSequence=randomUUID();
  await send(api,{...draft,id:immediateSequence,expectedRevision:0,steps:[steps[1],steps[2]]});
  for(const reason of ['sequence_reply_logged','sequence_meeting_booked']){
    const testId=randomUUID();
    await send(api,{...delayed,id:testId});
    const record=await get(api+'?enrollmentId='+testId);
    assert.equal(record.enrollment.state,'active');
    // Both a delayed step and a task already assigned to the rep must stop.
    const immediateId=randomUUID();
    await send(api,{...fresh,id:immediateId,sequenceId:immediateSequence,expectedRevision:1});
    await one();
    const taskId=(await get(api+'?enrollmentId='+immediateId)).steps[0].taskId;
    const activeTask=await get(taskPath+'&id='+taskId,other);
    assert.equal(activeTask.inactiveSequenceTask,false);
    assert.ok((await get(reminders,other)).items.some(row=>row.id===taskId));
    if(reason==='sequence_reply_logged'){
      const insertReceived=at=>sql`INSERT INTO portable_gmail_log_receipts(workspace_id,mailbox,message_id,thread_id,
        occurred_at,contact_id,contact_created_at,activity_id) VALUES (${workspaceId},'owner@example.test',${randomUUID()},
        'fictional-thread',${at},${contact.id},${contact.createdAt},${randomUUID()})`;
      await insertReceived(record.enrollment.createdAt-1000);
      await one();
      assert.equal((await get(api+'?enrollmentId='+testId)).enrollment.state,'active');
      assert.equal((await get(taskPath+'&id='+taskId,other)).inactiveSequenceTask,false);
      await insertReceived(Date.now());
    }else{
      const now=Date.now()+1;
      await sql`INSERT INTO portable_calendar_meetings(workspace_id,id,contact_id,owner_id,account_id,input,start_at,end_at,created_at,status)
        SELECT ${workspaceId},${randomUUID()},${contact.id},owner_id,'fictional-calendar',${sql.json({recipient:contact.data.email})},${now+10000},
        ${now+60000},${now},'scheduled' FROM private_workspaces WHERE id=${workspaceId}`;
    }
    await checkWithdrawnTask(activeTask,contact.id);
    await one();await one();
    assert.equal((await get(api+'?enrollmentId='+immediateId)).enrollment.issue,reason);
    const updated=await get(api+'?enrollmentId='+testId);
    assert.equal(updated.steps[0].taskId,null);
    assert.equal(updated.enrollment.state,'stopped');
    assert.equal(updated.enrollment.issue,reason);
    assert.equal((await calls()).length,3);
  }
  await send(api,{...draft,expectedRevision:3,steps:[steps[1],steps[2]]});
  const cancelled={...fresh,id:randomUUID(),expectedRevision:4};
  await send(api,cancelled);
  await one();
  const pending=(await get(api+'?enrollmentId='+cancelled.id)).steps[0].taskId;
  assert.ok(pending);
  const beforeStop=await get(taskPath+'&id='+pending,other);
  assert.ok((await get(assignedQueue,other)).records.some(row=>row.id===pending));
  assert.ok(beforeStop.linkedInProfile);
  await send(api,{action:'stop',id:cancelled.id});
  const retained=await get(taskPath+'&id='+pending,other);
  assert.equal(retained.completedAt,null);
  assert.equal(retained.inactiveSequenceTask,true);
  assert.equal(retained.linkedInProfile,null);
  assert.ok(!(await get(assignedQueue,other)).records.some(row=>row.id===pending));
  assert.ok((await get(taskPath+'&contactId='+contact.id,other)).records.some(row=>row.id===pending));
  const staleOutreach=await post(sharedTasks,{...completeTask(beforeStop),outreach},other);
  assert.equal(staleOutreach.status,409);
  assert.match((await staleOutreach.json()).error,/sequence step is no longer active/i);
  assert.equal((await get(taskPath+'&id='+pending,other)).revision,beforeStop.revision);
  const page=await request('/?kind=tasks&workspaceId='+workspaceId+'&record='+pending,{headers:other});
  assert.equal(page.status,200);
  const markup=await page.text();
  assert.match(markup,/No follow-up is due from this task/);
  assert.doesNotMatch(markup,/Log outreach and complete task|Open River Example on LinkedIn/);

  const beforeOptOut={...fresh,id:randomUUID(),expectedRevision:4};
  const optOutPath=api+'?enrollmentId='+beforeOptOut.id;
  await send(api,beforeOptOut);
  await one();
  const openTask=(await get(optOutPath)).steps[0].taskId;
  assert.ok(openTask);
  const action=await get('/api/crm?kind=tasks&id='+openTask);
  await send(sharedTasks,completeTask(action),other);
  await send('/api/email/suppressions',{id:randomUUID(),email:contact.data.email});
  for(let i=0;i<4;i++)await one();
  const optedOut=await get(optOutPath);
  assert.notEqual(optedOut.enrollment.state,'active');
  assert.match(optedOut.enrollment.issue??optedOut.steps.find(s=>s.issue)?.issue??'',/suppress|blocked|do.not.email/i);
  assert.equal((await calls()).length,3);
  // The Graph fixture contains yesterday's incoming mail. Represent a cadence that
  // started before it, alongside a new cadence for the same contact and mailbox.
  const mailbox='owner@example.test',address='outlook-record@example.test';
  const {connect}=outlookClient({request,origin,fixture:env});
  await connect(headers,'outlook-mail',mailbox);
  const {record:lead}=await send('/api/crm',{action:'save',kind:'contacts',assigneeId:assignee.id,data:{name:'Outlook sequence trial',email:address}});
  const enrollOutlook=async(firstStep)=>{
    const sequenceId=randomUUID(),id=randomUUID();
    await send(api,{...draft,id:sequenceId,expectedRevision:0,steps:[firstStep]});
    await send(api,{...enrollment,id,sequenceId,contactId:lead.id,recipient:address});
    return id;
  };
  const existing=await enrollOutlook(steps[1]),recent=await enrollOutlook({...steps[0],delayDays:3});
  const lookup={provider:'outlook-mail',recordId:lead.id,through:new Date(Date.now()-86400000).toISOString().slice(0,10),days:7};
  const {items}=await send('/api/outlook-records',lookup);
  const reply=items.find(item=>item.subject==='Proposal from contact');
  assert.ok(reply);
  await sql`UPDATE portable_sales_enrollments SET created_at=${reply.occurredAt-1} WHERE workspace_id=${workspaceId} AND id=${existing}`;
  await one();
  const existingDetail=await get(api+'?enrollmentId='+existing);
  assert.equal(existingDetail.enrollment.state,'active');
  const outlookTask=await get(taskPath+'&id='+existingDetail.steps[0].taskId,other);
  assert.equal(outlookTask.inactiveSequenceTask,false);
  const logReply=()=>ok(request('/api/outlook-records',{method:'PUT',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({...lookup,selection:reply.selection})}));
  async function checkReply(confirmOldReply){
    assert.equal((await logReply()).alreadyLogged,true);
    await checkWithdrawnTask(outlookTask,lead.id);
    const activityPath='/api/logged-activities?contactId='+lead.id;
    const [activity]=(await get(activityPath)).items;
    const [receipt]=await sql`SELECT outlook_received_at FROM portable_activity_creation_receipts
      WHERE workspace_id=${workspaceId} AND id=${activity.id} AND namespace='contact'`;
    assert.equal(Number(receipt.outlook_received_at),reply.occurredAt);
    await send(activityPath,{action:'remove',id:activity.id,expectedRevision:activity.revision});
    // Older versions retained only the fingerprint. Re-selecting the provider item
    // upgrades its receipt, even after removal, without resurrecting the activity.
    await sql`UPDATE portable_activity_creation_receipts SET outlook_received_at=NULL,outlook_contact_id=NULL,outlook_mailbox=NULL
      WHERE workspace_id=${workspaceId} AND id=${activity.id} AND namespace='contact'`;
    if(confirmOldReply)await confirmOldReply();
    else assert.equal((await logReply()).alreadyLogged,true);
    assert.equal((await get(activityPath)).items.length,0);
    await one();
    const exited=await get(api+'?enrollmentId='+existing);
    assert.equal(exited.enrollment.issue,'sequence_outlook_reply_logged');
    assert.equal(exited.steps[0].state,'stopped');
    assert.equal((await get(api+'?enrollmentId='+recent)).enrollment.state,'active');
    assert.equal((await calls()).length,3);
  }
  if(process.env.HARBOR_TEST_PLAYWRIGHT){
    await logOutlookSequenceReply({origin,headers,contactId:lead.id,through:lookup.through,afterLogging:checkReply});
  }else{
    assert.equal((await logReply()).alreadyLogged,false);
    await checkReply();
  }
  await send(api,{action:'stop',id:recent});
  const {record:kept}=await send('/api/crm',{action:'save',kind:'contacts',data:{name:'Consolidated Outlook contact'}});
  const merge={kind:'contacts',primaryId:kept.id,secondaryId:lead.id};
  const {preview}=await send('/api/record-merge',{action:'preview',...merge});
  await send('/api/record-merge',{action:'merge',...merge,requestId:randomUUID(),
    expectedRevisions:{primary:preview.primary.revision,secondary:preview.secondary.revision},choices:{}});
  const [moved]=await sql`SELECT outlook_contact_id FROM portable_activity_creation_receipts
    WHERE workspace_id=${workspaceId} AND outlook_mailbox=${mailbox} AND outlook_received_at=${reply.occurredAt}`;
  assert.equal(moved.outlook_contact_id,kept.id);
  if(process.env.HARBOR_TEST_PLAYWRIGHT){
    // Start the independent browser walkthrough with the test owner's normal request allowance.
    await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
      AND subject=(SELECT owner_id FROM private_workspaces WHERE id=${workspaceId})`;
    const {record:browserContact}=await send('/api/crm',{action:'save',kind:'contacts',data:{name:'Browser sequence contact',email:'browser-sequence@example.test'}});
    const {verifySalesSequenceBrowser}=await import('./portable-sales-sequence-browser.mjs');
    await verifySalesSequenceBrowser({origin,headers,contactId:browserContact.id});
  }
}
