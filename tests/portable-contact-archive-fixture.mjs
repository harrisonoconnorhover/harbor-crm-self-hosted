import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const archivePath='/api/recycle-bin';
const crm='/api/crm';
const post=(request,path,origin,headers,body)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const change=(record,action)=>({id:record.id,expectedRevision:record.revision,action,requestId:randomUUID()});
const receipt=async response=>{
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  return (await response.json()).receipt;
};

async function cancelBlockingNoteInBrowser(origin,headers,contact,job){
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const page=await browser.newPage();
    const [name,value]=headers.cookie.split('=');
    await page.context().addCookies([{name,value,url:origin}]);
    await page.goto(origin+'/?contact='+contact.id);
    await page.getByRole('button',{name:'Archive contact',exact:true}).click();
    await page.getByRole('button',{name:'Confirm archive'}).click();
    await page.getByRole('link',{name:'Review blocking job'}).click();
    await page.getByRole('heading',{name:'Job details',exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('jobId'),job.id);
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'Cancel Note'}).click();
    await page.getByText('Cancellation saved.',{exact:true}).waitFor();
    await page.getByRole('link',{name:contact.data.name,exact:true}).first().click();
    assert.equal(new URL(page.url()).searchParams.get('contact'),contact.id);
  }finally{await browser.close();}
}

export async function verifyPortableContactArchive({request,origin,headers,other,sql,browser=false}){
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const send=(path,body,auth=headers,site=origin)=>post(request,path,site,auth,body);
  const archived=auth=>request(archivePath,{headers:auth}).then(response=>response.json());
  const save=async input=>{
    const response=await send(crm,{kind:'contacts',action:'save',...input});
    assert.equal(response.status,input.id?200:201,await response.clone().text());
    return (await response.json()).record;
  };
  const original=await save({data:{name:'Fictional archive round trip',email:'archive-round-trip@example.test'}});
  const archive={...change(original,'archive'),requestId:'00000000-0000-4000-8000-000000000099'};
  const detail=crm+'?id='+original.id;
  const editor=await request('/?contact='+original.id,{headers});
  assert.equal(editor.status,200);
  assert.match(await editor.text(),/Archive contact/);
  const binPage=await request('/?view=recycle-bin',{headers});
  assert.equal(binPage.status,200);
  assert.match(await binPage.text(),/Loading archived contacts/);
  assert.equal((await request('/?view=recycle-bin&after=invalid',{headers})).status,404);
  assert.equal((await request(archivePath)).status,401);
  assert.equal((await send(archivePath,archive,other)).status,404);
  assert.equal((await send(archivePath,archive,headers,'https://outside.example.test')).status,403);
  assert.equal((await send(archivePath,{...archive,expectedRevision:original.revision+1})).status,409);

  const jobPath='/api/background-jobs?recordId='+original.id;
  const job={id:randomUUID(),body:'Fictional pending archive Note',scheduledFor:Date.now()+3_600_000};
  assert.equal((await send(jobPath,job)).status,202);
  const pending=await send(archivePath,archive);
  assert.equal(pending.status,409);
  const conflict=await pending.json();
  assert.match(conflict.error,/Resolve pending jobs/);
  assert.equal(conflict.blockingJobId,job.id);
  if(browser)await cancelBlockingNoteInBrowser(origin,headers,original,job);
  else assert.equal((await send(jobPath,{action:'cancelNote',id:job.id})).status,200);

  await sql`ALTER TABLE portable_contact_archive_receipts ADD CONSTRAINT fixture_archive_receipt_fail CHECK (request_id<>'00000000-0000-4000-8000-000000000099'::uuid)`;
  try{
    assert.equal((await send(archivePath,archive)).status,503);
    assert.equal((await (await request(detail,{headers})).json()).revision,original.revision);
  }finally{await sql`ALTER TABLE portable_contact_archive_receipts DROP CONSTRAINT fixture_archive_receipt_fail`;}

  const result=await receipt(await send(archivePath,archive));
  assert.deepEqual([result.id,result.action,result.revision],[original.id,'archive',original.revision+1]);
  assert.ok(Number.isFinite(Date.parse(result.archivedAt)));
  assert.deepEqual(await receipt(await send(archivePath,archive)),result);
  assert.equal((await send(archivePath,{...archive,action:'restore'})).status,409);
  assert.equal((await request(detail,{headers})).status,404);
  assert.ok((await archived(headers)).records.some(row=>row.id===original.id&&row.archivedAt===result.archivedAt));
  assert.ok(!(await archived(other)).records.some(row=>row.id===original.id));

  const duplicate=await save({data:{name:'Fictional archive address conflict',email:original.data.email.toUpperCase()}});
  const restore=change(result,'restore');
  const collision=await send(archivePath,restore);
  assert.equal(collision.status,409);
  assert.match((await collision.json()).error,/already has this email/);
  await save({id:duplicate.id,expectedRevision:duplicate.revision,data:{...duplicate.data,email:'archive-conflict-cleared@example.test'}});
  const restored=await receipt(await send(archivePath,restore));
  assert.deepEqual(restored,{id:original.id,action:'restore',revision:original.revision+2,archivedAt:null});
  assert.deepEqual(await receipt(await send(archivePath,restore)),restored);
  const visible=await (await request(detail,{headers})).json();
  assert.deepEqual([visible.id,visible.revision,visible.data],[original.id,restored.revision,original.data]);
  assert.deepEqual((await sql`SELECT revision FROM contact_events WHERE contact_id=${original.id} ORDER BY revision`).map(row=>row.revision),[1,2,3]);
  assert.equal((await sql`SELECT status FROM portable_jobs WHERE id=${job.id}`)[0].status,'skipped');

  const candidate=await save({data:{name:'Fictional archived recovery Contact'}});
  const recoverable=change(candidate,'archive');
  const competingJobPath='/api/background-jobs?recordId='+candidate.id;
  const competingJob={...job,id:randomUUID()};
  const [race,note]=await Promise.all([send(archivePath,recoverable),send(competingJobPath,competingJob)]);
  assert.ok((race.status===200&&note.status===404)||(race.status===409&&note.status===202),
    'Archive and Note admission must serialize on the same workspace.');
  let beforeRecovery;
  if(race.status===409){
    assert.equal((await send(competingJobPath,{action:'cancelNote',id:competingJob.id})).status,200);
    beforeRecovery=await receipt(await send(archivePath,recoverable));
  }else{
    beforeRecovery=await receipt(race);
  }
  await reset();
  return {archive:recoverable,receipt:beforeRecovery,candidate};
}

