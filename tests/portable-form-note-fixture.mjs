import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const manager='/api/lead-forms';
const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
const cwd=process.env.HARBOR_TEST_PORTABLE_CWD;
const workerEnv=env=>({...env,HARBOR_PORTABLE_GMAIL_ENABLED:'false',HARBOR_PORTABLE_CODE_ENABLED:'false'});
const worker=env=>execute(process.execPath,[command,'worker','--once'],{cwd,timeout:10_000,env:workerEnv(env)});
const post=(request,origin,auth,path,data)=>request(path,{method:'POST',
  headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(data)});
async function expect(response,status,label){
  assert.equal(response.status,status,label+' — '+await response.clone().text());
  return response.json();
}
const source=async(sql,workspaceId,id)=>(await sql`
  SELECT workspace_id,inquiry_id,form_id,form_revision,contact_id,owner_id,job_id,state,issue
  FROM portable_lead_form_note_sources WHERE workspace_id=${workspaceId} AND inquiry_id=${id}`)[0];
const job=async(sql,workspaceId,id)=>(await sql`
  SELECT id,kind,actor_id,contact_id,status,attempts FROM portable_jobs WHERE workspace_id=${workspaceId} AND id=${id}`)[0];
const notes=(sql,workspaceId,ids)=>sql`
  SELECT job_id,body FROM portable_notes WHERE workspace_id=${workspaceId} AND job_id=ANY(${ids}::uuid[]) ORDER BY job_id`;
const ready=(sql,workspaceId,ids)=>sql`
  UPDATE portable_lead_form_note_sources SET next_at=0,retry_at=NULL
  WHERE workspace_id=${workspaceId} AND state='waiting' AND inquiry_id=ANY(${ids}::uuid[])`;
async function untilWorker(env,done,label){
  for(let pass=0;pass<12;pass++){
    if(await done())return;
    await worker(env);
  }
  assert.ok(await done(),label);
}

