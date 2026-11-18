import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export async function verifyPortableJobOperations({request,origin,headers,other,sql,sharing,record}){
  const path='/?view=job-queue';
  const page=async(url=path,auth=headers)=>{
    const response=await request(url,{headers:auth});
    assert.equal(response.status,200);
    return response.text();
  };
  const denied=await request(path,{redirect:'manual'});
  assert.equal(denied.status,307);
  assert.match(denied.headers.get('location'),/auth\/sign-in/);
  assert.match(await page('/?view=workflows'),/href="\/\?view=job-queue"/);
  assert.equal((await request(path+'&workspaceId='+sharing.workspaceId,{headers:other})).status,404);
  assert.equal((await request(path+'&afterAt=5',{headers})).status,404);
  const contactFilter='&jobContactId='+record.id;
  const contactPage=await page('/?contact='+record.id);
  assert.ok(contactPage.includes('/?view=job-queue&amp;queue=all&amp;jobContactId='+record.id));
  for(const invalid of ['&jobKind=invalid','&jobKind=note&jobKind=gmail','&jobContactId=invalid',
    '&jobContactId='+randomUUID(),contactFilter+contactFilter]){
    assert.equal((await request(path+invalid,{headers})).status,404);
  }
  assert.equal((await request('/?view=workflows'+contactFilter,{headers})).status,404);
  assert.equal((await request(path+contactFilter,{headers:other})).status,404);
  assert.equal((await request(path+contactFilter+'&workspaceId='+sharing.workspaceId,{headers:other})).status,404);

  const jobIds=html=>Array.from(html.matchAll(/<code>([0-9a-f-]{36})<\/code>/g),match=>match[1]);
  const jobRow=(html,id)=>Array.from(html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g),match=>match[0])
    .find(row=>row.includes('<code>'+id+'</code>'))??'';
  const receiptLookup=html=>html.match(/<form aria-label="Find a job receipt"[^>]*>[\s\S]*?<\/form>/)?.[0]??'';
  const issues=await page();
  const lookup=receiptLookup(issues);
  assert.match(lookup,/method="get"/);
  assert.match(lookup,/action="\/"/);
  assert.match(lookup,/name="view" value="job-queue"/);
  assert.match(lookup,/<label>Job ID<input[^>]*name="jobId"/);
  assert.match(lookup,/>Open receipt<\/button>/);
  const uncertain=jobRow(issues,sharing.gmail.crashId);
  const gmailSearch='in:sent rfc822msgid:harbor.'+sharing.gmail.crashId+'@'+sharing.workspaceId+'.harbor.invalid';
  const reconcileCommand='node scripts/portable-web.mjs gmail-reconcile '+sharing.workspaceId+' '+sharing.gmail.crashId;
  assert.match(uncertain,/External outcome unknown/);
  assert.ok(uncertain.includes(gmailSearch));
  assert.match(uncertain,/delivery is still unconfirmed/);
  assert.match(uncertain,/>Mark reviewed<\/button>/);
  assert.doesNotMatch(uncertain,/>Cancel (email|Note)<\/button>/);
  const detailPath=path+'&jobId='+sharing.gmail.crashId;
  const detail=await page(detailPath);
  assert.deepEqual(jobIds(detail),[sharing.gmail.crashId]);
  assert.match(detail,/<h1>Job details<\/h1>/);
  assert.match(detail,/Back to Job queue/);
  assert.ok(detail.includes('href="'+detailPath.replaceAll('&','&amp;')+'">Refresh receipt</a>'));
  assert.match(detail,/<button type="button">Copy job link<\/button>/);
  assert.match(detail,/<button type="button">Copy job ID<\/button>/);
  assert.doesNotMatch(issues,/Refresh receipt|Copy job (link|ID)/);
  assert.equal(receiptLookup(detail),'');
  assert.doesNotMatch(detail,/>Queue overview<\/h2>/);
  assert.match(detail,/<details open=""><summary>Run details<\/summary>/);
  assert.ok(detail.includes(gmailSearch));
  assert.ok(detail.includes(reconcileCommand));
  assert.ok(!uncertain.includes(reconcileCommand));
  const foreignDetail=await request(detailPath,{headers:other});
  assert.equal(foreignDetail.status,404);
  assert.ok(!(await foreignDetail.text()).includes(reconcileCommand));
  for(const invalid of [path+'&jobId='+randomUUID(),path+'&jobId=invalid',detailPath+'&jobId='+sharing.gmail.crashId,
    detailPath+'&queue=all',detailPath+'&afterAt=5',detailPath+'&jobKind=gmail',detailPath+contactFilter]){
    assert.equal((await request(invalid,{headers})).status,404);
  }
  const anonymous=await request(detailPath,{redirect:'manual'});
  assert.equal(anonymous.status,307);
  assert.equal(new URL(anonymous.headers.get('location'),origin).searchParams.get('return_to'),detailPath);
  const [heartbeat]=await sql`SELECT last_poll_at,last_queue_poll_at FROM portable_worker_heartbeat WHERE id=1`;
  const [{observed_at:heartbeatAt}]=await sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS observed_at`;
  const recentPoll=heartbeatAt-120_000,stalledPoll=heartbeatAt-151_000;
  const visibleTime=at=>new Date(at).toISOString().slice(0,16).replace('T',' ')+' UTC';
  const stalledMessage='Worker is running, but Harbor has no recent successful job poll.';
  await sql`UPDATE portable_worker_heartbeat SET last_poll_at=0,last_queue_poll_at=${stalledPoll} WHERE id=1`;
  try{
    const stopped=await page();
    assert.match(stopped,/Worker has stopped reporting/);
    assert.ok(!stopped.includes(stalledMessage));
    await sql`UPDATE portable_worker_heartbeat SET last_poll_at=${heartbeatAt},last_queue_poll_at=${recentPoll} WHERE id=1`;
    assert.ok(!(await page()).includes(stalledMessage));
    await sql`UPDATE portable_worker_heartbeat SET last_queue_poll_at=${stalledPoll} WHERE id=1`;
    const stalled=(await page()).replaceAll('<!-- -->','');
    assert.ok(stalled.includes(stalledMessage));
    assert.match(stalled,/Last heartbeat/);
    assert.match(stalled,/Last successful job poll/);
    assert.ok(stalled.includes(visibleTime(heartbeatAt)));
    assert.ok(stalled.includes(visibleTime(stalledPoll)));
    await sql`UPDATE portable_worker_heartbeat SET last_queue_poll_at=${heartbeatAt} WHERE id=1`;
    const recovered=await page();
    assert.match(recovered,/Worker reporting/);
    assert.ok(!recovered.includes(stalledMessage));
    await sql`UPDATE portable_worker_heartbeat SET last_poll_at=9223372036854775807 WHERE id=1`;
    const invalid=await page();
    assert.match(invalid,/Worker heartbeat time is invalid/);
    assert.doesNotMatch(invalid,/Last heartbeat|Worker reporting/);
    assert.match(invalid,/Last successful job poll/);
  }finally{
    await sql`UPDATE portable_worker_heartbeat
      SET last_poll_at=${heartbeat.last_poll_at},last_queue_poll_at=${heartbeat.last_queue_poll_at} WHERE id=1`;
  }
  assert.ok(issues.includes('/?contact='+sharing.gmail.contactId+'#portable-contact-jobs'));
  assert.doesNotMatch(issues,/Crash at provider boundary|Fictional plain-text email|fictional-reconciled/);
  const foreignQueue=await page(path+'&queue=all',other);
  const queueOverview=html=>html.match(/<section class="portable-job-overview"[^>]*>[\s\S]*?<\/section>/)?.[0]??'';
  const foreignOverview=queueOverview(foreignQueue);
  assert.ok(foreignOverview);
  assert.ok(!foreignQueue.includes(sharing.gmail.crashId));
  assert.ok(!foreignQueue.includes(gmailSearch));
  const all=await page(path+'&queue=all');
  assert.ok(all.includes(sharing.gmail.confirmedId));
  assert.match(all,/Accepted by Gmail/);
  assert.doesNotMatch(jobRow(all,sharing.gmail.confirmedId),/rfc822msgid/);

  const completed=await page(path+'&queue=completed');
  assert.match(completed,/aria-current="page">Completed<\/a>/);
  assert.match(jobRow(completed,sharing.gmail.confirmedId),/Accepted by Gmail/);
  assert.match(completed,/>Last attempt<\/th>/);
  assert.match(jobRow(completed,sharing.gmail.confirmedId).replaceAll('<!-- -->',''),/portable-job-attempt-time[^>]*>[^<]*Attempt 2/);
  assert.doesNotMatch(completed,/fictional-reconciled/);
  const confirmedPath=path+'&jobId='+sharing.gmail.confirmedId;
  const confirmed=await page(confirmedPath);
  assert.match(confirmed,/Gmail receipt <code>fictional-reconciled<\/code>/);
  const foreignConfirmed=await request(confirmedPath,{headers:other});
  assert.equal(foreignConfirmed.status,404);
  assert.doesNotMatch(await foreignConfirmed.text(),/fictional-reconciled/);
  assert.ok(!jobIds(completed).includes(sharing.gmail.crashId));
  assert.ok(!jobIds(completed).includes(sharing.gmail.queuedId));
  assert.ok(!jobIds(await page(path+'&queue=completed',other)).includes(sharing.gmail.confirmedId));

  const pending=await page(path+'&queue=pending');
  assert.ok(pending.includes(sharing.gmail.queuedId));
  assert.ok(!pending.includes(sharing.gmail.crashId));
  assert.doesNotMatch(jobRow(pending,sharing.gmail.queuedId),/rfc822msgid/);
  assert.match(pending,/>Cancel email<\/button>/);
  assert.match(pending,/>Cancel Note<\/button>/);
  const pendingMailPath=path+'&queue=pending&jobKind=gmail';
  const pendingMail=await page(pendingMailPath);
  assert.match(pendingMail,/<option value="gmail" selected="">Scheduled email<\/option>/);
  assert.ok(jobIds(pendingMail).includes(sharing.gmail.queuedId));
  assert.doesNotMatch(pendingMail,/>Cancel Note<\/button>/);
  assert.ok(pendingMail.includes('queue=failed&amp;jobKind=gmail'));
  assert.ok(!jobIds(await page(pendingMailPath,other)).includes(sharing.gmail.queuedId));
  assert.deepEqual(jobIds(await page(path+'&queue=pending&jobKind=')),jobIds(pending));
  assert.deepEqual(jobIds(await page(path+'&queue=pending&jobContactId=')),jobIds(pending));
  const pendingContactPath=pendingMailPath+'&jobContactId='+sharing.gmail.contactId;
  const pendingContact=await page(pendingContactPath);
  assert.equal(receiptLookup(pendingContact),lookup);
  assert.match(pendingContact,/<select name="jobContactId">/);
  assert.match(pendingContact,/<option value="">All Contacts<\/option>/);
  assert.ok(pendingContact.includes('value="'+sharing.gmail.contactId+'" selected=""'));
  assert.match(jobRow(pendingContact,sharing.gmail.queuedId),/>Cancel email<\/button>/);
  assert.ok(pendingContact.includes('queue=failed&amp;jobKind=gmail&amp;jobContactId='+sharing.gmail.contactId));
  assert.ok(pendingContact.includes(pendingContactPath.replaceAll('&','&amp;')+'">Refresh queue</a>'));
  const anonymousMail=await request(pendingMailPath,{redirect:'manual'});
  assert.equal(anonymousMail.status,307);
  assert.equal(new URL(anonymousMail.headers.get('location'),origin).searchParams.get('return_to'),pendingMailPath);
  const [job]=await sql`SELECT actor_id FROM portable_jobs WHERE workspace_id=${sharing.workspaceId} AND id=${sharing.gmail.crashId}`;
  const now=Date.now(),createdAt=now+120_000;
  const completedRows=Array.from({length:27},(_,index)=>({
    workspace_id:sharing.workspaceId,id:randomUUID(),contact_id:record.id,actor_id:job.actor_id,
    kind:'note',body:'Fictional completed note',scheduled_for:now-600_000,available_at:now-600_000,
    created_at:createdAt+index,finished_at:index===26?null:createdAt+(index===0?300:200),status:'succeeded',
  }));
  const completedIds=completedRows.map(row=>row.id);
  const otherContactRows=completedRows.slice(0,25).map((row,index)=>({...row,id:randomUUID(),
    contact_id:sharing.gmail.contactId,created_at:createdAt+500+index,finished_at:createdAt+500+index}));
  try{
    await sql`INSERT INTO portable_jobs ${sql(completedRows)}`;
    const completedNotes=path+'&queue=completed&jobKind=note';
    const finished=completedNotes+'&jobOrder=finished';
    const byFinish=[completedIds[0],...completedIds.slice(1,26).sort().reverse(),completedIds[26]];
    const firstFinished=await page(finished);
    assert.match(firstFinished,/<option value="finished" selected="">Newest finished<\/option>/);
    assert.match(firstFinished,/Finished .* UTC/);
    assert.deepEqual(jobIds(firstFinished),byFinish.slice(0,25));
    const nextFinished=finished+'&afterFinishedAt='+(createdAt+200)+'&afterId='+byFinish[24];
    assert.ok(firstFinished.includes(nextFinished.replaceAll('&','&amp;')));
    assert.deepEqual(jobIds(await page(nextFinished)).slice(0,2),byFinish.slice(25));
    assert.ok(jobIds(await page(finished,other)).every(id=>!completedIds.includes(id)));

    const byCreation=[...completedIds].reverse();
    const firstCreated=await page(completedNotes);
    assert.deepEqual(jobIds(firstCreated),byCreation.slice(0,25));
    const nextCreated=completedNotes+'&afterAt='+(createdAt+2)+'&afterId='+byCreation[24];
    assert.ok(firstCreated.includes(nextCreated.replaceAll('&','&amp;')));
    assert.deepEqual(jobIds(await page(nextCreated)).slice(0,2),byCreation.slice(25));
    for(const invalid of [
      finished+'&afterFinishedAt=5',
      finished+'&afterAt=5&afterId='+byFinish[0],
      completedNotes+'&afterFinishedAt=5&afterId='+byFinish[0],
      completedNotes+'&jobOrder=finished&jobOrder=invalid',
      path+'&queue=failed&jobOrder=finished',
    ])assert.equal((await request(invalid,{headers})).status,404);
    const signedOut=await request(nextFinished,{redirect:'manual'});
    assert.equal(signedOut.status,307);
    assert.equal(new URL(signedOut.headers.get('location'),origin).searchParams.get('return_to'),nextFinished);

    await sql`INSERT INTO portable_jobs ${sql(otherContactRows)}`;
    assert.deepEqual(jobIds(await page(finished)),otherContactRows.map(row=>row.id).reverse());
    const filteredCreated=completedNotes+contactFilter;
    const filteredFinished=filteredCreated+'&jobOrder=finished';
    for(const [url,ids,after] of [[filteredCreated,byCreation,'afterAt='+(createdAt+2)],[filteredFinished,byFinish,'afterFinishedAt='+(createdAt+200)]]){
      const first=await page(url);
      const older=url+'&'+after+'&afterId='+ids[24];
      assert.deepEqual(jobIds(first),ids.slice(0,25));
      assert.ok(first.includes(older.replaceAll('&','&amp;')+'">Older jobs</a>'));
      assert.deepEqual(jobIds(await page(older)).slice(0,2),ids.slice(25));
    }
    const signedOutFiltered=await request(filteredFinished,{redirect:'manual'});
    assert.equal(signedOutFiltered.status,307);
    assert.equal(new URL(signedOutFiltered.headers.get('location'),origin).searchParams.get('return_to'),filteredFinished);
  }finally{
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${sharing.workspaceId} AND id IN ${sql([...completedIds,...otherContactRows.map(row=>row.id)])}`;
  }

  const overdue=randomUUID(),expired=randomUUID(),expiredDispatch=randomUUID();
  const future=randomUUID(),recentlyDue=randomUUID();
  const failedIds=Array.from({length:26},()=>randomUUID()).sort().reverse();
  const problemIds=[expiredDispatch,expired,overdue],healthyIds=[future,recentlyDue];
  const injectedIds=[...failedIds,...problemIds,...healthyIds];
  const injectedJobs=()=>sql`SELECT * FROM portable_jobs WHERE workspace_id=${sharing.workspaceId}
    AND id IN ${sql(injectedIds)} ORDER BY id`;
  try{
    await sql`INSERT INTO portable_jobs ${sql(failedIds.map(id=>({
      workspace_id:sharing.workspaceId,id,contact_id:record.id,actor_id:job.actor_id,kind:'note',body:'Private fixture note',
      scheduled_for:createdAt,available_at:createdAt,created_at:createdAt,status:'failed',finished_at:createdAt,
    })))}`;
    await sql`INSERT INTO portable_jobs ${sql([
      {id:overdue,kind:'note',status:'queued',available_at:now-360_000,lease_token:null,lease_until:null},
      {id:expired,kind:'note',status:'running',available_at:0,lease_token:randomUUID(),lease_until:now-1000},
      {id:expiredDispatch,kind:'gmail',status:'dispatching',available_at:0,lease_token:randomUUID(),lease_until:now-1000},
      {id:future,kind:'note',status:'queued',available_at:now+600_000,lease_token:null,lease_until:null},
      {id:recentlyDue,kind:'note',status:'queued',available_at:now-1000,lease_token:null,lease_until:null},
    ].map((item,index)=>({...item,workspace_id:sharing.workspaceId,contact_id:record.id,actor_id:job.actor_id,
      body:'Private pending note',scheduled_for:item.available_at,created_at:createdAt+index+1})))}`;
    const dueNoteWarning=/Scheduled Notes are due/;
    const [poll]=await sql`SELECT last_poll_at FROM portable_worker_heartbeat WHERE id=1`;
    try{
      await sql`UPDATE portable_worker_heartbeat SET last_poll_at=0 WHERE id=1`;
      assert.match(await page(),dueNoteWarning);
      assert.match(await page(path+'&queue=pending'),dueNoteWarning);
      assert.doesNotMatch(await page(path,other),dueNoteWarning);
      await sql`UPDATE portable_worker_heartbeat SET last_poll_at=
        floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=1`;
      assert.doesNotMatch(await page(),dueNoteWarning);
      await sql`UPDATE portable_worker_heartbeat SET last_poll_at=0 WHERE id=1`;
      await sql`UPDATE portable_jobs SET available_at=${now+600_000} WHERE workspace_id=${sharing.workspaceId}
        AND id IN ${sql([overdue,recentlyDue])}`;
      assert.doesNotMatch(await page(),dueNoteWarning);
    }finally{
      await sql`UPDATE portable_jobs SET available_at=CASE WHEN id=${overdue} THEN ${now-360_000}::bigint
        ELSE ${now-1000}::bigint END WHERE workspace_id=${sharing.workspaceId} AND id IN ${sql([overdue,recentlyDue])}`;
      await sql`UPDATE portable_worker_heartbeat SET last_poll_at=${poll.last_poll_at} WHERE id=1`;
    }
    const beforeQueueReads=await injectedJobs();
    const first=await page(),second=await page(path+'&afterAt='+createdAt+'&afterId='+failedIds[21]);
    const overview=queueOverview(first);
    for(const [issue,label] of [
      ['needs_review','Review outcomes'],['overdue','Check overdue jobs'],['expired_claim','Check interrupted jobs'],
    ])assert.ok(overview.includes('queue=issues&amp;jobIssue='+issue+'">'+label+'</a>'));
    assert.equal(queueOverview(await page(path+'&queue=completed&jobKind=gmail')),overview);
    assert.equal(queueOverview(await page(pendingContactPath)),overview);
    assert.equal(queueOverview(await page(path+'&queue=all',other)),foreignOverview);
    assert.ok(jobIds(await page(path+'&jobIssue=overdue')).includes(overdue));
    assert.ok(jobIds(await page(path+'&jobIssue=expired_claim')).includes(expiredDispatch));
    const firstPageIds=[...problemIds,...failedIds.slice(0,22)];
    assert.deepEqual(jobIds(first),firstPageIds);
    assert.deepEqual(jobIds(second).slice(0,4),failedIds.slice(22));
    assert.ok(jobIds(second).every(id=>!firstPageIds.includes(id)&&!healthyIds.includes(id)));
    assert.match(first,/Older jobs/);
    const unreviewed=path+'&queue=issues&jobKind=note&jobIssue=failed';
    const unreviewedFirst=await page(unreviewed);
    assert.deepEqual(jobIds(unreviewedFirst),failedIds.slice(0,25));
    const unreviewedNext=unreviewed+'&afterAt='+createdAt+'&afterId='+failedIds[24];
    assert.ok(unreviewedFirst.includes(unreviewedNext.replaceAll('&','&amp;')));
    assert.equal(jobIds(await page(unreviewedNext))[0],failedIds[25]);
    const failures=await page(path+'&queue=failed');
    const olderFailures=await page(path+'&queue=failed&afterAt='+createdAt+'&afterId='+failedIds[24]);
    assert.match(failures,/aria-current="page">Failed<\/a>/);
    assert.deepEqual(jobIds(failures),failedIds.slice(0,25));
    assert.equal(jobIds(olderFailures)[0],failedIds[25]);
    assert.ok(jobRow(failures,failedIds[0]).includes('jobId='+failedIds[0]));
    const onlyNotes=path+'&queue=failed&jobKind=note';
    const firstNotes=await page(onlyNotes);
    const nextNotes=onlyNotes+'&afterAt='+createdAt+'&afterId='+failedIds[24];
    assert.ok(firstNotes.includes(nextNotes.replaceAll('&','&amp;')));
    assert.deepEqual(jobIds(firstNotes),failedIds.slice(0,25));
    assert.equal(jobIds(await page(nextNotes))[0],failedIds[25]);
    assert.deepEqual(jobIds(await page(unreviewed+contactFilter)),failedIds.slice(0,25));
    assert.ok(jobIds(await page(unreviewed+'&jobContactId='+sharing.gmail.contactId)).every(id=>!injectedIds.includes(id)));
    assert.ok(jobIds(await page(path+'&queue=failed&jobKind=gmail')).every(id=>!failedIds.includes(id)));
    assert.match(jobRow(first,expiredDispatch),/An expired claim does not confirm the outcome/);
    assert.match(jobRow(first,overdue),/Overdue/);
    for(const id of [expired,expiredDispatch])assert.match(jobRow(first,id),/Worker claim expired/);
    assert.doesNotMatch(first,/Private fixture note|Private pending note/);
    const active=await page(path+'&queue=pending');
    assert.ok([...problemIds,...healthyIds].every(id=>jobIds(active).includes(id)));
    assert.ok(jobIds(active).every(id=>!failedIds.includes(id)));
    assert.match(jobRow(active,overdue),/Overdue/);
    for(const id of [expired,expiredDispatch])assert.match(jobRow(active,id),/Worker claim expired/);
    for(const id of healthyIds)assert.doesNotMatch(jobRow(active,id),/Overdue|Worker claim expired/);
    assert.doesNotMatch(active,/Private pending note/);
    const history=await page(path+'&queue=all');
    assert.ok([...problemIds,...healthyIds,failedIds[0]].every(id=>jobIds(history).includes(id)));
    assert.doesNotMatch(history,/Private fixture note|Private pending note/);
    for(const queue of ['issues','pending','failed','all']){
      const foreign=await page(path+'&queue='+queue,other);
      assert.ok(injectedIds.every(id=>!foreign.includes(id)));
      assert.doesNotMatch(foreign,/Private fixture note|Private pending note/);
    }
    assert.deepEqual(await injectedJobs(),beforeQueueReads);
    assert.match(jobRow(first,failedIds[0]),/>Mark reviewed<\/button>/);
    await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${sharing.workspaceId} AND id=${record.id}`;
    try{
      const archivedQueue=await page(path+contactFilter);
      assert.match(jobRow(archivedQueue,failedIds[0]),/\(archived\)/);
      assert.match(archivedQueue,new RegExp('value="'+record.id+'" selected="">[^<]*\\(archived\\)</option>'));
      const jobPath='/api/background-jobs?recordId='+record.id;
      const act=(auth,action)=>request(jobPath,{method:'POST',
        headers:{...auth,origin,'content-type':'application/json'},
        body:JSON.stringify({id:failedIds[0],...action})});
      assert.equal((await act(other,{action:'reviewFailed',attempts:0})).status,404);
      assert.equal((await act(headers,{action:'reviewFailed',attempts:0})).status,200);
      assert.equal((await act(headers,{action:'retryNote'})).status,404);
      assert.equal((await request(jobPath,{headers})).status,404);
    }finally{
      await sql`UPDATE contacts SET archived_at=NULL WHERE workspace_id=${sharing.workspaceId} AND id=${record.id}`;
    }
    assert.ok(!jobIds(await page()).includes(failedIds[0]));
    assert.match(jobRow(await page(path+'&queue=all'),failedIds[0]),/Failed · reviewed/);
    assert.match(jobRow(await page(path+'&queue=failed'),failedIds[0]),/Failed · reviewed/);
  }finally{
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${sharing.workspaceId} AND id IN ${sql(injectedIds)}`;
  }
  const review=(id,auth=headers,scope='',site=origin,contactId=sharing.gmail.contactId)=>request(
    '/api/background-jobs?recordId='+contactId+scope,{method:'POST',headers:{...auth,origin:site,'content-type':'application/json'},
      body:JSON.stringify({action:'reviewGmail',id})});
  const {crashId,queuedId}=sharing.gmail;
  assert.equal((await review(crashId,{})).status,401);
  assert.equal((await review(crashId,other)).status,404);
  assert.equal((await review(crashId,other,'&workspaceId='+sharing.workspaceId+'&grantId='+sharing.grantId)).status,403);
  assert.equal((await review(crashId,headers,'','https://foreign.example.test')).status,403);
  assert.equal((await review(crashId,headers,'',origin,record.id)).status,404);
  assert.equal((await review(queuedId)).status,409);
  const jobHistory=async()=>(await (await request('/api/background-jobs?recordId='+sharing.gmail.contactId,{headers})).json())
    .items.find(item=>item.id===crashId);
  const before=await jobHistory();
  assert.equal(before.operatorReviewedAt,null);
  const replies=await Promise.all([review(crashId),review(crashId)]);
  assert.ok(replies.every(reply=>reply.status===200));
  assert.deepEqual((await Promise.all(replies.map(reply=>reply.json()))).map(body=>body.result).sort(),['already','reviewed']);
  const [saved]=await sql`SELECT operator_reviewed_at::float8 AS at,operator_reviewed_by AS actor FROM portable_jobs
    WHERE workspace_id=${sharing.workspaceId} AND id=${crashId}`;
  assert.equal(saved.actor,job.actor_id);
  assert.ok(saved.at>=before.finishedAt);
  assert.deepEqual(await jobHistory(),{...before,operatorReviewedAt:saved.at});
  assert.ok(!(await page()).includes(crashId));
  const reviewed=await page(path+'&queue=all');
  assert.ok(reviewed.includes(crashId));
  assert.match(reviewed,/Delivery unconfirmed · reviewed/);
  assert.ok(jobRow(reviewed,crashId).includes(gmailSearch));
  sharing.gmail.crashReviewedAt=saved.at;
}

