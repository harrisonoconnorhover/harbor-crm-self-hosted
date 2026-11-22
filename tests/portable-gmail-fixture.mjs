import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const execute=promisify(execFile);
const workerBundle=new URL('../.harbor/portable-build/worker/worker.mjs',import.meta.url).href;
const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
const cwd=process.env.HARBOR_TEST_PORTABLE_CWD;

export async function verifyRestoredGmailReconciliation({sql,env,workspaceId,id}){
  const read=async()=>(await sql`SELECT j.status,j.issue,j.scheduled_for,j.attempts,m.dispatch_started_at,m.provider_id
    FROM portable_jobs j JOIN portable_scheduled_gmail m ON (j.workspace_id,j.id)=(m.workspace_id,m.job_id)
    WHERE j.workspace_id=${workspaceId} AND j.id=${id}`)[0];
  const before=await read();
  assert.equal(before.status,'attention');
  assert.equal(before.issue,'restore_requires_reconciliation');
  assert.equal(before.dispatch_started_at,null);
  const messageId='<harbor.'+id+'@'+workspaceId+'.harbor.invalid>';
  const scheduledSeconds=Math.floor(Number(before.scheduled_for)/1000);
  const run=mode=>{
    const provider='data:text/javascript,'+encodeURIComponent(`
      import assert from 'node:assert/strict';
      const sentAt=${scheduledSeconds+14*60},mode=${JSON.stringify(mode)},messageId=${JSON.stringify(messageId)};
      globalThis.fetch=async(input,init)=>{
        assert.notEqual(mode,'confirmed');
        const url=new URL(input);
        if(url.href==='https://oauth2.googleapis.com/token'&&init.method==='POST'){
          return Response.json({access_token:'fictional',expires_in:3600,token_type:'Bearer'});
        }
        assert.equal(init.method??'GET','GET','Reconciliation must never send mail.');
        assert.equal(url.origin,'https://gmail.googleapis.com');
        if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'owner@example.test'});
        if(url.pathname.endsWith('/messages')){
          const query=url.searchParams.get('q');
          if(query==='in:sent rfc822msgid:'+messageId)return Response.json({});
          const window=/^in:sent after:([0-9]+) before:([0-9]+)$/.exec(query);
          assert.deepEqual(window?.slice(1).map(Number),[${scheduledSeconds-300},${scheduledSeconds+1200}]);
          assert.ok(+window[1]<sentAt&&sentAt<+window[2]);
          assert.equal(url.searchParams.get('maxResults'),'25');
          return Response.json({messages:[{id:'fixture-recovered'}],...(mode==='overflow'?{nextPageToken:'more'}:{})});
        }
        assert.ok(url.pathname.endsWith('/messages/fixture-recovered'));
        assert.notEqual(mode,'overflow');
        assert.equal(url.searchParams.get('metadataHeaders'),'X-Harbor-Message-ID');
        return Response.json({id:'fixture-recovered',labelIds:['SENT'],payload:{headers:[{name:'X-Harbor-Message-ID',value:messageId}]}});
      };
    `);
    return execute(process.execPath,['--import',provider,command,'gmail-reconcile',workspaceId,id],{
      cwd,timeout:9_000,env:{...env,HARBOR_PORTABLE_GMAIL_ENABLED:'true',HARBOR_PORTABLE_GMAIL_OWNER:'owner@example.test',
        HARBOR_PORTABLE_GMAIL_CLIENT_ID:'fictional',HARBOR_PORTABLE_GMAIL_CLIENT_SECRET:'fictional',
        HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN:'fictional'},
    });
  };
  await assert.rejects(run('overflow'),{code:1});
  assert.deepEqual(await read(),before);
  for(const mode of ['single','confirmed']){
    const {stdout}=await run(mode);
    assert.equal(JSON.parse(stdout).result,'confirmed');
    assert.deepEqual(await read(),{...before,status:'succeeded',issue:null,provider_id:'fixture-recovered'});
  }
}

export async function verifyPortableGmailDisabled({request,origin,headers,record}){
  const response=await request('/api/background-jobs?recordId='+record.id,{method:'POST',headers:{
    ...headers,origin,'content-type':'application/json',
  },body:JSON.stringify({kind:'gmail',id:randomUUID(),recipient:'disabled@example.test',subject:'Disabled fixture',body:'Fixture',scheduledFor:Date.now()})});
  assert.equal(response.status,403);
  const workflow=(body)=>request('/api/workflows',{method:'POST',headers:{
    ...headers,origin,'content-type':'application/json',
  },body:JSON.stringify(body)});
  const id=randomUUID(),definition={name:'Disabled workflow fixture',trigger:'contact_lifecycle',lifecycle:'Subscriber',
    actionKind:'gmail',subject:'Fixture subject',body:'Fixture body',delayMinutes:5};
  assert.equal((await workflow({action:'save',id,revision:0,definition})).status,200);
  assert.equal((await workflow({action:'setEnabled',id,revision:1,enabled:true})).status,403);
}