export async function verifyArchiveListHistory({request,origin,headers,other,sql}){
  const write=async(path,body)=>{
    const response=await post(request,path,origin,headers,body);
    assert.ok(response.ok,await response.clone().text());
    return response.json();
  };
  const team=await write('/api/workspaces',{action:'grant',email:'other@example.test'});
  const memberId=team=>team.viewers.find(member=>member.email==='other@example.test').id;
  let grantId=memberId(await write('/api/workspaces',{action:'role',id:memberId(team),role:'editor'}));
  async function permissions(scope){
    grantId=memberId(await write('/api/workspaces',{action:'record_scope',id:grantId,viewScope:scope,editScope:scope}));
    return '&'+new URLSearchParams({workspaceId:team.owned,grantId});
  }
  const shared=await permissions('all');
  const count=async()=>(await sql`SELECT count(*)::int AS n FROM portable_record_access_events`)[0].n;
  for(const kind of ['contacts','companies','deals','tasks','leads','tickets']){
    const data={name:'Fictional archived '+kind};
    const saved=await write(kind==='leads'||kind==='tickets'?'/api/'+kind:crm,{action:'save',...(kind==='leads'||kind==='tickets'?{}:{kind}),data});
    const record=kind==='leads'?await (await request('/api/leads?id='+saved.id,{headers})).json():saved.record;
    assert.ok(record?.id&&record.revision,kind+' must have a saved revision');
    await write(archivePath,{kind,...change(record,'archive')});
    const path=archivePath+'?kind='+kind;
    const before=await count();
    let lastOwnerRecord;
    for(const [identity,scope,email] of [[headers,'','owner@example.test'],[other,shared,'other@example.test']]){
      const response=await request(path+scope,{headers:identity});
      assert.equal(response.status,200,await response.clone().text());
      const ids=(await response.json()).records.map(item=>item.id);
      assert.ok(ids.includes(record.id),kind);
      if(!scope)lastOwnerRecord=ids.at(-1);
      const [event]=await sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${team.owned}
        AND kind=${kind} AND actor_email=${email} AND action='list' AND ${record.id}::uuid=ANY(record_ids)
        ORDER BY occurred_at DESC LIMIT 1`;
      assert.deepEqual(event?.record_ids,ids);
    }
    assert.equal((await request(path+shared,{method:'HEAD',headers:other})).status,200);
    const empty=await request(path+'&after='+lastOwnerRecord,{headers});
    assert.equal(empty.status,200);
    assert.deepEqual((await empty.json()).records,[]);
    assert.equal(await count(),before+2,'Only populated record pages should add receipts.');
  }
  const owned=await permissions('owned');
  const before=await count();
  const restricted=await request(archivePath+'?kind=contacts'+owned,{headers:other});
  assert.equal(restricted.status,200);
  assert.deepEqual((await restricted.json()).records,[]);
  await write('/api/workspaces',{action:'revoke',id:grantId});
  assert.equal((await request(archivePath+'?kind=contacts'+owned,{headers:other})).status,403);
  assert.equal(await count(),before);
}

export async function verifyRestoredPortableContactArchive({restored,origin,owner,other,source,sourceOwner,fixture}){
  const send=(input,auth=owner)=>post(restored,archivePath,origin,auth,input);
  assert.deepEqual(await receipt(await send(fixture.archive)),fixture.receipt);
  const detail=crm+'?id='+fixture.candidate.id;
  assert.equal((await restored(detail,{headers:owner})).status,404);
  assert.equal((await send(change(fixture.receipt,'restore'),other)).status,404);
  const input=change(fixture.receipt,'restore');
  const result=await receipt(await send(input));
  const visible=await (await restored(detail,{headers:owner})).json();
  assert.deepEqual([visible.id,visible.revision,visible.data],[fixture.candidate.id,result.revision,fixture.candidate.data]);
  assert.equal((await source(detail,{headers:sourceOwner})).status,404);
}
