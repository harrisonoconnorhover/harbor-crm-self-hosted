import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import 'tsx/esm';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';

const {reserveTeamBooking}=await import('../db/postgres/team-booking-store.ts');
const {runSalesSequencePass}=await import('../db/postgres/sales-sequence-processor.ts');
const {writeSalesSequences}=await import('../db/postgres/sales-sequence-store.ts');
const {enqueueGmail,beginGmailDispatch,finishGmailDispatch}=await import('../db/postgres/scheduled-gmail-store.ts');
const {claimPortableJob}=await import('../db/postgres/job-store.ts');
const {readSalesWorkspaceTasks}=await import('../db/postgres/sales-workspace-store.ts');
const {readTaskReminders,dismissTaskReminder}=await import('../db/postgres/task-reminder-store.ts');
const {savePortableTask}=await import('../db/postgres/task-store.ts');
const {portableTaskFields}=await import('../lib/portable-tasks.ts');
const database=process.env.HARBOR_TEST_POSTGRES_URL;

test('portable sequence execution follows only its own tasks and confirmed Gmail receipts', {skip:!database},async()=>{
  const url=new URL(database);
  assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/harbor_identity_test(?:_[a-z0-9]+)?$/);
  const admin=postgres(url.href,{max:1,onnotice:()=>{}}),name='harbor_seq_'+randomUUID().replaceAll('-','');
  const previous=process.env.HARBOR_SEQUENCE_WORKER_ENABLED;
  let client;
  try{
    await admin.unsafe('CREATE DATABASE '+name);
    url.pathname='/'+name;client=postgres(url.href,{max:5,onnotice:()=>{}});
    assert.equal(await applyPortableMigrations(client,readPortableMigrations(resolve('db/postgres/migrations'))),'ok');
    const db=drizzle(client),owner=randomUUID(),editor=randomUUID(),workspace=randomUUID(),contact=randomUUID();
    const sender='sender@example.test',recipient='contact@example.test',mail={type:'email',id:randomUUID(),subject:'Following up',body:'Hello',delayDays:0};
    const task={type:'task',id:randomUUID(),taskType:'LinkedIn',title:'Follow up',notes:'Send a personal note.',delayDays:0};
    await client`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at) VALUES
      (${owner},${owner},${sender},0,0),(${editor},${editor},'editor@example.test',0,0)`;
    await client`INSERT INTO private_workspaces(id,owner_id) VALUES(${workspace},${owner})`;
    await client`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role) VALUES(${workspace},${editor},${randomUUID()},'editor')`;
    await client`INSERT INTO contacts(workspace_id,id,revision,created_at,updated_at,data) VALUES
      (${workspace},${contact},1,now(),now(),${JSON.stringify({name:'Fictional',email:recipient})}::jsonb)`;
    const identity={userId:owner,email:sender};
    async function enroll(steps){
      const id=randomUUID(),sequenceId=randomUUID();
      await writeSalesSequences(db,identity,{action:'save',id:sequenceId,expectedRevision:0,name:'Fictional sequence',steps});
      await writeSalesSequences(db,identity,{action:'enroll',id,sequenceId,expectedRevision:1,contactId:contact,assigneeId:editor,recipient},sender);
      return id;
    }
    const rows=id=>client`SELECT * FROM portable_sales_sequence_steps WHERE enrollment_id=${id} ORDER BY position`;
    const status=async id=>(await client`SELECT state FROM portable_sales_enrollments WHERE id=${id}`)[0].state;
    const pass=()=>runSalesSequencePass(db);
    const claim=()=>claimPortableJob(db,{gmail:true});
    const stop=id=>writeSalesSequences(db,identity,{action:'stop',id});
    const first=await enroll([task,mail,{...task,id:randomUUID(),delayDays:1}]);
    delete process.env.HARBOR_SEQUENCE_WORKER_ENABLED;
    assert.equal(await pass(),'idle');
    process.env.HARBOR_SEQUENCE_WORKER_ENABLED='true';
    const raced=await Promise.all([pass(),pass()]);
    assert.deepEqual(raced.toSorted(),['idle','queued']);
    const [taskStep]=await rows(first);
    assert.equal(taskStep.task_id,taskStep.id);
    const [native]=await client`SELECT * FROM portable_tasks WHERE workspace_id=${workspace} AND id=${taskStep.id}`;
    assert.equal(native.contact_id,contact);assert.equal(native.assignee_id,editor);
    assert.equal(native.reminder_at,null);assert.equal(native.data.dueAt,undefined);
    assert.equal(native.data.notes,task.notes);assert.equal(native.data.taskType,'LinkedIn');
    const unrelated=await savePortableTask(db,owner,{action:'save',kind:'tasks',contactId:contact,assigneeId:editor,
      data:portableTaskFields.parse({name:'Someone else’s task',status:'Completed'})});
    assert.ok(unrelated.record);assert.equal(await pass(),'idle');
    const ready=await enroll([mail]); // Open manual task cannot starve another enrollment.
    assert.equal(await pass(),'queued');
    const independent=await claim();assert.equal(independent.id,(await rows(ready))[0].job_id);
    await stop(ready);assert.equal(await beginGmailDispatch(db,independent,sender,false),null);
    await savePortableTask(db,owner,{action:'save',kind:'tasks',id:native.id,expectedRevision:1,
      data:portableTaskFields.parse({...native.data,status:'Completed'})});
    assert.equal(await pass(),'advanced');assert.equal(await pass(),'queued');assert.equal(await pass(),'idle');
    const [,emailStep]=await rows(first);
    assert.equal(emailStep.job_id,emailStep.id);
    delete process.env.HARBOR_SEQUENCE_WORKER_ENABLED;
    assert.equal(await claim(),null);
    const ordinary=randomUUID();
    assert.equal(await enqueueGmail(db,{workspaceId:workspace,contactId:contact},owner,sender,
      {id:ordinary,scheduledFor:Date.now(),recipient,subject:'Separate email',body:'Hello'}),'ok');
    const standalone=await claim();assert.equal(standalone.id,ordinary);
    assert.ok(await beginGmailDispatch(db,standalone,sender,false));await finishGmailDispatch(db,standalone,'ordinary-receipt');
    process.env.HARBOR_SEQUENCE_WORKER_ENABLED='true';
    const outgoing=await claim();assert.equal(outgoing.id,emailStep.id);
    assert.ok(await beginGmailDispatch(db,outgoing,sender,false));
    await finishGmailDispatch(db,outgoing,'fictional-sequence-acceptance');
    assert.equal(await pass(),'advanced');assert.equal(await pass(),'idle');
    const done=await rows(first);
    assert.equal(Number(done[2].due_at)-Number(done[1].finished_at),86_400_000);
    assert.equal(done[2].task_id,null);
    // The first rep completed the task and sent the email before losing access.
    await client`UPDATE portable_workspace_viewers SET view_scope='owned',edit_scope='owned'
      WHERE workspace_id=${workspace} AND viewer_id=${editor}`;
    assert.equal(await pass(),'attention');
    const previous=await stop(first);
    const nextRep=randomUUID(),nextGrant=randomUUID();
    await client`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
      VALUES(${nextRep},${nextRep},'replacement@example.test',0,0)`;
    await client`INSERT INTO portable_workspace_viewers(workspace_id,viewer_id,id,role)
      VALUES(${workspace},${nextRep},${nextGrant},'editor')`;
    const handoff={action:'enroll',id:randomUUID(),sequenceId:previous.enrollment.sequenceId,expectedRevision:1,
      contactId:contact,assigneeId:nextRep,recipient:null,startStepId:done[2].definition.id};
    const resumed=await writeSalesSequences(db,identity,handoff,null);
    assert.deepEqual(resumed.steps.map(s=>s.position),[2]);
    assert.equal(resumed.steps[0].dueAt-resumed.enrollment.createdAt,86_400_000);
    await client`UPDATE portable_sales_sequence_steps SET due_at=0 WHERE enrollment_id=${handoff.id}`;
    assert.equal(await pass(),'queued');
    const [remaining]=await rows(handoff.id);
    const [replacementTask]=await client`SELECT * FROM portable_tasks WHERE id=${remaining.task_id} AND workspace_id=${workspace}`;
    assert.equal(replacementTask.assignee_id,nextRep);
    const finished=await savePortableTask(db,nextRep,{action:'save',kind:'tasks',id:replacementTask.id,expectedRevision:1,
      data:portableTaskFields.parse({...replacementTask.data,status:'Completed'})},{workspaceId:workspace,grantId:nextGrant});
    assert.ok(finished.record);
    assert.equal(await pass(),'completed');assert.equal(await claim(),null);
    assert.deepEqual((await rows(first)).slice(0,2),done.slice(0,2));
    await client`UPDATE portable_workspace_viewers SET view_scope='all',edit_scope='all'
      WHERE workspace_id=${workspace} AND viewer_id=${editor}`;
    // The rep’s access narrowed after the job was claimed. Recheck the assigned rep
    // before dispatch even if the sequence worker has not seen the move yet.
    const reassigned=await enroll([mail]);assert.equal(await pass(),'queued');const staleClaim=await claim();
    await client`UPDATE portable_workspace_viewers SET view_scope='owned',edit_scope='owned'
      WHERE workspace_id=${workspace} AND viewer_id=${editor}`;
    assert.equal(await beginGmailDispatch(db,staleClaim,sender,false),null);
    assert.equal((await client`SELECT dispatch_started_at FROM portable_scheduled_gmail WHERE job_id=${staleClaim.id}`)[0].dispatch_started_at,null);
    assert.equal(await pass(),'attention');assert.equal(await status(reassigned),'attention');
    await stop(reassigned);
    await client`UPDATE portable_workspace_viewers SET view_scope='all',edit_scope='all'
      WHERE workspace_id=${workspace} AND viewer_id=${editor}`;
    const lostTaskAccess=await enroll([task,mail]);
    assert.equal(await pass(),'queued');
    const [openStep]=await rows(lostTaskAccess);
    await client`UPDATE portable_workspace_viewers SET tool_policies=${JSON.stringify({tasks:{view:'all',edit:'none',create:false,delete:false}})}::jsonb
      WHERE workspace_id=${workspace} AND viewer_id=${editor}`;
    assert.equal(await pass(),'attention');assert.equal(await pass(),'idle');
    const [halted,unsent]=await rows(lostTaskAccess);
    assert.equal(halted.task_id,openStep.task_id);assert.match(halted.issue,/can no longer edit tasks/);assert.equal(unsent.job_id,null);
    await stop(lostTaskAccess);
    const emailOnly=await enroll([mail]);assert.equal(await pass(),'queued');
    const emailJob=await claim();assert.equal(emailJob.id,(await rows(emailOnly))[0].job_id);
    assert.ok(await beginGmailDispatch(db,emailJob,sender,false));await finishGmailDispatch(db,emailJob,'fictional-email-only');
    assert.equal(await pass(),'completed');
    await client`UPDATE portable_workspace_viewers SET tool_policies='{}'::jsonb WHERE workspace_id=${workspace} AND viewer_id=${editor}`;
    // Removing the activation alone (as during recovery) fences an already queued email.
    const restored=await enroll([mail]);assert.equal(await pass(),'queued');const restoredJob=await claim();
    await client`DELETE FROM portable_sales_sequence_activations WHERE enrollment_id=${restored}`;
    assert.equal(await beginGmailDispatch(db,restoredJob,sender,false),null);assert.equal(await pass(),'idle');
    assert.equal((await client`SELECT dispatch_started_at FROM portable_scheduled_gmail WHERE job_id=${restoredJob.id}`)[0].dispatch_started_at,null);
    const unsure=await enroll([mail,task]);assert.equal(await pass(),'queued');const unknown=await claim();
    assert.ok(await beginGmailDispatch(db,unknown,sender,false));await finishGmailDispatch(db,unknown);
    assert.equal(await pass(),'attention');assert.equal(await status(unsure),'attention');assert.equal((await rows(unsure))[1].task_id,null);
    const normal=await enroll([mail]);assert.equal(await pass(),'queued');const confirmed=await claim();
    assert.ok(await beginGmailDispatch(db,confirmed,sender,false));await finishGmailDispatch(db,confirmed,'fictional-last-step');
    assert.equal(await pass(),'completed');assert.equal(await status(normal),'completed');assert.equal(await pass(),'idle');
    // A delayed worker starts the timed task's clock at assignment; replaying a pass
    // preserves the deadline. Stopping a run removes its pending reminder.
    const later=await enroll([{...task,timing:{dueAfterMinutes:60,reminderMinutes:15}}]);
    await client`UPDATE portable_sales_sequence_steps SET due_at=due_at-86400000 WHERE enrollment_id=${later}`;
    const before=Math.floor(Date.now()/60000)*60000;
    assert.equal(await pass(),'queued');
    const [timed]=await rows(later),[saved]=await client`SELECT * FROM portable_tasks WHERE id=${timed.task_id}`;
    const due=Date.parse(saved.data.dueAt);
    assert.ok(due>=before+3600000 && due<=Date.now()+3600000);
    assert.equal(saved.data.dueTimeZone,'UTC');
    const inbox=()=>readTaskReminders(db,editor,workspace);
    assert.equal((await inbox()).nextAt,new Date(due-900000).toISOString());
    assert.equal(await pass(),'idle');assert.equal((await inbox()).nextAt,new Date(due-900000).toISOString());
    const now=new Date(before).toISOString();
    const manual=await savePortableTask(db,owner,{action:'save',kind:'tasks',contactId:contact,assigneeId:editor,
      data:portableTaskFields.parse({name:'Independent reminder',dueDate:now.slice(0,10),dueTime:now.slice(11,16),dueTimeZone:'UTC',reminderMinutes:0})});
    assert.ok(manual.record);
    const summary=()=>readSalesWorkspaceTasks(db,editor,workspace,'UTC');
    const beforeStop=await summary();
    await stop(later);assert.equal((await inbox()).nextAt,null);
    const afterStop=await summary();
    assert.equal(afterStop.counts.mine,beforeStop.counts.mine-1);
    assert.ok(!afterStop.preview.some(item=>item.id===timed.task_id));
    assert.ok((await inbox()).items.some(item=>item.id===manual.record.id));
    assert.equal(await dismissTaskReminder(db,editor,workspace,manual.record.id,manual.record.revision),true);
    assert.ok(!(await inbox()).items.some(item=>item.id===manual.record.id));
    const replied=await enroll([{...task,timing:{dueAfterMinutes:0,reminderMinutes:0}},mail]);assert.equal(await pass(),'queued');
    const [enrollment]=await client`SELECT created_at FROM portable_sales_enrollments WHERE id=${replied}`;
    async function logReply(mailbox,at){
      await client`INSERT INTO portable_gmail_log_receipts(workspace_id,mailbox,message_id,thread_id,occurred_at,contact_id,contact_created_at,activity_id)
        VALUES(${workspace},${mailbox},${randomUUID()},'thread',${at},${contact},now(),${randomUUID()})`;
    }
    await logReply(sender,Number(enrollment.created_at)-1);await logReply('unrelated@example.test',Number(enrollment.created_at)+1);
    assert.equal(await pass(),'idle');
    const [open]=await rows(replied);assert.ok((await inbox()).items.some(item=>item.id===open.task_id));
    await logReply(sender,Number(enrollment.created_at)+1);
    assert.equal(await pass(),'stopped');assert.equal(await status(replied),'stopped');assert.equal((await rows(replied))[1].job_id,null);
    assert.ok(!(await inbox()).items.some(item=>item.id===open.task_id));
    assert.equal(await dismissTaskReminder(db,editor,workspace,open.task_id,1),false);
    // Before dispatch a logged Outlook reply fences the claimed job. Once dispatch
    // starts, the sequence must retain the actual delivery outcome as well as the reply.
    for(const outcome of ['unstarted','accepted','unknown']){
      const id=await enroll([mail,task]);assert.equal(await pass(),'queued');const job=await claim();
      if(outcome!=='unstarted')assert.ok(await beginGmailDispatch(db,job,sender,false));
      const insert=async(mailbox,offset)=>client`INSERT INTO portable_activity_creation_receipts
        (workspace_id,namespace,id,fingerprint,outlook_contact_id,outlook_mailbox,outlook_received_at)
        SELECT workspace_id,'contact',${randomUUID()},'outlook:fixture',contact_id,${mailbox},created_at+${offset}
        FROM portable_sales_enrollments WHERE id=${id}`;
      await insert(sender,-1);await insert('other@example.test',1);
      assert.equal(await pass(),'idle');
      await insert(sender,1);
      if(outcome==='unstarted')assert.equal(await beginGmailDispatch(db,job,sender,false),null);
      else{
        assert.equal(await pass(),'idle');
        await finishGmailDispatch(db,job,outcome==='accepted'?'confirmed-outlook-test':undefined);
      }
      assert.equal(await pass(),outcome==='unknown'?'attention':'stopped');
      const [email,followUp]=await rows(id);
      assert.equal(email.state,{unstarted:'stopped',accepted:'completed',unknown:'attention'}[outcome]);
      if(outcome==='unknown')assert.match(email.issue,/external_outcome_unknown/);
      assert.equal(followUp.task_id,null);
      await stop(id);
    }
    const booked=await enroll([mail]);assert.equal(await pass(),'queued');const appointmentJob=await claim();
    const [booking]=await client`SELECT created_at FROM portable_sales_enrollments WHERE id=${booked}`;
    await client`INSERT INTO portable_calendar_meetings (workspace_id,id,contact_id,owner_id,account_id,input,start_at,end_at,created_at,status)
      VALUES (${workspace},${randomUUID()},${contact},${owner},'fixture',${JSON.stringify({recipient})}::jsonb,100,200,${Number(booking.created_at)+1},'scheduled')`;
    assert.equal(await beginGmailDispatch(db,appointmentJob,sender,false),null);assert.equal(await pass(),'stopped');
    assert.equal(await status(booked),'stopped');
    // A rep confirms a round-robin booking after the email job is claimed.
    const teamRun=await enroll([mail]);assert.equal(await pass(),'queued');const teamJob=await claim();
    const hostId=randomUUID(),slot=Math.ceil((Date.now()+86400000)/900000)*900000;
    const calendar={id:randomUUID(),workspaceId:workspace,title:'Fictional rotation',mode:'rotation',hosts:[hostId],duration:15,closed:false,publicEnabled:false};
    const windows=[{start:new Date(slot).toISOString(),end:new Date(slot+3600000).toISOString()}];
    await client`INSERT INTO portable_team_availability (id,workspace_id,user_id,windows,revision)
      VALUES (${hostId},${workspace},${owner},${JSON.stringify(windows)}::jsonb,1)`;
    const reserve=(id,at)=>db.transaction(tx=>reserveTeamBooking(tx,calendar,id,recipient,new Date(at).toISOString()));
    const duplicate=randomUUID();
    await client`INSERT INTO contacts(workspace_id,id,revision,created_at,updated_at,data)
      SELECT workspace_id,${duplicate},1,now(),now(),data FROM contacts WHERE id=${contact}`;
    await reserve(randomUUID(),slot);
    const marker=async()=>(await client`SELECT team_booking_id FROM portable_sales_sequence_activations WHERE enrollment_id=${teamRun}`)[0].team_booking_id;
    assert.equal(await marker(),null);
    await client`UPDATE contacts SET archived_at=now() WHERE id=${duplicate}`;
    const taskRun=await enroll([task]);assert.equal(await pass(),'queued');
    const beforeBooking=await summary();
    const meetingId=randomUUID();
    await reserve(meetingId,slot+900000);
    assert.equal((await summary()).counts.mine,beforeBooking.counts.mine-1);
    assert.equal(await marker(),meetingId);
    assert.equal(await beginGmailDispatch(db,teamJob,sender,false),null);
    assert.equal(await pass(),'stopped');
    assert.equal(await pass(),'stopped');assert.equal(await status(taskRun),'stopped');
    assert.equal((await client`SELECT issue FROM portable_sales_enrollments WHERE id=${teamRun}`)[0].issue,'sequence_meeting_booked');
    assert.equal((await client`SELECT dispatch_started_at FROM portable_scheduled_gmail WHERE job_id=${teamJob.id}`)[0].dispatch_started_at,null);
    // The last pre-send check and the processor both see a consent or address change.
    const optedOut=await enroll([mail]);assert.equal(await pass(),'queued');const blockedJob=await claim();
    await client`INSERT INTO portable_email_suppressions(workspace_id,id,email,created_at) VALUES(${workspace},${randomUUID()},${recipient},now())`;
    assert.equal(await beginGmailDispatch(db,blockedJob,sender,false),null);assert.equal(await pass(),'attention');
    assert.equal(await status(optedOut),'attention');
    await client`DELETE FROM portable_email_suppressions WHERE workspace_id=${workspace} AND email=${recipient}`;
    const moved=await enroll([task,mail]);assert.equal(await pass(),'queued');
    await client`UPDATE contacts SET data=jsonb_set(data,'{email}',to_jsonb('new@example.test'::text)) WHERE workspace_id=${workspace} AND id=${contact}`;
    assert.equal(await pass(),'attention');assert.equal(await status(moved),'attention');
    await client`UPDATE contacts SET data=jsonb_set(data,'{email}',to_jsonb(${recipient}::text)) WHERE workspace_id=${workspace} AND id=${contact}`;
    const revoked=await enroll([mail]);assert.equal(await pass(),'queued');const held=await claim();
    await client`DELETE FROM portable_workspace_viewers WHERE workspace_id=${workspace} AND viewer_id=${editor}`;
    assert.equal(await beginGmailDispatch(db,held,sender,false),null);assert.equal(await pass(),'attention');
    assert.equal(await status(revoked),'attention');
  }finally{
    if(previous===undefined)delete process.env.HARBOR_SEQUENCE_WORKER_ENABLED;else process.env.HARBOR_SEQUENCE_WORKER_ENABLED=previous;
    await client?.end({timeout:3});
    try{await admin.unsafe('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');}finally{await admin.end({timeout:3});}
  }
});