export async function verifyPortableFormNotePromotionTimeout(sql,env,waiting){
  const {workspace_id:workspaceId,inquiry_id:inquiryId,job_id:formJobId,contact_id:contactId,owner_id:ownerId}=waiting;
  const ordinaryId=randomUUID();
  await ready(sql,workspaceId,[inquiryId]);
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    VALUES(${workspaceId},${ordinaryId},${contactId},${ownerId},'note','Fictional independent Note',0,0,0)`;
  assert.match(inquiryId,/^[a-f0-9-]{36}$/);
  await sql.unsafe(`CREATE FUNCTION harbor_test_slow_form_note_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(7); RETURN NEW; END $$;
    CREATE TRIGGER harbor_test_slow_form_note_receipt BEFORE UPDATE ON portable_lead_form_note_sources
    FOR EACH ROW WHEN (NEW.inquiry_id='${inquiryId}' AND NEW.state='queued')
    EXECUTE FUNCTION harbor_test_slow_form_note_receipt()`).simple();
  try{
    const {stderr}=await worker(env);
    assert.match(stderr,/Portable form Note promotion failed\. Retry scheduled\./);
    const [deferred]=await sql`SELECT state,job_id,next_at,retry_at FROM portable_lead_form_note_sources
      WHERE workspace_id=${workspaceId} AND inquiry_id=${inquiryId}`;
    assert.equal(deferred.state,'waiting');
    assert.equal(deferred.job_id,formJobId);
    assert.equal(Number(deferred.next_at),0);
    assert.ok(Number(deferred.retry_at)>0);
    assert.equal(await job(sql,workspaceId,formJobId),undefined,'A rolled-back promotion cannot leave a job behind.');
    const ordinary=await job(sql,workspaceId,ordinaryId);
    assert.equal(ordinary?.status,'succeeded','The same worker pass still processes an ordinary job.');
    assert.equal(ordinary.attempts,1);
    assert.equal((await notes(sql,workspaceId,[ordinaryId])).length,1);
  }finally{
    await sql.unsafe('DROP TRIGGER harbor_test_slow_form_note_receipt ON portable_lead_form_note_sources; DROP FUNCTION harbor_test_slow_form_note_receipt()').simple();
    await sql.begin(async tx=>{
      await tx`DELETE FROM portable_notes WHERE workspace_id=${workspaceId} AND job_id=${ordinaryId}`;
      await tx`DELETE FROM portable_job_attempts WHERE workspace_id=${workspaceId} AND job_id=${ordinaryId}`;
      await tx`DELETE FROM portable_jobs WHERE workspace_id=${workspaceId} AND id=${ordinaryId}`;
    });
  }
}

export async function verifyPortableFormNotes({request,origin,headers,other,sql,env,sharing}){
  const {workspaceId}=sharing;
  const [{owner_id:ownerId}]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspaceId}`;
  const formId=randomUUID(),defaultId=randomUUID(),label='Fictional form Note '+formId;
  const definition={title:'Fictional form automation',captureContacts:true,queueWorkflows:true,automationNote:label};
  const action=(data,auth=headers)=>post(request,origin,auth,manager,data);
  const save=(id,revision,fields=definition)=>action({action:'save',id,revision,definition:fields});
  const enable=(id,revision,enabled)=>action({action:'setEnabled',id,revision,enabled});
  const submission=(email,revision=2)=>({id:randomUUID(),revision,payload:{name:'Fictional prospect',email,message:'Public text is not the automation Note.'}});
  const send=(id,input)=>post(request,origin,{},'/api/public/forms/'+id,input);
  const getSource=id=>source(sql,workspaceId,id);
  const getJob=id=>job(sql,workspaceId,id);
  const getNotes=ids=>notes(sql,workspaceId,ids);
  const readInbox=async(id=formId,auth=headers)=>(await expect(
    await request(manager+'?formId='+id,{headers:auth}),200,'read form inquiries')).results;
  const readInquiry=async(id,form=formId)=>(await readInbox(form)).find(row=>row.id===id);
  const assertWaiting=async(input,contactId)=>{
    const row=await getSource(input.id);
    assert.ok(row?.job_id,'A pending inquiry has a stable Note job ID before processing.');
    assert.deepEqual([row.workspace_id,row.inquiry_id,row.form_id,row.form_revision,row.contact_id,row.owner_id,row.state],
      [workspaceId,input.id,formId,input.revision,contactId,ownerId,'waiting']);
    assert.equal(await getJob(row.job_id),undefined,'A public/retry request must never enqueue a job.');
    assert.deepEqual((await readInquiry(input.id)).noteAutomation,{status:'waiting',issue:null});
    return row;
  };
  const drain=async(inputs,rows,continuous=false)=>{
    const ids=rows.map(row=>row.job_id);
    if(continuous){
      const child=spawn(process.execPath,[command,'worker'],{cwd,env:workerEnv(env),stdio:'ignore'});
      const closed=once(child,'close');
      try{
        for(let poll=0;poll<100&&child.exitCode===null&&(await getNotes(ids)).length<ids.length;poll++)await delay(100);
        assert.equal((await getNotes(ids)).length,ids.length,'The continuous worker did not drain the saved inquiries.');
      }finally{
        child.kill('SIGTERM');
        const result=await Promise.race([closed,delay(6000,undefined,{ref:false})]);
        if(!result){child.kill('SIGKILL');await closed;}
        assert.deepEqual(result,[0,null]);
      }
    }else{
      await ready(sql,workspaceId,inputs.map(input=>input.id));
      await untilWorker(env,async()=>(await getNotes(ids)).length===ids.length,'The worker did not complete all inquiry Notes.');
    }
    await worker(env);
    const saved=await getNotes(ids);
    assert.deepEqual(saved.map(row=>[row.job_id,row.body]),[...ids].sort().map(id=>[id,label]));
    for(const [index,row] of rows.entries()){
      assert.deepEqual(await getJob(row.job_id),{id:row.job_id,kind:'note',actor_id:ownerId,
        contact_id:row.contact_id,status:'succeeded',attempts:1});
      assert.deepEqual((await readInquiry(inputs[index].id)).noteAutomation,{status:'succeeded',issue:null});
    }
    return saved.map(row=>({...row}));
  };
  // Other fixtures use the same synthetic owner API budget.
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_write' AND subject=${ownerId}`;

  await expect(await save(defaultId,0,{title:'Default Off fixture',captureContacts:true}),200,'save default form');
  await expect(await enable(defaultId,1,true),200,'enable public intake without Note automation');
  const defaultInquiry=submission('default-'+defaultId+'@example.test');
  assert.deepEqual(await expect(await send(defaultId,defaultInquiry),200,'accept with Note automation Off'),{accepted:true});
  const noAutomation=await readInquiry(defaultInquiry.id,defaultId);
  assert.ok(noAutomation.contactId);
  assert.equal(noAutomation.noteAutomation??null,null);
  assert.equal(await getSource(defaultInquiry.id),undefined);
  assert.equal((await sql`SELECT count(*)::int count FROM portable_jobs
    WHERE workspace_id=${workspaceId} AND contact_id=${noAutomation.contactId}`)[0].count,0);
  await expect(await enable(defaultId,2,false),200,'close the default form fixture');

  await expect(await save(formId,0),200,'save form with explicit Note action');
  assert.equal((await request('/forms/'+formId)).status,404);
  await expect(await enable(formId,1,true),200,'enable public intake with Note automation');
  assert.equal((await request(manager+'?formId='+formId,{headers:other})).status,404);
  const first=submission(formId+'@example.test'),second=submission(first.payload.email);
  for(const response of await Promise.all([send(formId,first),send(formId,first),send(formId,second)]))
    assert.deepEqual(await expect(response,200,'accept distinct inquiries and one exact replay'),{accepted:true});
  const rows=await readInbox();
  assert.deepEqual(rows.map(row=>row.status).sort(),['created','linked']);
  const contactId=rows[0].contactId;
  assert.ok(contactId&&rows.every(row=>row.contactId===contactId));
  const firstSource=await assertWaiting(first,contactId),secondSource=await assertWaiting(second,contactId);
  assert.notEqual(firstSource.job_id,secondSource.job_id);
  const tampered={...first,payload:{...first.payload,message:'Different replay'}};
  await expect(await send(formId,tampered),409,'reject tampered replay');
  assert.deepEqual(await getSource(first.id),firstSource);
  await execute(process.execPath,[command,'worker','--once','--notes-only'],{cwd,timeout:10_000,env:workerEnv(env)});
  assert.deepEqual(await getSource(first.id),firstSource);
  assert.deepEqual(await getSource(second.id),secondSource);
  await verifyPortableFormNotePromotionTimeout(sql,env,firstSource);
  await ready(sql,workspaceId,[first.id]);
  const completed=await drain([first,second],[firstSource,secondSource],true);
  await expect(await send(formId,first),200,'replay completed inquiry');
  await worker(env);
  assert.deepEqual(Array.from(await getNotes(completed.map(row=>row.job_id))),completed);

  const full=submission(first.payload.email),capacity=Array.from({length:100},()=>randomUUID());
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
    SELECT ${workspaceId},entry.id,${contactId},${ownerId},'note','Fictional queue capacity',0,9999999999999,0
    FROM unnest(${capacity}::uuid[]) AS entry(id)`;
  let fullSource;
  const otherForm=randomUUID();
  const [{id:otherWorkspaceId}]=await sql`SELECT w.id FROM private_workspaces w
    JOIN login_identities l ON l.id=w.owner_id WHERE l.email='other@example.test'`;
  const otherInquiry=submission('other-'+otherForm+'@example.test');
  try{
    assert.deepEqual(await expect(await send(formId,full),200,'accept public inquiry with a full job queue'),{accepted:true});
    fullSource=await assertWaiting(full,contactId);
    const timing=async()=>(await sql`SELECT next_at,retry_at FROM portable_lead_form_note_sources
      WHERE workspace_id=${workspaceId} AND inquiry_id=${full.id}`)[0];
    const readyAt=(await timing()).next_at;
    await untilWorker(env,async()=>(await timing()).retry_at!==null,'A full queue should defer promotion for this workspace.');
    assert.equal((await timing()).next_at,readyAt,'Retry keeps the original ready time for alerts.');
    assert.deepEqual(await getSource(full.id),fullSource);
    assert.equal(await getJob(fullSource.job_id),undefined);
    const search=new URLSearchParams({inquirySearch:full.payload.email.toUpperCase()});
    const issuesUrl=manager+'?formId='+formId+'&filter=note_issues&'+search;
    const noteIssues=async()=>(await expect(await request(issuesUrl,{headers}),200,'read Note issues')).results;
    assert.deepEqual(await noteIssues(),[]);
    const recent=Array.from({length:26},()=>randomUUID());
    await sql`INSERT INTO portable_lead_inquiries(workspace_id,id,form_id,received_at,status)
      SELECT ${workspaceId},fixture.id,${formId},9999999999999,'inbox_only'
      FROM unnest(${recent}::uuid[]) AS fixture(id)`;
    try{
      await ready(sql,workspaceId,[full.id]);
      assert.ok(!(await readInbox()).some(row=>row.id===full.id),'newer inquiries fill the first unfiltered page');
      assert.deepEqual((await noteIssues()).map(row=>[row.id,row.noteAutomation.overdue]),[[full.id,true]]);
      assert.equal((await request(issuesUrl)).status,401);
      assert.equal((await request(issuesUrl,{headers:other})).status,404);
      const issuePage=await request('/?view=forms&formId='+formId+'&filter=note_issues&'+search,{headers});
      assert.equal(issuePage.status,200);
      const issueHtml=await issuePage.text();
      assert.match(issueHtml,/Waiting longer than expected/);
      assert.match(issueHtml,/Open the Job queue/);
      assert.doesNotMatch(issueHtml,/Open Note job/);
      await sql`UPDATE portable_lead_form_note_sources SET state='queued',next_at=NULL,retry_at=NULL
        WHERE workspace_id=${workspaceId} AND inquiry_id=${full.id}`;
      try{
        await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
          VALUES(${workspaceId},${fullSource.job_id},${contactId},${ownerId},'note','Synthetic overdue Note',0,0,0)`;
        assert.deepEqual((await noteIssues()).map(row=>[row.id,row.noteAutomation.status,row.noteAutomation.overdue]),[[full.id,'queued',true]]);
        await sql`UPDATE portable_jobs SET status='running',attempts=1,lease_token=${randomUUID()},lease_until=${Date.now()+60_000}
          WHERE workspace_id=${workspaceId} AND id=${fullSource.job_id}`;
        await sql`INSERT INTO portable_job_attempts(workspace_id,job_id,number,started_at)
          VALUES(${workspaceId},${fullSource.job_id},1,${Date.now()-5_000})`;
        assert.deepEqual(await noteIssues(),[]);
        await sql`UPDATE portable_jobs SET lease_until=0 WHERE workspace_id=${workspaceId} AND id=${fullSource.job_id}`;
        assert.deepEqual((await noteIssues()).map(row=>[row.id,row.noteAutomation.overdue,row.noteAutomation.claimExpired,row.noteAutomation.attentionJobId]),
          [[full.id,true,true,fullSource.job_id]]);
        const expiredPage=await request('/?view=forms&formId='+formId+'&filter=note_issues',{headers});
        assert.equal(expiredPage.status,200);
        const expiredHtml=await expiredPage.text();
        assert.match(expiredHtml,/Worker claim expired/);
        const jobLink=expiredHtml.match(/href="([^"]+)">Open Note job<\/a>/)?.[1]?.replaceAll('&amp;','&');
        assert.ok(jobLink);
        assert.equal(new URL(jobLink,origin).searchParams.get('jobId'),fullSource.job_id);
        const details=await request(jobLink,{headers});
        assert.equal(details.status,200);
        const jobHtml=await details.text();
        assert.match(jobHtml,/<h1>Job details<\/h1>/);
        assert.match(jobHtml,/Worker claim expired/);
        assert.match(jobHtml,/Started [\s\S]*In progress/);
        assert.equal((await request(jobLink,{headers:other})).status,404);
        await sql`UPDATE portable_jobs SET status='failed',attempts=5,finished_at=1,lease_token=NULL,lease_until=NULL
          WHERE workspace_id=${workspaceId} AND id=${fullSource.job_id}`;
        assert.deepEqual((await noteIssues()).map(row=>[row.id,row.noteAutomation.status]),[[full.id,'failed']]);
        await expect(await post(request,origin,headers,'/api/background-jobs?recordId='+contactId,
          {action:'reviewFailed',id:fullSource.job_id,attempts:5}),200,'review the failed Note from its job');
        assert.deepEqual(await noteIssues(),[]);
        const afterRecent=new URLSearchParams({formId,afterAt:'9999999999999',afterId:recent.toSorted()[0]});
        const reviewed=(await expect(await request(manager+'?'+afterRecent,{headers}),200,'read reviewed Note'))
          .results.find(row=>row.id===full.id);
        assert.ok(reviewed?.noteAutomation);
        assert.equal(reviewed.noteAutomation.attentionJobId,undefined);
      }finally{
        await sql`DELETE FROM portable_job_attempts WHERE workspace_id=${workspaceId} AND job_id=${fullSource.job_id}`;
        await sql`DELETE FROM portable_jobs WHERE workspace_id=${workspaceId} AND id=${fullSource.job_id}`;
        await sql`UPDATE portable_lead_form_note_sources SET state='waiting',next_at=${readyAt},retry_at=NULL
          WHERE workspace_id=${workspaceId} AND inquiry_id=${full.id}`;
      }
    }finally{
      await sql`DELETE FROM portable_lead_inquiries WHERE workspace_id=${workspaceId} AND id=ANY(${recent}::uuid[])`;
    }
    await expect(await action({action:'save',id:otherForm,revision:0,definition},other),200,'save second workspace form');
    await expect(await action({action:'setEnabled',id:otherForm,revision:1,enabled:true},other),200,'enable second workspace form');
    await expect(await send(otherForm,otherInquiry),200,'accept a second workspace inquiry while the first queue is full');
    const foreignSource=await source(sql,otherWorkspaceId,otherInquiry.id);
    assert.equal(foreignSource?.state,'waiting');
    await untilWorker(env,async()=>(await notes(sql,otherWorkspaceId,[foreignSource.job_id])).length===1,
      'Full queue in one workspace must not block another workspace’s Note.');
    assert.equal((await job(sql,otherWorkspaceId,foreignSource.job_id)).status,'succeeded');
    assert.equal((await getSource(full.id)).state,'waiting');
    assert.equal(await getJob(fullSource.job_id),undefined);

  }finally{
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${workspaceId} AND id=ANY(${capacity}::uuid[])`;
  }
  await drain([full],[fullSource]);

  const capacitySkip=submission(first.payload.email);
  const pendingSources=Array.from({length:100},()=>randomUUID());
  try{
    // Fill Note admission capacity without adding jobs or consuming current inquiry quota.
    await sql.begin(async tx=>{
      await tx`INSERT INTO portable_lead_inquiries(workspace_id,id,form_id,received_at,status)
        SELECT ${workspaceId},entry.id,${formId},0,'needs_review'
        FROM unnest(${pendingSources}::uuid[]) AS entry(id)`;
      await tx`INSERT INTO portable_lead_form_note_sources(workspace_id,inquiry_id,form_id,form_revision,owner_id,job_id,state)
        SELECT ${workspaceId},entry.id,${formId},${capacitySkip.revision},${ownerId},gen_random_uuid(),'awaiting_contact'
        FROM unnest(${pendingSources}::uuid[]) AS entry(id)`;
    });
    assert.deepEqual(await expect(await send(formId,capacitySkip),200,'accept inquiry with a full Note admission backlog'),{accepted:true});
    const receipt=await readInquiry(capacitySkip.id);
    assert.equal(receipt.contactId,contactId);
    assert.equal(receipt.status,'linked');
    assert.equal(receipt.payload.message,capacitySkip.payload.message);
    const skipped=await getSource(capacitySkip.id);
    const reason='This workspace has too many pending form Notes.';
    assert.equal(skipped.state,'skipped');
    assert.equal(skipped.issue,reason);
    assert.equal(await getJob(skipped.job_id),undefined);

    await sql`DELETE FROM portable_lead_form_note_sources WHERE workspace_id=${workspaceId} AND inquiry_id=${pendingSources[0]}`;
    assert.deepEqual(await expect(await send(formId,capacitySkip),200,'replay the saved inquiry after capacity frees'),{accepted:true});
    assert.deepEqual(await readInquiry(capacitySkip.id),receipt);
    assert.deepEqual(await getSource(capacitySkip.id),skipped);

    const query=new URLSearchParams({filter:'note_issues',inquirySearch:capacitySkip.payload.email});
    const scoped=manager+'?formId='+formId+'&'+query;
    const workspace=manager+'?inquiries=workspace&'+query;
    const issues=async()=>(await expect(await request(workspace,{headers}),200,'read workspace Note issues')).results;
    const checkIssue=async()=>{
      const rows=await issues();
      assert.equal(rows.length,1);
      const [row]=rows;
      assert.equal(row.id,capacitySkip.id);
      assert.equal(row.noteAutomation.status,'skipped');
      assert.equal(row.noteAutomation.issue,reason);
      assert.equal(row.noteAutomation.attentionJobId,undefined);
    };
    await checkIssue();
    assert.equal((await request(scoped,{headers:other})).status,404);
    assert.deepEqual((await expect(await request(workspace,{headers:other}),200,'read only the current workspace’s Note issues')).results,[]);
    const issueHtml=await request('/?view=forms&inquiries=workspace&'+query,{headers});
    assert.equal(issueHtml.status,200);
    const rendered=await issueHtml.text();
    assert.match(rendered,/Note skipped because the workspace has too many pending form Notes\. Add a Note manually if needed, then mark this inquiry handled\./);
    assert.doesNotMatch(rendered,/Open Note job/);

    const triage={action:'setInquiryHandled',formId,submissionId:capacitySkip.id,handled:true,triageRevision:receipt.triageRevision};
    await expect(await action(triage),200,'mark the skipped Note inquiry handled');
    assert.deepEqual(await issues(),[]);
    assert.equal((await readInquiry(capacitySkip.id)).noteAutomation.issue,reason);
    await expect(await action({...triage,handled:false,triageRevision:receipt.triageRevision+1}),200,'reopen the skipped Note inquiry');
    await checkIssue();
    assert.deepEqual(await getSource(capacitySkip.id),skipped);
    assert.equal(await getJob(skipped.job_id),undefined);
  }finally{
    const ids=[...pendingSources,capacitySkip.id];
    await sql.begin(async tx=>{
      await tx`DELETE FROM portable_lead_form_note_sources WHERE workspace_id=${workspaceId} AND inquiry_id=ANY(${ids}::uuid[])`;
      await tx`DELETE FROM portable_lead_inquiries WHERE workspace_id=${workspaceId} AND id=ANY(${ids}::uuid[])`;
    });
  }

  const [retried,firstReady,stillWaiting]=Array.from({length:3},()=>submission(first.payload.email));
  const backlog=[retried,firstReady,stillWaiting];
  for(const input of backlog)await expect(await send(formId,input),200,'build a below-cap form Note backlog');
  const backlogSources=await Promise.all(backlog.map(input=>assertWaiting(input,contactId)));
  await sql`UPDATE portable_lead_form_note_sources
    SET next_at=CASE inquiry_id WHEN ${retried.id}::uuid THEN 0 WHEN ${firstReady.id}::uuid THEN 1 ELSE 2 END,
      retry_at=CASE WHEN inquiry_id=${retried.id}::uuid THEN 3 ELSE NULL END
    WHERE workspace_id=${workspaceId} AND inquiry_id=ANY(${backlog.map(input=>input.id)}::uuid[])`;
  await worker(env);
  assert.equal((await getSource(firstReady.id)).state,'queued','An earlier retry takes its effective ready time.');
  const [delayed]=await sql`SELECT next_at,retry_at FROM portable_lead_form_note_sources
    WHERE workspace_id=${workspaceId} AND inquiry_id=${retried.id}`;
  assert.deepEqual({...delayed},{next_at:'0',retry_at:'3'},'The original due time remains available for overdue alerts.');

  const quiet=submission(otherInquiry.payload.email);
  await expect(await send(otherForm,quiet),200,'accept a quiet workspace inquiry behind the existing backlog');
  const quietSource=await source(sql,otherWorkspaceId,quiet.id);
  assert.equal(quietSource?.state,'waiting');
  await worker(env);
  assert.equal((await source(sql,otherWorkspaceId,quiet.id)).state,'queued','The quiet workspace gets the next promotion turn.');
  assert.equal((await job(sql,otherWorkspaceId,quietSource.job_id)).status,'succeeded');
  assert.equal((await getSource(retried.id)).state,'waiting');
  assert.equal((await getSource(stillWaiting.id)).state,'waiting');
  await expect(await action({action:'setEnabled',id:otherForm,revision:2,enabled:false},other),200,'close second workspace fixture');
  await drain(backlog,backlogSources);

  const reviewed=submission('review-'+formId+'@example.test');
  const saveContact=async(data,record)=>(await expect(await post(request,origin,headers,'/api/crm',{
    action:'save',kind:'contacts',data,...(record?{id:record.id,expectedRevision:record.revision}:{}),
  }),record?200:201,'save synthetic Contact for inquiry review')).record;
  const matched=await saveContact({name:'First fictional match',email:reviewed.payload.email});
  const duplicate=await saveContact({name:'Duplicate fictional match',email:reviewed.payload.email});
  await expect(await send(formId,reviewed),200,'accept ambiguous inquiry without choosing a Contact');
  const needsReview=await readInquiry(reviewed.id);
  assert.equal(needsReview.status,'needs_review');
  assert.equal(needsReview.contactId,null);
  assert.deepEqual(needsReview.noteAutomation,{status:'awaiting_contact',issue:null});
  const awaiting=await getSource(reviewed.id);
  assert.equal(awaiting.contact_id,null);
  assert.equal(await getJob(awaiting.job_id),undefined);
  const retry={action:'retry',formId,submissionId:reviewed.id};
  await expect(await action(retry,other),404,'deny nonowner inquiry retry');
  await saveContact({...duplicate.data,email:'resolved-'+formId+'@example.test'},duplicate);
  for(const response of await Promise.all([action(retry),action(retry)]))await expect(response,200,'retry ambiguous inquiry once');
  const reviewedSource=await assertWaiting(reviewed,matched.id);
  assert.equal(reviewedSource.job_id,awaiting.job_id);
  await drain([reviewed],[reviewedSource]);

  const archiveRoundTrip=submission('archive-'+formId+'@example.test');
  await expect(await send(formId,archiveRoundTrip),200,'accept inquiry before Contact archive');
  const archiveSource=await getSource(archiveRoundTrip.id);
  const recycle=(action,id,expectedRevision)=>post(request,origin,headers,'/api/recycle-bin',
    {action,id,expectedRevision,requestId:randomUUID()});
  const archived=await expect(await recycle('archive',archiveSource.contact_id,1),200,'archive pending Contact');
  await expect(await recycle('restore',archiveSource.contact_id,archived.receipt.revision),200,'restore before worker pass');
  assert.equal((await readInquiry(archiveRoundTrip.id)).noteAutomation.status,'skipped');
  await worker(env);
  assert.equal(await getJob(archiveSource.job_id),undefined);

  const removed=submission(first.payload.email),disabled=submission(first.payload.email);
  for(const input of [removed,disabled])await expect(await send(formId,input),200,'accept pending inquiry for fencing');
  const removedSource=await assertWaiting(removed,contactId),disabledSource=await assertWaiting(disabled,contactId);
  // An unexpired synthetic claim lets intake promote, while blocking Note execution in this workspace.
  await sql`UPDATE portable_lead_form_note_sources SET retry_at=9999999999999
    WHERE workspace_id=${workspaceId} AND inquiry_id=${disabled.id}`;
  const blockId=randomUUID();
  await sql`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,
      created_at,status,attempts,lease_token,lease_until)
    VALUES(${workspaceId},${blockId},${contactId},${ownerId},'note','Fictional active claim',0,0,0,'running',
      1,${randomUUID()},9999999999999)`;
  try{
    await untilWorker(env,async()=>(await getSource(removed.id))?.state==='queued','Promotion should persist a queued source.');
    assert.equal((await getJob(removedSource.job_id)).status,'queued');
    const remove={action:'removeInquiry',formId,submissionId:removed.id};
    await expect(await action(remove,other),404,'deny nonowner inquiry removal');
    await expect(await action(remove),200,'remove inquiry after promotion, before execution');
    assert.equal((await readInquiry(removed.id)).status,'removed');
    await expect(await send(formId,removed),200,'replay removed inquiry without rebuilding work');
    await expect(await enable(formId,2,false),200,'switch form Off before executing queued work');
  }finally{
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${workspaceId} AND id=${blockId}`;
  }
  assert.equal((await send(formId,submission(first.payload.email,3))).status,404);
  await ready(sql,workspaceId,[removed.id,disabled.id]);
  await worker(env);
  await expect(await enable(formId,3,true),200,'reactivate with a new revision');
  const changed=submission(first.payload.email,4);
  await expect(await send(formId,changed),200,'accept inquiry before changing Note definition');
  const changedSource=await assertWaiting(changed,contactId);
  await expect(await save(formId,4,{...definition,automationNote:label+' revised'}),200,'change the form definition');
  const fenced=[removedSource,disabledSource,changedSource];
  await ready(sql,workspaceId,fenced.map(row=>row.inquiry_id));
  await untilWorker(env,async()=>(await Promise.all(fenced.map(async row=>{
    const current=await getSource(row.inquiry_id);
    const stopped=await getJob(row.job_id);
    return (!current||current.state==='skipped')&&(!stopped||stopped.status==='skipped');
  }))).every(Boolean),'All invalidated inquiry sources must stop.');
  assert.deepEqual(Array.from(await getNotes(fenced.map(row=>row.job_id))),[]);
  for(const row of fenced){
    const stopped=await getJob(row.job_id);
    assert.ok(!stopped||stopped.status==='skipped');
  }
  assert.equal((await readInquiry(disabled.id)).noteAutomation.status,'skipped');
  assert.equal((await readInquiry(changed.id)).noteAutomation.status,'skipped');
  const intentionallySkipped=await expect(await request(manager+'?formId='+formId+'&filter=note_issues',{headers}),200,
    'read Note issues after intentional skips');
  assert.deepEqual(intentionallySkipped.results,[]);

  const pending=submission(first.payload.email,5);
  await expect(await send(formId,pending),200,'leave one waiting inquiry for the isolated restore');
  const pendingSource=await assertWaiting(pending,contactId);
  // Ordinary recovery workers exercise other jobs before this fixture advances its source.
  await sql`UPDATE portable_lead_form_note_sources SET retry_at=9999999999999
    WHERE workspace_id=${workspaceId} AND inquiry_id=${pending.id}`;
  return {workspaceId,formId,pendingId:pending.id,pendingJobId:pendingSource.job_id,completed};
}