export async function verifyPortableScheduledGmail({request,origin,headers,other,sql,env,sharing,directory}){
  const settings=join(directory,'gmail-mode.json'),log=join(directory,'gmail-calls.jsonl'),resume=join(directory,'gmail-resume');
  const sendResume=join(directory,'gmail-send-resume');
  const mock=join(directory,'gmail-fetch.mjs');
  await writeFile(log,'');
  await writeFile(mock,`
    import assert from 'node:assert/strict';
    import {appendFileSync,existsSync,readFileSync} from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    const {HARBOR_TEST_GMAIL_SETTINGS:settings,HARBOR_TEST_GMAIL_LOG:log,HARBOR_TEST_GMAIL_RESUME:resume,
      HARBOR_TEST_GMAIL_SEND_RESUME:sendResume}=process.env;
    globalThis.fetch=async (resource,init={})=>{
      const {mode,match}=JSON.parse(readFileSync(settings,'utf8')),url=new URL(resource);
      const note=(kind,extra={})=>appendFileSync(log,JSON.stringify({kind,...extra})+'\\n');
      if(url.href==='https://oauth2.googleapis.com/token'){
        note('refresh');
        assert.equal(init.body.get('refresh_token'),'fictional-refresh');
        if(mode==='refresh_unavailable')throw TypeError('Fictional outage');
        if(mode==='revoked')return Response.json({error:'invalid_grant',error_description:'Private Gmail fixture'}, {status:400});
        const scope=mode==='missing_send_scope'?{scope:'https://www.googleapis.com/auth/gmail.readonly'}:{};
        return Response.json({access_token:'fictional-access',expires_in:3600,token_type:'Bearer',...scope});
      }
      assert.equal(url.origin,'https://gmail.googleapis.com');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer fictional-access');
      if(url.pathname.endsWith('/profile')){
        note('profile');
        if(mode==='profile_rate_limited')return new Response(null,{status:429});
        if(mode==='hold_profile'||mode==='hold_profile_and_send'){
          for(let tries=0;tries<300&&!existsSync(resume);tries++)await delay(10);
          assert.ok(existsSync(resume));
        }
        return Response.json({emailAddress:mode==='wrong_mailbox'?'wrong@example.test':'owner@example.test'});
      }
      if(url.pathname.endsWith('/messages/send')){
        assert.equal(init.method,'POST');
        const mime=Buffer.from(JSON.parse(init.body).raw,'base64url').toString('utf8');
        note('send',{mime});
        if(mode==='hold_profile_and_send'){
          for(let tries=0;tries<550&&!existsSync(sendResume);tries++)await delay(10);
          assert.ok(existsSync(sendResume));
        }
        if(mode==='lost_receipt')throw TypeError('Fictional accepted send lost its response');
        if(mode==='crash')process.exit(9);
        return Response.json({id:'fictional-accepted'});
      }
      if(url.pathname.endsWith('/messages')){
        assert.equal(init.method??'GET','GET');
        const query=url.searchParams.get('q');
        note('lookup',{query});
        if(query==='in:sent rfc822msgid:'+match)return Response.json({messages:[{id:'fictional-reconciled'}]});
        return url.searchParams.get('fields')?.split(',').includes('resultSizeEstimate')?
          Response.json({resultSizeEstimate:0}):new Response(null,{status:200});
      }
      throw Error('Unexpected provider endpoint in local Gmail fixture');
    };
  `);
  const workerEnv={...env,HARBOR_PORTABLE_MODE:'local',HARBOR_PORTABLE_GMAIL_CLIENT_ID:'fictional-client',
    HARBOR_PORTABLE_GMAIL_CLIENT_SECRET:'fictional-secret',HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN:'fictional-refresh',
    HARBOR_TEST_GMAIL_SETTINGS:settings,HARBOR_TEST_GMAIL_LOG:log,HARBOR_TEST_GMAIL_RESUME:resume,HARBOR_TEST_GMAIL_SEND_RESUME:sendResume};
  const mode=(value,match)=>writeFile(settings,JSON.stringify({mode:value,match}));
  const calls=async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const waitForCall=async kind=>{
    for(let poll=0;poll<100;poll++){
      if((await calls()).some(call=>call.kind===kind))return;
      await delay(20);
    }
    assert.fail('Timed out waiting for fictional Gmail '+kind);
  };
  const runWith=(overrides,...args)=>execute(process.execPath,['--import',mock,command,...args],{
    env:{...workerEnv,...overrides},cwd,timeout:8_000,
  });
  const run=(...args)=>runWith({},...args);
  const one=(overrides={})=>runWith(overrides,'worker','--once');
  const post=(path,auth,body)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const jobsPath=id=>'/api/background-jobs?recordId='+id;
  const enqueue=(contact,input,auth=headers,scope='')=>post(jobsPath(contact.id)+scope,auth,input.kind==='gmail'?{recipient:contact.data.email,...input}:input);
  const payload=(subject,scheduledFor=Date.now())=>({kind:'gmail',id:randomUUID(),subject,body:'Fictional plain-text email.',scheduledFor});
  const create=async email=>{
    const response=await post('/api/crm',headers,{action:'save',kind:'contacts',data:{name:'Scheduled Gmail fixture',email}});
    assert.equal(response.status,201);
    return (await response.json()).record;
  };
  const read=async id=>(await sql`SELECT j.status,j.issue,j.attempts,m.provider_id,m.dispatch_started_at FROM portable_jobs j
    JOIN portable_scheduled_gmail m ON m.workspace_id=j.workspace_id AND m.job_id=j.id WHERE j.id=${id}`)[0];
  const attemptReceipts=async id=>Array.from(await sql`SELECT number,outcome FROM portable_job_attempts WHERE job_id=${id} ORDER BY number`);
  const cancel=(contact,id)=>enqueue(contact,{action:'cancelGmail',id});
  const block=email=>post('/api/email/suppressions',headers,{id:randomUUID(),email});
  const senderMail='portable-recipient@example.test';
  const emptyTimeline={items:[],lastContacted:null,lastActivity:null,next:null};
  const outreachPath=(contact,filters={})=>'/api/logged-activities?'+new URLSearchParams({contactId:contact.id,...filters});
  const timeline=async(contact,filters={},auth=headers)=>{
    const response=await request(outreachPath(contact,filters),{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const acceptedActivity=async(contact,job,receipt)=>{
    assert.notEqual(receipt.dispatch_started_at,null);
    const at=Number(receipt.dispatch_started_at);
    const page=await timeline(contact);
    assert.equal(page.items.length,1);
    const {id,...activity}=page.items[0];
    assert.match(id,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.deepEqual(activity,{kind:'Email',revision:1,occurredAt:at,summary:'Gmail accepted this scheduled email.',
      fromScheduledGmail:true,scheduledJobId:job.id});
    assert.deepEqual([page.lastContacted,page.lastActivity,page.next],[at,at,null]);
    return page.items[0];
  };

  // This synthetic scenario has its own request window. The rate-limit fixture checks the real cap separately.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  await mode('confirmed');
  const contact=await create(senderMail);
  assert.equal((await enqueue(contact,payload('Editor denied'),other,
    '&workspaceId='+sharing.workspaceId+'&grantId='+sharing.grantId)).status,403);
  const templateEndpoint='/api/email/templates',templateId=randomUUID();
  const writeTemplate=(method,body)=>request(templateEndpoint,{method,headers:{...headers,origin,
    'content-type':'application/json'},body:JSON.stringify(body)});
  const source={id:templateId,name:'Fictional scheduled template',subject:'Template snapshot for {{contact.name}}',body:'Original template body for {{record.email}}.'};
  assert.equal((await writeTemplate('PUT',source)).status,201);
  const preview=await request(templateEndpoint+'?'+new URLSearchParams({id:templateId,contactId:contact.id}),{headers});
  assert.equal(preview.status,200);
  const {template:resolved,missing}=await preview.json();
  assert.deepEqual(missing,[]);
  assert.equal(resolved.subject,'Template snapshot for Scheduled Gmail fixture');
  assert.equal(resolved.body,'Original template body for '+senderMail+'.');
  const templateCopy={...payload(resolved.subject,Date.now()+3600_000),body:resolved.body};
  assert.equal((await enqueue(contact,templateCopy)).status,202);
  const longSubject='X'.repeat(182)+'{{record.email}}';
  assert.equal((await writeTemplate('PUT',{...source,subject:longSubject,body:'Changed later.',expectedRevision:0})).status,200);
  assert.equal((await request(templateEndpoint+'?'+new URLSearchParams({id:templateId,contactId:contact.id}),{headers})).status,400);
  assert.equal((await writeTemplate('DELETE',{id:templateId,expectedRevision:1})).status,200);
  assert.equal((await enqueue(contact,templateCopy)).status,202);
  const [storedCopy]=await sql`SELECT m.subject,j.body,m.recipient FROM portable_scheduled_gmail m
    JOIN portable_jobs j ON j.workspace_id=m.workspace_id AND j.id=m.job_id WHERE m.job_id=${templateCopy.id}`;
  assert.deepEqual(storedCopy,{subject:resolved.subject,body:resolved.body,recipient:senderMail});
  assert.deepEqual(await calls(),[]);
  assert.equal((await cancel(contact,templateCopy.id)).status,200);
  const scheduled=payload('Accepted scheduled email');
  assert.equal((await enqueue(contact,{...scheduled,recipient:'stale-address@example.test'})).status,409);
  assert.equal((await enqueue(contact,scheduled)).status,202);
  assert.equal((await enqueue(contact,scheduled)).status,202);
  assert.equal((await enqueue(contact,{...scheduled,subject:'Changed'})).status,409);
  const note={id:randomUUID(),body:'Note-only worker fixture',scheduledFor:Date.now()};
  assert.ok(note.scheduledFor>scheduled.scheduledFor,'Gmail is the earlier job in the same workspace');
  const enqueuedNote=await enqueue(contact,note);
  assert.equal(enqueuedNote.status,202,await enqueuedNote.clone().text());
  const queued=await read(scheduled.id);
  assert.deepEqual(queued,{status:'queued',issue:null,attempts:0,provider_id:null,dispatch_started_at:null});
  assert.deepEqual(await timeline(contact),emptyTimeline);
  const queue=async(auth,view='issues')=>{
    const response=await request('/?view=job-queue&queue='+view,{headers:auth});
    assert.equal(response.status,200);
    return response.text();
  };
  const gmailWorkerWarning=/No recent poll from a worker configured for Gmail/;
  const notesOnly=spawn(process.execPath,['--import',mock,command,'worker'],{
    env:{...workerEnv,HARBOR_PORTABLE_GMAIL_ENABLED:'false'},cwd,stdio:['ignore','ignore','inherit'],
  });
  const notesStopped=once(notesOnly,'exit');
  try{
    let reporting;
    for(let poll=0;poll<100;poll++){
      [reporting]=await sql`SELECT last_gmail_poll_at FROM portable_worker_heartbeat
        WHERE id=1 AND last_poll_at >= floor(extract(epoch FROM clock_timestamp())*1000)-30000
          AND EXISTS (SELECT 1 FROM portable_jobs WHERE id=${note.id} AND status='succeeded')`;
      if(reporting)break;
      await delay(50);
    }
    assert.equal(reporting?.last_gmail_poll_at,null);
    const ownerQueue=await queue(headers);
    assert.match(ownerQueue,/Worker reporting/);
    assert.match(ownerQueue,gmailWorkerWarning);
    assert.match(ownerQueue,/Scheduled email is due/);
    assert.doesNotMatch(await queue(other),gmailWorkerWarning);
    await sql`UPDATE portable_jobs SET available_at=9223372036854775807 WHERE id=${scheduled.id}`;
    try{
      const upcoming=await queue(headers);
      assert.match(upcoming,gmailWorkerWarning);
      assert.match(upcoming,/Scheduled email is waiting/);
      assert.doesNotMatch(upcoming,/Scheduled email is due/);
      assert.doesNotMatch(await queue(other),gmailWorkerWarning);
    }
    finally{await sql`UPDATE portable_jobs SET available_at=${scheduled.scheduledFor} WHERE id=${scheduled.id}`;}
  }finally{
    notesOnly.kill('SIGTERM');
    assert.deepEqual(await notesStopped,[0,null]);
  }
  assert.deepEqual(await read(scheduled.id),queued);
  assert.deepEqual(await attemptReceipts(scheduled.id),[]);
  assert.deepEqual((await sql`SELECT status,attempts FROM portable_jobs WHERE id=${note.id}`)[0],{status:'succeeded',attempts:1});
  const workspaceTurn=async()=>(await sql`SELECT last_job_claim_at FROM private_workspaces WHERE id=${sharing.workspaceId}`)[0];
  const afterNote=await workspaceTurn();
  await one({HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN:''});
  assert.deepEqual(await workspaceTurn(),afterNote,'an unconfigured worker does not take the workspace turn for Gmail');
  assert.deepEqual(await read(scheduled.id),queued);
  assert.deepEqual(await attemptReceipts(scheduled.id),[]);
  assert.deepEqual(await calls(),[]);
  await mode('hold_profile_and_send');
  const sending=execute(process.execPath,['--import',mock,'--input-type=module','--eval',`
    import {portableDb,runPortableJobPass} from ${JSON.stringify(workerBundle)};
    const db=portableDb();
    let pollAt;
    try{
      const processed=await runPortableJobPass(db,undefined,undefined,undefined,false,undefined,at=>{pollAt=at;});
      console.log(JSON.stringify({processed,pollAt}));
    }finally{await db.$client.end({timeout:5});}
  `],{env:workerEnv,cwd,timeout:8_000});
  void sending.catch(()=>{});
  let releaseAt;
  try{
    await waitForCall('profile');
    const readClaim=async()=>(await sql`SELECT j.status,j.attempts,j.lease_token,j.lease_until::float8 AS until,
        a.started_at::float8 AS started,a.ended_at,a.outcome
      FROM portable_jobs j JOIN portable_job_attempts a ON a.workspace_id=j.workspace_id AND a.job_id=j.id AND a.number=1
      WHERE j.workspace_id=${sharing.workspaceId} AND j.id=${scheduled.id}`)[0];
    const initialClaim=await readClaim();
    assert.equal(initialClaim.status,'running');
    assert.equal(initialClaim.until-initialClaim.started,45_000);
    // Age the fictional claim past 30s while keeping its original duration.
    await sql.begin(async tx=>{
      await tx`UPDATE portable_job_attempts SET started_at=started_at-31000
        WHERE workspace_id=${sharing.workspaceId} AND job_id=${scheduled.id} AND number=1`;
      await tx`UPDATE portable_jobs SET lease_until=lease_until-31000
        WHERE workspace_id=${sharing.workspaceId} AND id=${scheduled.id}`;
    });
    const agedClaim={...initialClaim,started:initialClaim.started-31_000,until:initialClaim.until-31_000};
    const [{now}]=await sql`SELECT floor(extract(epoch from clock_timestamp())*1000)::float8 AS now`;
    assert.ok(now-agedClaim.started>30_000&&now<agedClaim.until);
    await one();
    assert.deepEqual(await readClaim(),agedClaim);
    assert.deepEqual(await attemptReceipts(scheduled.id),[{number:1,outcome:null}]);
    assert.deepEqual((await calls()).map(call=>call.kind),['refresh','profile']);
    const [{deadline}]=await sql`UPDATE portable_jobs SET lease_until=floor(extract(epoch from clock_timestamp())*1000)+2000
      WHERE id=${scheduled.id} AND status='running' RETURNING lease_until::float8 AS deadline`;
    await writeFile(resume,'continue');
    await waitForCall('send');
    const [lease]=await sql`SELECT j.lease_until::float8 AS until,m.dispatch_started_at::float8 AS started
      FROM portable_jobs j JOIN portable_scheduled_gmail m ON m.workspace_id=j.workspace_id AND m.job_id=j.id
      WHERE j.id=${scheduled.id} AND j.status='dispatching'`;
    assert.equal(lease.until-lease.started,30_000);
    assert.ok(lease.started<deadline);
    await delay(Math.max(0,deadline-Date.now()+50));
    const [{expired}]=await sql`SELECT extract(epoch from clock_timestamp())*1000>=${deadline} AS expired`;
    assert.equal(expired,true);
    await one();
    assert.equal((await read(scheduled.id)).status,'dispatching');
    assert.equal((await calls()).filter(call=>call.kind==='send').length,1);
    assert.deepEqual(await timeline(contact),emptyTimeline);
    [{at:releaseAt}]=await sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS at`;
  }finally{
    await Promise.all([writeFile(resume,'continue'),writeFile(sendResume,'continue')]);
    await sending;
    await rm(resume,{force:true});
  }
  await one();
  const accepted=await read(scheduled.id);
  assert.deepEqual([accepted.status,accepted.provider_id],['succeeded','fictional-accepted']);
  assert.deepEqual(await attemptReceipts(scheduled.id),[{number:1,outcome:'succeeded'}]);
  const {processed,pollAt}=JSON.parse((await sending).stdout);
  const [{finished,observed}]=await sql`SELECT finished_at::float8 AS finished,
      floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS observed
    FROM portable_jobs WHERE id=${scheduled.id}`;
  assert.equal(processed,true);
  assert.ok(finished>=releaseAt,'The success receipt must follow the held Gmail response.');
  assert.ok(Number.isSafeInteger(pollAt)&&pollAt>=finished&&pollAt<=observed,
    'A successful Gmail poll must use the database clock after the job finishes.');
  const deliveredActivity=await acceptedActivity(contact,scheduled,accepted);
  const acceptedDay=new Date(deliveredActivity.occurredAt).toISOString().slice(0,10);
  const acceptedTimeline={items:[deliveredActivity],lastContacted:deliveredActivity.occurredAt,
    lastActivity:deliveredActivity.occurredAt,next:null};
  assert.deepEqual(await timeline(contact,{channel:'Email',from:acceptedDay,to:acceptedDay}),acceptedTimeline);
  const previousDay=new Date(deliveredActivity.occurredAt-86400_000).toISOString().slice(0,10);
  for(const filter of [{channel:'Call'},{channel:'Email',to:previousDay},
    {afterAt:deliveredActivity.occurredAt,afterId:deliveredActivity.id}]){
    assert.deepEqual(await timeline(contact,filter),{...acceptedTimeline,items:[]});
  }
  assert.equal((await post(outreachPath(contact),headers,{action:'remove',id:deliveredActivity.id,expectedRevision:1})).status,404);
  assert.equal((await request(outreachPath(contact,{history:deliveredActivity.id}),{headers})).status,404);
  assert.equal((await request(outreachPath(contact),{headers:other})).status,404);
  assert.deepEqual(await timeline(contact,{workspaceId:sharing.workspaceId},other),emptyTimeline);
  assert.deepEqual((await calls()).map(call=>call.kind),['refresh','profile','send']);
  const [{mime}]=(await calls()).filter(call=>call.kind==='send');
  assert.match(mime,/From: owner@example\.test\r\nTo: portable-recipient@example\.test/);
  const messageId='<harbor.'+scheduled.id+'@'+sharing.workspaceId+'.harbor.invalid>';
  assert.ok(mime.includes('X-Harbor-Message-ID: '+messageId));
  const body=Buffer.from(mime.split('\r\n\r\n')[1].replaceAll('\r\n',''),'base64').toString('utf8');
  const footer=body.match(/^Unsubscribe from emails from this workspace: (\S+)$/m);
  assert.ok(footer,'The sent message contains an unsubscribe link.');
  const optOutLink=new URL(footer[1]);
  assert.equal(optOutLink.origin,origin);
  assert.equal(optOutLink.pathname,'/email/unsubscribe');
  assert.equal(optOutLink.search,'');
  assert.match(optOutLink.hash,/^#[A-Za-z0-9_-]{43}$/);
  const token=optOutLink.hash.slice(1);
  const [hash]=await sql`SELECT token_hash FROM portable_email_unsubscribe_tokens
    WHERE workspace_id=${sharing.workspaceId} AND email=${senderMail}`;
  assert.equal(hash.token_hash,createHash('sha256').update(token).digest('base64url'));

  const optedOutJob=payload('Opted out after scheduling');
  assert.equal((await enqueue(contact,optedOutJob)).status,202);
  const [followUp]=await sql`SELECT recipient FROM portable_scheduled_gmail
    WHERE workspace_id=${sharing.workspaceId} AND job_id=${optedOutJob.id}`;
  assert.equal(followUp.recipient,senderMail);
  const blockedNotice=/A recipient is on the Do not email list/;
  const pendingContactJob=async()=>{
    const response=await request(jobsPath(contact.id),{headers});
    assert.equal(response.status,200);
    return (await response.json()).items.find(item=>item.id===optedOutJob.id);
  };
  assert.equal((await pendingContactJob()).recipientBlocked,false);
  assert.doesNotMatch(await queue(headers,'pending'),blockedNotice);
  const suppressionRows=async()=>Array.from(await sql`SELECT id,email,created_at,recipient_opted_out_at FROM portable_email_suppressions
    WHERE workspace_id=${sharing.workspaceId} AND email=${senderMail}`);
  assert.deepEqual(await suppressionRows(),[]);
  const previewOptOut=await request(optOutLink.pathname);
  assert.equal(previewOptOut.status,200);
  const optOutPage=await previewOptOut.text();
  assert.match(optOutPage,/Unsubscribe from email/);
  assert.ok(!optOutPage.includes(senderMail));
  assert.deepEqual(await suppressionRows(),[]);
  assert.equal((await pendingContactJob()).recipientBlocked,false);
  let confirmedSuppression;
  for(let confirmation=0;confirmation<2;confirmation++){
    const reply=await post('/api/email/unsubscribe',{}, {token});
    assert.equal(reply.status,200);
    assert.deepEqual(await reply.json(),{unsubscribed:true});
    assert.match(reply.headers.get('cache-control'),/no-store/);
    const rows=await suppressionRows();
    assert.equal(rows.length,1);
    assert.ok(rows[0].recipient_opted_out_at);
    if(confirmedSuppression)assert.deepEqual(rows,confirmedSuppression);
    else confirmedSuppression=rows;
  }
  assert.equal((await enqueue(contact,payload('Opted-out before scheduling'))).status,409);
  assert.equal((await pendingContactJob()).recipientBlocked,true);
  assert.equal((await request(jobsPath(contact.id),{headers:other})).status,404);
  const flaggedQueue=await queue(headers,'pending');
  assert.match(flaggedQueue,blockedNotice);
  assert.ok(!flaggedQueue.includes(senderMail));
  assert.doesNotMatch(await queue(other,'pending'),blockedNotice);
  assert.equal((await read(optedOutJob.id)).status,'queued');
  await sql`UPDATE portable_jobs SET scheduled_for=0 WHERE id=${optedOutJob.id}`;
  await mode('refresh_unavailable');
  const beforeOptOut=await calls();
  await one();
  await one();
  const skipped=await read(optedOutJob.id);
  assert.equal((await pendingContactJob()).recipientBlocked,false);
  assert.deepEqual([skipped.status,skipped.issue,skipped.dispatch_started_at,skipped.provider_id],
    ['skipped','email_recipient_suppressed',null,null]);
  assert.deepEqual(await attemptReceipts(optedOutJob.id),[{number:1,outcome:'email_recipient_suppressed'}]);
  assert.deepEqual(await timeline(contact),acceptedTimeline);
  assert.deepEqual(await calls(),beforeOptOut,'An existing opt-out takes precedence over an expired send window and bypasses Gmail refresh.');
  const needsReview=await queue(headers);
  assert.ok(needsReview.includes(optedOutJob.id));
  assert.match(needsReview,/Recipient is on the do-not-email list/);
  assert.match(needsReview,/>Mark reviewed<\/button>/);
  assert.ok(!(await queue(other)).includes(optedOutJob.id));
  const reviewSuppressed={action:'reviewSuppressedGmail',id:optedOutJob.id,attempts:1};
  assert.equal((await enqueue(contact,reviewSuppressed,other)).status,404);
  assert.equal((await enqueue(contact,{...reviewSuppressed,attempts:0})).status,409);
  const reviewed=await enqueue(contact,reviewSuppressed);
  assert.equal(reviewed.status,200,await reviewed.clone().text());
  assert.equal((await reviewed.json()).result,'reviewed');
  const replay=await enqueue(contact,reviewSuppressed);
  assert.equal(replay.status,200);
  assert.equal((await replay.json()).result,'already');
  assert.ok(!(await queue(headers)).includes(optedOutJob.id));
  assert.match(await queue(headers,'all'),/Skipped · reviewed/);
  assert.deepEqual(await read(optedOutJob.id),skipped);
  assert.deepEqual(await attemptReceipts(optedOutJob.id),[{number:1,outcome:'email_recipient_suppressed'}]);
  assert.deepEqual(await calls(),beforeOptOut,'Review never contacts Gmail.');

  const guarded=await create('dispatch-guard@example.test');
  const waiting=payload('Opt-out during preflight');
  assert.equal((await enqueue(guarded,waiting)).status,202);
  await mode('hold_profile');
  const priorCalls=(await calls()).length;
  const inFlight=one();
  try{
    let profile=false;
    for(let poll=0;poll<100&&!profile;poll++){
      profile=(await calls()).slice(priorCalls).some(call=>call.kind==='profile');
      if(!profile)await delay(20);
    }
    assert.ok(profile);
    const blocked=await block(guarded.data.email);
    assert.equal(blocked.status,200,await blocked.text());
  }finally{await writeFile(resume,'continue');await inFlight;}
  assert.deepEqual([(await read(waiting.id)).status,(await read(waiting.id)).issue],['skipped','email_recipient_suppressed']);
  assert.equal((await calls()).filter(call=>call.kind==='send').length,1);

  const otherContact=await create('receipt-fixture@example.test');
  const cancelled=payload('Cancelled email',Date.now()+600_000);
  assert.equal((await enqueue(otherContact,cancelled)).status,202);
  assert.equal((await cancel(otherContact,cancelled.id)).status,200);
  assert.equal((await cancel(otherContact,cancelled.id)).status,200);
  assert.equal((await enqueue(otherContact,{...reviewSuppressed,id:cancelled.id,attempts:0})).status,409);
  assert.equal((await read(cancelled.id)).issue,'email_cancelled');
  const stale=payload('Old schedule');
  assert.equal((await enqueue(otherContact,stale)).status,202);
  const staleReceipt='/?view=job-queue&jobId='+stale.id;
  const beforeWindow=(await (await request(staleReceipt,{headers})).text());
  assert.match(beforeWindow,/Send window ends/);
  assert.doesNotMatch(beforeWindow,/Send window passed/);
  await sql`UPDATE portable_jobs SET scheduled_for=0 WHERE id=${stale.id}`;
  assert.match(await (await request(staleReceipt,{headers})).text(),/Send window passed/);
  assert.equal((await request(staleReceipt,{headers:other})).status,404);
  await mode('refresh_unavailable');
  const callsBeforeStale=await calls();
  await one();
  const expiredBeforeRefresh=await read(stale.id);
  assert.deepEqual([expiredBeforeRefresh.status,expiredBeforeRefresh.issue,expiredBeforeRefresh.dispatch_started_at,expiredBeforeRefresh.provider_id],
    ['failed','email_schedule_expired',null,null]);
  assert.deepEqual(await attemptReceipts(stale.id),[{number:1,outcome:'email_schedule_expired'}]);
  const staleResult=await (await request(staleReceipt,{headers})).text();
  assert.match(staleResult,/Send window expired before dispatch/);
  assert.doesNotMatch(staleResult,/Send window ends|Send window passed/);
  assert.deepEqual(await calls(),callsBeforeStale,'An already expired job bypasses even an unavailable Gmail refresh.');

  const revokedStale=payload('Old schedule with revoked mailbox');
  assert.equal((await enqueue(otherContact,revokedStale)).status,202);
  await sql`UPDATE portable_jobs SET scheduled_for=0 WHERE id=${revokedStale.id}`;
  await mode('revoked');
  await one();
  assert.deepEqual(await read(revokedStale.id),expiredBeforeRefresh);
  assert.deepEqual(await attemptReceipts(revokedStale.id),[{number:1,outcome:'email_schedule_expired'}]);
  assert.deepEqual(await calls(),callsBeforeStale,'An already expired job bypasses even a revoked Gmail refresh.');

  await mode('confirmed');
  const expiring=payload('Deadline passes during contact check');
  assert.equal((await enqueue(otherContact,expiring)).status,202);
  const beforeExpiry=await calls();
  const [{deadline}]=await sql`UPDATE portable_jobs
    SET scheduled_for=floor(extract(epoch from clock_timestamp())*1000)-896000
    WHERE id=${expiring.id} RETURNING (scheduled_for+900000)::float8 AS deadline`;
  let expiryRun;
  try{
    await sql.begin(async tx=>{
      await tx`LOCK TABLE contacts IN ACCESS EXCLUSIVE MODE`;
      const [{pid}]=await tx`SELECT pg_backend_pid() AS pid`;
      expiryRun=one();
      let blocked;
      for(let poll=0;poll<100&&!blocked;poll++){
        // The sequence-access lookup can be the first query to touch the contact.
        // Observe the actual read lock even when its query text or formatting changes.
        [blocked]=await sql`SELECT (extract(epoch from waitstart)*1000)::float8 AS started
          FROM pg_locks WHERE relation='public.contacts'::regclass AND mode='AccessShareLock'
          AND NOT granted AND waitstart IS NOT NULL AND ${pid}::int=ANY(pg_blocking_pids(pid))`;
        if(!blocked)await delay(20);
      }
      assert.ok(blocked&&blocked.started<deadline,'The worker passed the first deadline check before waiting on the contact.');
      await tx`SELECT pg_sleep(greatest(0,${deadline}::float8/1000-extract(epoch from clock_timestamp()))+0.05)`;
    });
  }finally{
    await expiryRun;
  }
  const expired=await read(expiring.id);
  assert.deepEqual([expired.status,expired.issue,expired.dispatch_started_at,expired.provider_id],
    ['failed','email_schedule_expired',null,null]);
  assert.deepEqual(await attemptReceipts(expiring.id),[{number:1,outcome:'email_schedule_expired'}]);
  assert.deepEqual((await calls()).slice(beforeExpiry.length).map(call=>call.kind),['refresh','profile']);

  const lateContact=await create('dispatch-commit-fixture@example.test');
  const lateCommit=payload('Deadline passes while committing dispatch');
  assert.equal((await enqueue(lateContact,lateCommit)).status,202);
  const beforeLateCommit=(await calls()).length;
  const gate=810683413;
  const [{deadline:lateDeadline}]=await sql`UPDATE portable_jobs
    SET scheduled_for=floor(extract(epoch from clock_timestamp())*1000)-895500
    WHERE id=${lateCommit.id} RETURNING (scheduled_for+900000)::float8 AS deadline`;
  await sql.unsafe(`CREATE FUNCTION harbor_test_gmail_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER harbor_test_gmail_commit_gate AFTER UPDATE ON portable_scheduled_gmail
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.job_id='${lateCommit.id}'::uuid AND OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NOT NULL)
      EXECUTE FUNCTION harbor_test_gmail_commit_gate()`).simple();
  let lateRun;
  try{
    await sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(${gate}::bigint)`;
      lateRun=one();
      void lateRun.catch(()=>{});
      let blocked;
      for(let poll=0;poll<150&&!blocked;poll++){
        [blocked]=await tx`SELECT (extract(epoch from clock_timestamp())*1000)::float8 AS at
          FROM pg_locks WHERE locktype='advisory' AND objid=${gate} AND NOT granted`;
        if(!blocked)await delay(20);
      }
      assert.ok(blocked&&blocked.at<lateDeadline,'The worker reached the dispatch commit gate before the deadline.');
      await tx`SELECT pg_sleep(greatest(0,${lateDeadline}::float8/1000-extract(epoch from clock_timestamp()))+0.05)`;
    });
  }finally{
    try{await lateRun;}
    finally{
      await sql.unsafe('DROP TRIGGER harbor_test_gmail_commit_gate ON portable_scheduled_gmail; DROP FUNCTION harbor_test_gmail_commit_gate()').simple();
    }
  }
  const late=await read(lateCommit.id);
  assert.ok(late.dispatch_started_at!==null&&Number(late.dispatch_started_at)<lateDeadline);
  assert.deepEqual([late.status,late.issue,late.attempts,late.provider_id],['attention','external_outcome_unknown',1,null]);
  await one();
  assert.deepEqual(await read(lateCommit.id),late);
  assert.deepEqual(await attemptReceipts(lateCommit.id),[{number:1,outcome:'external_outcome_unknown'}]);
  assert.deepEqual((await calls()).slice(beforeLateCommit).map(call=>call.kind),['refresh','profile']);

  for(const [providerMode,expectedCalls] of [
    ['wrong_mailbox',['refresh','profile']],['revoked',['refresh']],['missing_send_scope',['refresh']],
  ]){
    const failed=payload('Mailbox preflight fixture '+providerMode);
    assert.equal((await enqueue(otherContact,failed)).status,202);
    const before=(await calls()).length;
    await mode(providerMode);
    await one();
    const row=await read(failed.id);
    assert.deepEqual([row.status,row.issue,row.dispatch_started_at,row.provider_id],
      ['failed','gmail_reauthorization_required',null,null]);
    assert.deepEqual(await attemptReceipts(failed.id),[{number:1,outcome:'gmail_reauthorization_required'}]);
    assert.deepEqual((await calls()).slice(before).map(call=>call.kind),expectedCalls);
    const receipt=await (await request('/?view=job-queue&jobId='+failed.id,{headers})).text();
    assert.match(receipt,/Reconnect the scheduled Gmail mailbox before scheduling a new send/);
    assert.doesNotMatch(receipt,/Private Gmail fixture/);
  }
  assert.equal((await calls()).filter(call=>call.kind==='send').length,1);
  const changedContact=await create('old-address@example.test');
  const changedAddress=payload('Address changed after scheduling');
  assert.equal((await enqueue(changedContact,changedAddress)).status,202);
  const change=await post('/api/crm',headers,{action:'save',kind:'contacts',id:changedContact.id,
    expectedRevision:changedContact.revision,data:{...changedContact.data,email:'new-address@example.test'}});
  assert.equal(change.status,200);
  await mode('confirmed');
  await one();
  assert.equal((await read(changedAddress.id)).issue,'email_address_changed');
  assert.equal((await calls()).filter(call=>call.kind==='send').length,1);

  const cancelledRetry=payload('Cancelled after a preflight retry');
  assert.equal((await enqueue(otherContact,cancelledRetry)).status,202);
  await mode('refresh_unavailable');
  await one();
  assert.equal((await read(cancelledRetry.id)).status,'queued');
  assert.equal((await cancel(otherContact,cancelledRetry.id)).status,200);
  const [priorAttempt]=await sql`SELECT outcome FROM portable_job_attempts WHERE job_id=${cancelledRetry.id}`;
  assert.equal(priorAttempt.outcome,'processor_error');

  const unknown=payload('Unknown email');
  assert.equal((await enqueue(otherContact,unknown)).status,202);
  const beforeProfileLimit=(await calls()).length;
  await mode('profile_rate_limited');
  await one();
  assert.deepEqual(await read(unknown.id),{
    status:'queued',issue:'processor_error',attempts:1,dispatch_started_at:null,provider_id:null,
  });
  assert.deepEqual(await attemptReceipts(unknown.id),[{number:1,outcome:'processor_error'}]);
  assert.deepEqual((await calls()).slice(beforeProfileLimit).map(call=>call.kind),['refresh','profile']);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${unknown.id}`;
  await mode('lost_receipt');
  await one();
  await one();
  assert.deepEqual([(await read(unknown.id)).status,(await read(unknown.id)).attempts],['attention',2]);
  assert.deepEqual(await timeline(otherContact),emptyTimeline);
  assert.equal((await cancel(otherContact,unknown.id)).status,409);
  assert.equal((await calls()).filter(call=>call.kind==='send').length,2);
  await mode('no_match');
  const lookupStart=(await calls()).length;
  await assert.rejects(run('gmail-reconcile',sharing.workspaceId,unknown.id),error=>error.code===2);
  assert.equal((await read(unknown.id)).status,'attention');
  assert.equal((await calls()).slice(lookupStart).filter(call=>call.kind==='lookup').length,2);
  assert.equal((await calls()).filter(call=>call.kind==='send').length,2);
  const archive={id:otherContact.id,action:'archive',expectedRevision:otherContact.revision,requestId:randomUUID()};
  const beforeReview=await read(unknown.id),beforeCalls=await calls();
  assert.equal((await post('/api/recycle-bin',headers,archive)).status,409);
  assert.equal((await enqueue(otherContact,{action:'reviewGmail',id:unknown.id},other)).status,404);
  assert.equal((await enqueue(otherContact,{action:'reviewGmail',id:unknown.id})).status,200);
  const archived=await post('/api/recycle-bin',headers,archive);
  assert.equal(archived.status,200,await archived.clone().text());
  const {receipt}=await archived.json();
  assert.equal((await request('/api/crm?id='+otherContact.id,{headers})).status,404);
  assert.equal((await request(outreachPath(otherContact),{headers})).status,404);
  assert.deepEqual(await read(unknown.id),beforeReview);
  assert.deepEqual(await calls(),beforeCalls);
  const uncertainId='<harbor.'+unknown.id+'@'+sharing.workspaceId+'.harbor.invalid>';
  await mode('matched',uncertainId);
  await run('gmail-reconcile',sharing.workspaceId,unknown.id);
  await run('gmail-reconcile',sharing.workspaceId,unknown.id);
  assert.deepEqual([(await read(unknown.id)).status,(await read(unknown.id)).provider_id],['succeeded','fictional-reconciled']);
  assert.equal((await calls()).filter(call=>call.kind==='send').length,2);
  assert.equal((await post('/api/recycle-bin',headers,{...archive,action:'restore',expectedRevision:receipt.revision,
    requestId:randomUUID()})).status,200);
  const reconciledActivity=await acceptedActivity(otherContact,unknown,beforeReview);

  const sortQuery={kind:'contacts',search:'Scheduled Gmail fixture',sort:'outreach-newest',limit:1};
  const sortedContacts=async(query={},auth=headers)=>{
    const response=await request('/api/crm?'+new URLSearchParams({...sortQuery,...query}),{headers:auth});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  const newest=await sortedContacts();
  assert.deepEqual(newest.records.map(record=>record.id),[otherContact.id]);
  assert.equal(newest.next,`${otherContact.id}:${reconciledActivity.occurredAt}`);
  const older=await sortedContacts({after:newest.next});
  assert.deepEqual(older.records.map(record=>record.id),[contact.id]);
  assert.equal(older.next,`${contact.id}:${deliveredActivity.occurredAt}`);
  const sharedOrder=await sortedContacts({workspaceId:sharing.workspaceId},other);
  assert.equal(sharedOrder.next,`${sharedOrder.records[0].id}:none`);

  const views='/api/crm/views';
  const saved=await post(views,headers,{action:'create',kind:'contacts',name:'Gmail receipt dates',
    filters:{search:senderMail,sort:'outreach-newest'},columns:['name','lastContacted']});
  assert.equal(saved.status,201,await saved.clone().text());
  const {view}=await saved.json();
  const iso=new Date(deliveredActivity.occurredAt).toISOString();
  try{
    const page=await request('/?kind=contacts&savedView='+view.id,{headers});
    assert.equal(page.status,200);
    const html=await page.text();
    assert.match(html,/<th aria-sort="descending">Last contacted<\/th>/);
    assert.ok(html.includes('<td>'+iso+'</td>'));
    const csv=await request('/api/crm?export=csv&kind=contacts&savedView='+view.id,{headers});
    assert.equal(csv.status,200);
    assert.deepEqual((await csv.text()).trimEnd().split('\r\n'),[
      '"Record ID","Name","Last contacted"',`"${contact.id}","${contact.data.name}","${iso}"`,
    ]);
  }finally{
    assert.equal((await post(views,headers,{action:'delete',kind:'contacts',id:view.id,expectedRevision:view.revision})).status,200);
  }

  const tokens='/api/api-tokens';
  const issued=await post(tokens,headers,{name:'Gmail receipt scope fixture',objects:['contacts'],permission:'read',days:30});
  assert.equal(issued.status,201,await issued.clone().text());
  const {token:readToken,info}=await issued.json();
  try{
    const response=await request('/api/v1/records/contacts/'+contact.id,{headers:{authorization:'Bearer '+readToken}});
    assert.equal(response.status,200);
    const external=await response.json();
    assert.equal(external.lastContacted,null);
    assert.equal(external.lastActivity,null);
  }finally{
    assert.equal((await post(tokens,headers,{action:'revoke',id:info.id})).status,200);
  }

  const crash=payload('Crash at provider boundary');
  assert.equal((await enqueue(otherContact,crash)).status,202);
  await mode('crash');
  await assert.rejects(one(),error=>error.code===9);
  assert.equal((await read(crash.id)).status,'dispatching');
  assert.equal((await cancel(otherContact,crash.id)).status,409);
  await sql`UPDATE portable_jobs SET lease_until=0 WHERE id=${crash.id}`;
  await mode('confirmed');
  await one();
  await one();
  assert.equal((await read(crash.id)).status,'attention');
  assert.equal((await calls()).filter(call=>call.kind==='send').length,3);
  const visible=await (await request(jobsPath(otherContact.id),{headers})).json();
  assert.equal(visible.items.find(item=>item.id===unknown.id).gmail.providerId,'fictional-reconciled');
  const viewer=await (await request(jobsPath(otherContact.id)+'&workspaceId='+sharing.workspaceId,{headers:other})).json();
  assert.ok(viewer.items.every(item=>item.kind!=='gmail'));

  const restored=payload('Pending at restore',Date.now()+600_000);
  assert.equal((await enqueue(otherContact,restored)).status,202);
  assert.deepEqual(await timeline(otherContact),{items:[reconciledActivity],lastContacted:reconciledActivity.occurredAt,
    lastActivity:reconciledActivity.occurredAt,next:null});
  sharing.gmail={contactId:otherContact.id,queuedId:restored.id,confirmedId:unknown.id,crashId:crash.id,
    confirmedActivity:{contactId:otherContact.id,scheduledJobId:unknown.id,occurredAt:reconciledActivity.occurredAt,id:reconciledActivity.id}};

  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
  const ruleId=randomUUID(),duplicateRule=randomUUID(),workflow='/api/workflows';
  const definition={name:'Subscriber welcome fixture',trigger:'contact_lifecycle',lifecycle:'Subscriber',
    actionKind:'gmail',subject:'Welcome fixture',body:'Fictional workflow body.',delayMinutes:5};
  const saveRule=(id,revision=0)=>post(workflow,headers,{action:'save',id,revision,definition});
  const toggle=(id,revision,enabled)=>post(workflow,headers,{action:'setEnabled',id,revision,enabled});
  const edit=(record,changes,auth=headers,scope='')=>post('/api/crm'+scope,auth,
    {action:'save',kind:'contacts',id:record.id,expectedRevision:record.revision,data:{...record.data,...changes}});
  const transition=async(record,lifecycle,auth=headers,scope='')=>{
    const response=await edit(record,{lifecycle},auth,scope);
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).record;
  };
  const captured=async(record)=>(await sql`SELECT job_id,issue,created_at FROM portable_workflow_runs
    WHERE workspace_id=${sharing.workspaceId} AND workflow_id=${ruleId} AND contact_id=${record.id}
    AND contact_revision=${record.revision}`)[0];
  const runDue=async id=>{
    await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${id}`;
    await one();
    return read(id);
  };
  const sends=async()=>(await calls()).filter(call=>call.kind==='send');
  assert.equal((await saveRule(ruleId)).status,200);
  const contactBefore=await create('workflow-before-enable@example.test');
  await transition(contactBefore,'Subscriber');
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_workflow_runs WHERE workflow_id=${ruleId}`)[0].count,0);
  assert.equal((await toggle(ruleId,1,true)).status,200);
  assert.equal((await saveRule(ruleId,2)).status,409);
  assert.equal((await saveRule(duplicateRule)).status,200);
  assert.equal((await toggle(duplicateRule,1,true)).status,409);

  const owned=await create('workflow-fresh@example.test');
  const first=await transition(owned,'Subscriber');
  assert.equal((await edit(owned,{lifecycle:'Subscriber'})).status,409);
  const initial=await captured(first);
  const [scheduledAt]=await sql`SELECT scheduled_for,created_at FROM portable_jobs WHERE id=${initial.job_id}`;
  assert.equal(Number(scheduledAt.scheduled_for)-Number(scheduledAt.created_at),300_000);
  await one();
  assert.equal((await read(initial.job_id)).status,'queued');
  const left=await transition(first,'Lead');
  const reentered=await transition(left,'Subscriber');
  const reentry=await captured(reentered);
  const previousSendCount=(await sends()).length;
  assert.equal((await runDue(initial.job_id)).issue,'segment_left');
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${reentry.job_id}`;
  const continuous=spawn(process.execPath,['--import',mock,command,'worker'],{env:workerEnv,cwd,stdio:['ignore','pipe','inherit']});
  const stopped=once(continuous,'exit');
  let workerLog='';
  continuous.stdout.on('data',chunk=>{workerLog+=chunk;});
  try{
    for(let poll=0;poll<100&&(await read(reentry.job_id)).status!=='succeeded';poll++)await delay(50);
    assert.equal((await read(reentry.job_id)).provider_id,'fictional-accepted');
    let poll;
    for(let attempt=0;attempt<100&&!poll;attempt++){
      [poll]=await sql`SELECT last_gmail_poll_at FROM portable_worker_heartbeat WHERE last_gmail_poll_at IS NOT NULL`;
      if(!poll)await delay(50);
    }
    assert.ok(poll,'A configured continuous worker records a separate Gmail heartbeat');
    for(let attempt=0;attempt<100&&!workerLog.includes('\n');attempt++)await delay(50);
    assert.equal(JSON.parse(workerLog).capabilities.scheduledGmailConfigured,true);
    assert.ok(!workerLog.includes('owner@example.test')&&!workerLog.includes('fictional-refresh')&&!workerLog.includes('fictional-secret'));
  }finally{
    continuous.kill('SIGTERM');
    assert.deepEqual(await stopped,[0,null]);
  }
  const pendingAfterPoll=payload('Due after a recent Gmail poll');
  assert.equal((await enqueue(owned,pendingAfterPoll)).status,202);
  assert.doesNotMatch(await queue(headers),gmailWorkerWarning);
  const [mailPoll]=await sql`SELECT last_gmail_poll_at FROM portable_worker_heartbeat WHERE id=1`;
  await sql`UPDATE portable_worker_heartbeat SET last_gmail_poll_at=0 WHERE id=1`;
  try{assert.match(await queue(headers),gmailWorkerWarning);}
  finally{
    await sql`UPDATE portable_worker_heartbeat SET last_gmail_poll_at=${mailPoll.last_gmail_poll_at} WHERE id=1`;
    assert.equal((await cancel(owned,pendingAfterPoll.id)).status,200);
  }
  await one();
  const delivered=await sends();
  assert.equal(delivered.length,previousSendCount+1);
  assert.ok(delivered.at(-1).mime.includes('X-Harbor-Message-ID: <harbor.'+reentry.job_id+'@'+sharing.workspaceId+'.harbor.invalid>'));

  const shared=await transition(await create('workflow-shared@example.test'),'Subscriber',other,
    '?workspaceId='+sharing.workspaceId+'&grantId='+sharing.grantId);
  assert.equal((await captured(shared)).issue,'gmail_unavailable');
  assert.equal((await captured(shared)).job_id,null);
  const noAddress=await post('/api/crm',headers,{action:'save',kind:'contacts',data:{name:'Workflow without address',lifecycle:'Lead'}});
  assert.equal(noAddress.status,201);
  assert.equal((await captured(await transition((await noAddress.json()).record,'Subscriber'))).issue,'email_address_missing');
  const opted=await create('workflow-blocked@example.test');
  assert.equal((await block(opted.data.email)).status,200);
  assert.equal((await captured(await transition(opted,'Subscriber'))).issue,'email_recipient_suppressed');
  const deferred=await transition(await create('workflow-optout-after-entry@example.test'),'Subscriber');
  const optoutJob=(await captured(deferred)).job_id;
  assert.equal((await block(deferred.data.email)).status,200);
  assert.equal((await runDue(optoutJob)).issue,'email_recipient_suppressed');

  const flagOff=await captured(await transition(await create('workflow-worker-disabled@example.test'),'Subscriber'));
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${flagOff.job_id}`;
  const beforeOffCalls=(await calls()).length;
  await execute(process.execPath,['--import',mock,command,'worker','--once'],{env:{
    ...workerEnv,HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED:'false',
  },cwd,timeout:8_000});
  assert.equal((await read(flagOff.job_id)).issue,'gmail_workflow_changed');
  assert.equal((await calls()).length,beforeOffCalls);

  const stopJob=(await captured(await transition(await create('workflow-stop@example.test'),'Subscriber'))).job_id;
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${stopJob}`;
  await rm(resume,{force:true});
  await mode('hold_profile');
  const callMark=(await calls()).length;
  const stopRace=one();
  try{
    let profile=false;
    for(let poll=0;poll<100&&!profile;poll++){
      profile=(await calls()).slice(callMark).some(call=>call.kind==='profile');
      if(!profile)await delay(20);
    }
    assert.ok(profile);
    assert.equal((await toggle(ruleId,2,false)).status,200);
    assert.equal((await toggle(ruleId,3,true)).status,200);
  }finally{await writeFile(resume,'continue');await stopRace;}
  assert.equal((await read(stopJob)).issue,'gmail_workflow_changed');
  assert.equal((await sends()).length,delivered.length);

  const pending=await transition(await create('workflow-restore@example.test'),'Subscriber');
  sharing.workflowGmail={ruleId,jobId:(await captured(pending)).job_id,contactId:pending.id};

}