export async function verifyPortableNoteRetry({request,origin,headers,other,sql,sharing,record,env}){
  const path='/api/background-jobs?recordId='+record.id;
  const retry=(id,auth=headers,extra='',site=origin)=>request(path+extra,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify({action:'retryNote',id})});
  const [owner]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${sharing.workspaceId}`;
  const now=Date.now();
  const seed=async (issue='processor_error')=>{
    const id=randomUUID();
    await sql`INSERT INTO portable_jobs ${sql({
      workspace_id:sharing.workspaceId,id,contact_id:record.id,actor_id:owner.owner_id,kind:'note',body:'Retry fixture note',
      scheduled_for:now-600_000,available_at:now,created_at:now,status:'failed',attempts:5,issue,finished_at:now,
    })}`;
    await sql`INSERT INTO portable_job_attempts ${sql(Array.from({length:5},(_,index)=>({
      workspace_id:sharing.workspaceId,job_id:id,number:index+1,started_at:now-1000,ended_at:now,outcome:issue,
    })))}`;
    return id;
  };
  const id=await seed();
  const read=async id=>(await sql`SELECT status,attempts,operator_retry_at,operator_retry_by,operator_reviewed_at FROM portable_jobs
    WHERE workspace_id=${sharing.workspaceId} AND id=${id}`)[0];
  const attempts=async id=>(await sql`SELECT number,outcome FROM portable_job_attempts WHERE workspace_id=${sharing.workspaceId}
    AND job_id=${id} ORDER BY number`).map(row=>[row.number,row.outcome]);
  assert.equal((await retry(id,{})).status,401);
  assert.equal((await retry(id,other)).status,404);
  assert.equal((await retry(id,other,'&workspaceId='+sharing.workspaceId+'&grantId='+sharing.grantId)).status,403);
  assert.equal((await retry(id,headers,'','https://foreign.example.test')).status,403);
  const external=await request('/api/background-jobs?recordId='+sharing.gmail.contactId,{method:'POST',
    headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify({action:'retryNote',id:sharing.gmail.crashId})});
  assert.equal(external.status,409);
  assert.equal((await retry(await seed('authority_changed'))).status,409);
  const before=await (await request('/?view=job-queue',{headers})).text();
  assert.ok(before.includes('Retry Note'));

  const [{pending}]=await sql`SELECT count(*)::int AS pending FROM portable_jobs WHERE workspace_id=${sharing.workspaceId}
    AND status IN ('queued','running','dispatching')`;
  const filler=Array.from({length:100-pending},()=>randomUUID());
  try{
    await sql`INSERT INTO portable_jobs ${sql(filler.map(id=>({
      workspace_id:sharing.workspaceId,id,contact_id:record.id,actor_id:owner.owner_id,kind:'note',body:'Capacity fixture',
      scheduled_for:now+600_000,available_at:now+600_000,created_at:now,
    })))}`;
    assert.equal((await retry(id)).status,429);
    assert.equal((await read(id)).operator_retry_at,null);
  }finally{
    await sql`DELETE FROM portable_jobs WHERE workspace_id=${sharing.workspaceId} AND id=ANY(${filler}::uuid[])`;
  }

  const reviewFailure=()=>request(path,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'reviewFailed',id,attempts:5})});
  assert.equal((await reviewFailure()).status,200);
  assert.equal((await read(id)).status,'failed');
  assert.ok((await read(id)).operator_reviewed_at);
  const previous=await attempts(id);
  const replies=await Promise.all([retry(id),retry(id)]);
  assert.ok(replies.every(reply=>reply.status===202));
  assert.deepEqual((await Promise.all(replies.map(reply=>reply.json()))).map(item=>item.result).sort(),['already','queued']);
  const queued=await read(id);
  assert.equal(queued.status,'queued');
  assert.equal(queued.attempts,5);
  assert.equal(queued.operator_reviewed_at,null);
  assert.equal((await reviewFailure()).status,409);
  assert.equal(queued.operator_retry_by,owner.owner_id);
  assert.ok(Number(queued.operator_retry_at)>=now);
  assert.deepEqual(await attempts(id),previous);
  const overdue=await request('/?view=job-queue&queue=issues&jobIssue=overdue&jobContactId='+record.id,{headers});
  assert.equal(overdue.status,200);
  assert.ok(!(await overdue.text()).includes(id));
  const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
  const run=()=>execFileSync(process.execPath,[command,'worker','--once'],{env:{...env,HARBOR_PORTABLE_GMAIL_ENABLED:'false'},cwd:process.env.HARBOR_TEST_PORTABLE_CWD,timeout:6000});
  run();
  run();
  assert.equal((await read(id)).status,'succeeded');
  assert.equal((await retry(id)).status,202);
  assert.deepEqual(await attempts(id),[...previous,[6,'succeeded']]);
  assert.equal((await sql`SELECT count(*)::int AS count FROM portable_notes WHERE job_id=${id}`)[0].count,1);

  const pendingRestore=await seed('lease_expired');
  assert.equal((await retry(pendingRestore)).status,202);
  await sql`UPDATE portable_jobs SET available_at=${now+600_000} WHERE id=${pendingRestore}`;
  sharing.operatorRetryId=pendingRestore;
}