export async function verifyRestoredPortableFormNotes({request,origin,owner,sql,env,fixture}){
  const {workspaceId,formId,pendingId,pendingJobId,completed}=fixture;
  const getNotes=()=>notes(sql,workspaceId,completed.map(row=>row.job_id));
  const list=async()=>await expect(await request(manager,{headers:owner}),200,'read restored forms');
  const form=(await list()).forms.find(row=>row.id===formId);
  assert.ok(form);
  assert.equal(form.enabled,false);
  assert.deepEqual(Array.from(await getNotes()),completed);
  const pending=await source(sql,workspaceId,pendingId);
  assert.equal(pending?.job_id,pendingJobId);
  assert.equal(pending?.state,'waiting');
  assert.equal(await job(sql,workspaceId,pendingJobId),undefined);
  await ready(sql,workspaceId,[pendingId]);
  await untilWorker(env,async()=>(await source(sql,workspaceId,pendingId))?.state==='skipped',
    'The restored worker must stop pending work whose activation was not restored.');
  assert.equal((await source(sql,workspaceId,pendingId)).issue,'form_automation_changed');
  await expect(await post(request,origin,owner,manager,{action:'setEnabled',id:formId,
    revision:form.revision,enabled:true}),200,'reactivate restored form with a new revision');
  await ready(sql,workspaceId,[pendingId]);
  await worker(env);
  await worker(env);
  const stopped=await job(sql,workspaceId,pendingJobId);
  assert.ok(!stopped||stopped.status==='skipped');
  assert.deepEqual(Array.from(await notes(sql,workspaceId,[pendingJobId])),[]);
  assert.deepEqual(Array.from(await getNotes()),completed);
}
