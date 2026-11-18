import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';

const crm='/api/crm',mergePath='/api/record-merge';
const execute=promisify(execFile);
const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
const cwd=process.env.HARBOR_TEST_PORTABLE_CWD;

export async function verifyPortableContactMerge({request,origin,headers,other,sql,sharing,env}){
  const workspaceId=sharing.workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const send=(path,body,auth=headers)=>request(path,{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const create=async(path,body)=>{
    const response=await send(path,{action:'save',...body});
    assert.equal(response.status,201,await response.clone().text());
    const result=await response.json();
    return result.record??result;
  };
  const read=async path=>{
    const response=await request(path,{headers});
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  const call=async(body,auth=headers,path=mergePath)=>{
    const response=await send(path,body,auth);
    return {status:response.status,...await response.json()};
  };
  const preview=(primary,secondary,auth,path)=>call({action:'preview',kind:'contacts',primaryId:primary.id,secondaryId:secondary.id},auth,path);
  const commit=(review,choices={},requestId=randomUUID(),auth,path)=>call({action:'merge',kind:'contacts',primaryId:review.primary.id,
    secondaryId:review.secondary.id,requestId,expectedRevisions:{primary:review.primary.revision,secondary:review.secondary.revision},choices},auth,path);
  const [{id:ownerId}]=await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`;

  const marker='Contact merge '+randomUUID();
  const kept=await create(crm,{kind:'companies',data:{name:marker+' kept company'}});
  const chosen=await create(crm,{kind:'companies',data:{name:marker+' chosen company'}});
  const email='merge-'+randomUUID().slice(0,8)+'@example.test';
  const keep=await create(crm,{kind:'contacts',primaryCompanyId:kept.id,data:{name:marker+' keep',phone:'+1 555 0100'}});
  const duplicate=await create(crm,{kind:'contacts',primaryCompanyId:chosen.id,data:{name:marker+' duplicate',email,title:'Fictional buyer'}});
  await sql`UPDATE contacts SET created_at='2018-06-01T00:00:00Z' WHERE workspace_id=${workspaceId} AND id=${duplicate.id}`;
  const deal=await create(crm,{kind:'deals',primaryContactId:duplicate.id,data:{name:marker+' deal'}});
  const task=await create(crm,{kind:'tasks',related:{kind:'contacts',id:duplicate.id},data:{name:marker+' task'}});
  const lead=await create('/api/leads',{contactId:duplicate.id,data:{name:marker+' lead'}});
  const ticket=await create('/api/tickets',{contactId:duplicate.id,data:{name:marker+' ticket'}});
  const activityId=randomUUID();
  assert.equal((await send('/api/logged-activities?contactId='+duplicate.id,
    {id:activityId,kind:'Call',occurredAt:Date.now()-5000,summary:'Fictional merged Contact call'})).status,201);
  const dealLinks='/api/associations?'+new URLSearchParams({kind:'deals',id:deal.id});
  for(const [id,labels] of [[keep.id,['Buyer']],[duplicate.id,['Advisor']]]){
    assert.equal((await send(dealLinks,{action:'link',target:{kind:'contacts',id},labels})).status,200);
  }

  // A stored file moves with the merge without copying its object.
  const withFile=await create(crm,{kind:'contacts',data:{name:marker+' spare'}});
  const fileId=randomUUID(),versionId=randomUUID(),bytes=Uint8Array.from([7,1,2,9]);
  const uploaded=await request('/api/record-attachments?'+new URLSearchParams({recordId:duplicate.id,fileId,versionId}),
    {method:'POST',headers:{...headers,origin,'x-harbor-file-name':encodeURIComponent('Fictional merge.txt')},body:bytes});
  assert.equal(uploaded.status,200,await uploaded.clone().text());
  const colliding=await request('/api/record-attachments?'+new URLSearchParams({recordId:withFile.id,fileId,versionId:randomUUID()}),
    {method:'POST',headers:{...headers,origin,'x-harbor-file-name':'Collision.txt'},body:bytes});
  assert.equal(colliding.status,200);
  assert.equal((await preview(withFile,duplicate)).status,409,'preview flags the duplicate file ID');
  assert.equal((await commit({primary:withFile,secondary:duplicate})).status,409,'a direct merge cannot combine separate files');
  assert.equal((await read(crm+'?kind=contacts&id='+duplicate.id)).revision,duplicate.revision);

  assert.equal((await preview(keep,kept)).status,404,'a Company is not a Contact');

  let review=(await preview(keep,duplicate)).preview;
  assert.equal(review.kind,'contacts');
  assert.deepEqual([review.defaults.name,review.defaults.email,review.defaults.title,review.defaults.phone,review.defaults.primaryCompanyId],
    ['primary','secondary','secondary','primary','primary']);
  assert.deepEqual(review.companyNames,{[kept.id]:marker+' kept company',[chosen.id]:marker+' chosen company'});
  assert.deepEqual(review.counts,{deals:1,leads:1,tickets:1,tasks:1,activities:1,meetings:0,notes:0,inquiries:0,segments:0,files:1,associations:1});

  const segmentId=randomUUID(),workflowId=randomUUID(),match=marker+' duplicate',workflowBody='Review '+marker;
  const segment={id:segmentId,revision:0,name:marker,kind:'contacts',mode:'active',
    criteria:{groups:[[{field:'name',operator:'contains',value:match}]]}};
  assert.equal((await send('/api/segments',{action:'save',segment})).status,201);
  assert.equal((await send('/api/workflows',{action:'save',id:workflowId,revision:0,definition:{
    name:marker,trigger:'contact_segment',segmentId,delayMinutes:15,body:workflowBody,
  }})).status,200);
  assert.equal((await send('/api/workflows',{action:'setEnabled',id:workflowId,revision:1,enabled:true})).status,200);
  const scans=async()=>{
    for(let page=0;page<50;page++){
      await sql`UPDATE portable_segment_workflow_scans SET next_at=0,retry_at=NULL
        WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId}`;
      await execute(process.execPath,[command,'worker','--once'],{
        env:{...env,HARBOR_PORTABLE_GMAIL_ENABLED:'false',HARBOR_PORTABLE_CODE_ENABLED:'false'},cwd,timeout:6_000,
      });
      const [scan]=await sql`SELECT baseline,cursor,next_at,waiting_for_capacity FROM portable_segment_workflow_scans
        WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId}`;
      assert.equal(scan.waiting_for_capacity,false);
      if(Number(scan.next_at)>0&&!scan.baseline&&!scan.cursor)return;
    }
    assert.fail('The merge segment scan did not finish.');
  };
  const enrollments=()=>sql`SELECT contact_revision,job_id FROM portable_workflow_runs
    WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId} AND contact_id=${keep.id}`;
  const jobs=()=>sql`SELECT id,status FROM portable_jobs
    WHERE workspace_id=${workspaceId} AND contact_id=${keep.id} AND body=${workflowBody}`;
  await scans();
  assert.equal((await enrollments()).length,0);

  const requestId=randomUUID();
  const merged=await commit(review,{name:'secondary',primaryCompanyId:'secondary'},requestId);
  assert.equal(merged.status,200,JSON.stringify(merged));
  assert.equal(merged.receipt.revision,keep.revision+1);

  // The kept Contact has the chosen values and both Companies.
  const result=await read(crm+'?kind=contacts&id='+keep.id);
  assert.deepEqual([result.data.name,result.data.email,result.data.title,result.data.phone,result.primaryCompanyId],
    [marker+' duplicate',email,'Fictional buyer','+1 555 0100',chosen.id]);
  assert.equal(new Date(result.createdAt).toISOString(),'2018-06-01T00:00:00.000Z');
  const companyLinks=(await read('/api/associations?'+new URLSearchParams({kind:'contacts',id:keep.id}))).items;
  assert.ok(companyLinks.some(item=>item.target.id===kept.id),'the former primary Company stays linked');
  assert.equal((await request(crm+'?kind=contacts&id='+duplicate.id,{headers})).status,404);
  assert.equal((await sql`SELECT merged_into_id FROM contacts WHERE workspace_id=${workspaceId} AND id=${duplicate.id}`)[0].merged_into_id,keep.id);

  // Linked records follow the kept Contact.
  const movedDeal=await read(crm+'?kind=deals&id='+deal.id);
  assert.deepEqual([movedDeal.primaryContactId,movedDeal.revision],[keep.id,deal.revision+1]);
  const [dealEvent]=await sql`SELECT actor_id,previous_primary_contact_id FROM deal_events
    WHERE workspace_id=${workspaceId} AND deal_id=${deal.id} AND revision=${movedDeal.revision}`;
  assert.deepEqual({...dealEvent},{actor_id:ownerId,previous_primary_contact_id:duplicate.id});
  assert.equal((await read(crm+'?kind=tasks&id='+task.id)).contactId,keep.id);
  assert.equal((await read('/api/leads?id='+lead.id)).contactId,keep.id);
  const leadHistory=await read('/api/leads?view=history&id='+lead.id);
  assert.deepEqual(leadHistory.entries.map(event=>event.revision),[2,1]);
  assert.equal(leadHistory.entries[0].previous.contactId,duplicate.id);
  assert.equal(leadHistory.entries[0].data.contactId,keep.id);
  assert.equal((await read('/api/tickets?id='+ticket.id)).contactId,keep.id);
  assert.ok((await read('/api/logged-activities?contactId='+keep.id)).items.some(item=>item.id===activityId));
  const download=await request('/api/record-attachments?'+new URLSearchParams({recordId:keep.id,fileId}),{headers});
  assert.equal(download.status,200,await download.clone().text());
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()),bytes);
  assert.deepEqual((await read('/api/record-attachments?recordId='+keep.id)).files.map(file=>file.id),[fileId]);
  assert.deepEqual((await read(dealLinks)).items.filter(item=>item.target.kind==='contacts').map(item=>[item.target.id,item.labels]),
    [[keep.id,['Advisor','Buyer']]]);

  // Merged Contacts stay out of the Recycle Bin; a retry replays the receipt.
  assert.ok(!(await read('/api/recycle-bin')).records.some(row=>row.id===duplicate.id));
  assert.equal((await send('/api/recycle-bin',{action:'restore',id:duplicate.id,expectedRevision:review.secondary.revision+1,requestId:randomUUID()})).status,404);
  assert.deepEqual((await commit(review,{name:'secondary',primaryCompanyId:'secondary'},requestId)).receipt,merged.receipt);

  await scans();
  assert.equal((await enrollments()).length,0,'A merge-induced segment entry must stay quiet.');
  assert.equal((await jobs()).length,0,'A merge-induced segment entry must not queue a Note.');
  const editName=async(record,name)=>{
    const response=await send(crm,{action:'save',kind:'contacts',id:record.id,expectedRevision:record.revision,
      data:{...record.data,name},primaryCompanyId:record.primaryCompanyId});
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).record;
  };
  const left=await editName(result,marker+' keep');
  await scans();
  const returned=await editName(left,match);
  await scans();
  await scans();
  const runs=await enrollments();
  assert.equal(runs.length,1,'An ordinary re-entry must enroll once.');
  assert.equal(runs[0].contact_revision,returned.revision);
  assert.deepEqual(Array.from(await jobs(),row=>({...row})),[{id:runs[0].job_id,status:'queued'}]);
  assert.equal((await send('/api/workflows',{action:'setEnabled',id:workflowId,revision:2,enabled:false})).status,200);
  await sql.begin(async tx=>{
    await tx`DELETE FROM portable_workflow_runs WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId}`;
    await tx`DELETE FROM portable_jobs WHERE workspace_id=${workspaceId} AND id=${runs[0].job_id}`;
    await tx`DELETE FROM portable_segment_workflow_members WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId}`;
    await tx`DELETE FROM portable_segment_workflow_scans WHERE workspace_id=${workspaceId} AND workflow_id=${workflowId}`;
    await tx`DELETE FROM portable_deal_workflows WHERE workspace_id=${workspaceId} AND id=${workflowId}`;
    await tx`DELETE FROM portable_segments WHERE workspace_id=${workspaceId} AND id=${segmentId}`;
  });
  const second=await create(crm,{kind:'contacts',data:{name:marker+' second'}});

  // Shared editors merge through their grant.
  const scoped=mergePath+'?'+new URLSearchParams({workspaceId,grantId:sharing.grantId});
  const [grants]=await sql`SELECT contact_files,scheduled_notes,contact_outreach,record_activities FROM portable_workspace_viewers WHERE id=${sharing.grantId}`;
  await sql`UPDATE portable_workspace_viewers SET contact_files=false,scheduled_notes=true,contact_outreach=true,record_activities=true
    WHERE id=${sharing.grantId}`;
  try{
    const attachment=await request('/api/record-attachments?'+new URLSearchParams({recordId:withFile.id,workspaceId}),{headers:other});
    assert.equal(attachment.status,404);
    assert.equal((await preview(second,withFile,other,scoped)).status,403,'file-restricted editor cannot preview a Contact merge');
    assert.equal((await commit({primary:second,secondary:withFile},{},randomUUID(),other,scoped)).status,403);
    await sql`UPDATE portable_workspace_viewers SET contact_files=true WHERE id=${sharing.grantId}`;
    review=(await preview(second,withFile,other,scoped)).preview;
    assert.equal(review.counts.files,1);
    assert.ok(!('inquiries' in review.counts)&&!('segments' in review.counts));
    assert.equal((await commit(review,{},randomUUID(),other,scoped)).status,200);
  }finally{
    await sql`UPDATE portable_workspace_viewers SET contact_files=${grants.contact_files},scheduled_notes=${grants.scheduled_notes},
      contact_outreach=${grants.contact_outreach},record_activities=${grants.record_activities} WHERE id=${sharing.grantId}`;
  }
  await reset();
  return {primaryId:keep.id,secondaryId:duplicate.id,dealId:deal.id,fileId,bytes:[...bytes]};
}

// After a second-instance restore the merge holds and links stay moved.
export async function verifyRestoredPortableContactMerge({restored,origin,owner,fixture}){
  const read=async path=>{
    const response=await restored(path,{headers:owner});
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  assert.equal((await restored(crm+'?kind=contacts&id='+fixture.secondaryId,{headers:owner})).status,404);
  assert.equal((await read(crm+'?kind=deals&id='+fixture.dealId)).primaryContactId,fixture.primaryId);
  const download=await restored('/api/record-attachments?'+new URLSearchParams({recordId:fixture.primaryId,fileId:fixture.fileId}),{headers:owner});
  assert.equal(download.status,200);
  assert.deepEqual([...new Uint8Array(await download.arrayBuffer())],fixture.bytes);
  const response=await restored('/api/recycle-bin',{method:'POST',headers:{...owner,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'restore',id:fixture.secondaryId,expectedRevision:2,requestId:randomUUID()})});
  assert.equal(response.status,404);
}
