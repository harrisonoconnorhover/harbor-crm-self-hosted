import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const recordPath=(kind,id)=>'/api/crm?'+new URLSearchParams({kind,id});
const post=(request,origin,headers,path,input)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(input)});

export async function seedPortablePilot({request,origin,headers,actorId}){
  const tag='Pilot Finch '+randomUUID();
  const save=async(kind,input,status)=>{
    const response=await post(request,origin,headers,'/api/crm',{action:'save',kind,...input});
    assert.equal(response.status,status,await response.clone().text());
    return (await response.json()).record;
  };
  async function importRecord(kind,csv){
    const send=input=>post(request,origin,headers,'/api/crm/import',{kind,csv,...input});
    const preview=await send({action:'preview'});
    assert.equal(preview.status,200);
    const {review,created,errors}=await preview.json();
    assert.deepEqual([created,errors],[1,0]);
    assert.equal((await send({action:'import',review,requestId:randomUUID()})).status,201);
    const listed=await request('/api/crm?'+new URLSearchParams({kind,search:tag}),{headers});
    assert.equal(listed.status,200);
    const {records}=await listed.json();
    assert.equal(records.length,1);
    return records[0];
  }
  const company=await importRecord('companies','Name,Domain\n'+tag+' Company,pilot-finch.example.test');
  const imported=await importRecord('contacts','Name,Email\n'+tag+',pilot-finch@example.test');
  const contact=await save('contacts',{id:imported.id,expectedRevision:imported.revision,
    data:{...imported.data,phone:'202-555-0142'},primaryCompanyId:company.id},200);
  const links={primaryContactId:contact.id,companyId:company.id};
  const createdDeal=await save('deals',{data:{name:tag+' Opportunity',amount:1250},...links},201);
  const deal=await save('deals',{id:createdDeal.id,expectedRevision:createdDeal.revision,
    data:{...createdDeal.data,stage:'Qualified to buy'},...links},200);
  assert.equal(deal.data.stage,'Qualified to buy');
  const assigned=await save('tasks',{data:{name:tag+' Follow-up'},assigneeId:actorId,contactId:contact.id},201);
  const task=await save('tasks',{id:assigned.id,expectedRevision:assigned.revision,
    data:{...assigned.data,status:'Completed'}},200);
  assert.equal(task.assigneeId,actorId);
  assert.ok(task.completedAt);

  const activityPath='/api/logged-activities?contactId='+contact.id;
  const call={id:randomUUID(),kind:'Call',occurredAt:Date.now()-86_400_000,summary:'Fictional pilot follow-up'};
  assert.equal((await post(request,origin,headers,activityPath,call)).status,201);
  const attachment='/api/record-attachments?'+new URLSearchParams({recordId:contact.id,fileId:randomUUID(),versionId:randomUUID()});
  const bytes='Fictional pilot proposal\n';
  assert.equal((await request(attachment,{method:'POST',headers:{...headers,origin,'x-harbor-file-name':'Pilot proposal.txt'},body:bytes})).status,200);
  const file=await request(attachment,{headers});
  assert.equal(file.status,200);
  assert.equal(await file.text(),bytes);

  return {tag,records:{contacts:contact,companies:company,deals:deal,tasks:task},activityPath,call,attachment,bytes};
}

export async function verifyRestoredPortablePilot({restored,owner,other,pilot}){
  for(const [kind,record] of Object.entries(pilot.records)){
    const path=recordPath(kind,record.id);
    const read=await restored(path,{headers:owner});
    assert.equal(read.status,200);
    assert.deepEqual(await read.json(),record);
    assert.equal((await restored(path,{headers:other})).status,404);
  }
  const history=await restored(pilot.activityPath,{headers:owner});
  assert.equal(history.status,200);
  const {items,lastContacted}=await history.json();
  assert.equal(lastContacted,pilot.call.occurredAt);
  assert.ok(items.some(item=>item.id===pilot.call.id&&item.summary===pilot.call.summary));
  const exportPath='/api/crm?'+new URLSearchParams({export:'csv',kind:'deals',search:pilot.tag,stage:'Qualified to buy'});
  const exported=await restored(exportPath,{headers:owner});
  assert.equal(exported.status,200);
  const csv=await exported.text();
  assert.ok(csv.includes(pilot.records.deals.id)&&csv.includes(pilot.records.contacts.id));
  const file=await restored(pilot.attachment,{headers:owner});
  assert.equal(file.status,200);
  assert.equal(await file.text(),pilot.bytes);
  const denied=await restored(pilot.attachment,{headers:other});
  assert.equal(denied.status,404);
  assert.match(denied.headers.get('cache-control')||'',/no-store/);
}

export async function verifyRestoredPilotSharing({restored,origin,owner,other,pilot,workspaceId,previousGrantId,runScheduledNote}){
  const contact=pilot.records.contacts;
  const shared=new URLSearchParams({workspaceId});
  const filePath=pilot.attachment+'&'+shared;
  const path=recordPath('contacts',contact.id);
  const sharedPath=path+'&'+shared;
  const change=(auth,input)=>post(restored,origin,auth,'/api/workspaces',input);
  const write=(grantId,name)=>post(restored,origin,other,'/api/crm?'+shared+'&grantId='+grantId,
    {action:'save',kind:'contacts',id:contact.id,expectedRevision:contact.revision,data:{...contact.data,name}});
  assert.equal((await restored(sharedPath,{headers:other})).status,404);
  assert.equal((await restored(filePath,{headers:other})).status,404);
  const invited=await change(owner,{action:'invite',email:'other@example.test'});
  assert.equal(invited.status,200);
  const {incoming:[invite]}=await (await restored('/api/workspaces',{headers:other})).json();
  assert.ok(invite);
  const accepted=await change(other,{action:'accept_invite',id:invite.id});
  assert.equal(accepted.status,200);
  const {shared:[viewer]}=await accepted.json();
  assert.equal(viewer.role,'viewer');
  assert.equal((await restored(sharedPath,{headers:other})).status,200);
  assert.equal((await write(viewer.grantId,'Denied Viewer edit')).status,403);
  assert.equal((await restored(filePath,{headers:other})).status,404);
  const promoted=await change(owner,{action:'role',id:viewer.grantId,role:'editor'});
  assert.equal(promoted.status,200);
  const {viewers:[editor]}=await promoted.json();
  const filesEnabled=await change(owner,{action:'contact_files',id:editor.id,enabled:true});
  assert.equal(filesEnabled.status,200);
  const {viewers:[fileGrant]}=await filesEnabled.json();
  const notesEnabled=await change(owner,{action:'scheduled_notes',id:fileGrant.id,enabled:true});
  assert.equal(notesEnabled.status,200);
  const {viewers:[active]}=await notesEnabled.json();
  assert.notEqual(active.id,previousGrantId);
  assert.equal((await write(previousGrantId,'Denied prior grant edit')).status,403);
  const file=await restored(filePath,{headers:other});
  assert.equal(file.status,200);
  assert.equal(await file.text(),pilot.bytes);
  const changed=await write(active.id,pilot.tag+' after recovery');
  assert.equal(changed.status,200);
  const {record:saved}=await changed.json();

  const ownerJobs='/api/background-jobs?recordId='+contact.id;
  const sharedJobs=ownerJobs+'&'+shared;
  const schedule=(input)=>post(restored,origin,other,sharedJobs+'&grantId='+active.id,input);
  const note={id:randomUUID(),body:'Fictional follow-up from the recovered pilot',scheduledFor:Date.now()+2500};
  assert.equal((await schedule(note)).status,202);
  const readJob=async()=>{
    const response=await restored(ownerJobs,{headers:owner});
    assert.equal(response.status,200);
    return (await response.json()).items.find(job=>job.id===note.id);
  };
  assert.equal((await readJob()).status,'queued');

  assert.equal((await change(owner,{action:'revoke',id:active.id})).status,200);
  const denied=await restored(filePath,{headers:other});
  assert.equal(denied.status,404);
  assert.match(denied.headers.get('cache-control')||'',/no-store/);
  assert.equal((await restored(sharedPath,{headers:other})).status,404);
  assert.deepEqual(await (await restored(path,{headers:owner})).json(),saved);
  assert.equal((await restored(sharedJobs,{headers:other})).status,404);
  assert.ok([403,404].includes((await schedule({...note,id:randomUUID()})).status));
  await runScheduledNote(note,readJob);
  const jobDetail='/?view=job-queue&jobId='+note.id;
  const completed=await restored(jobDetail,{headers:owner});
  assert.equal(completed.status,200);
  const receipt=(await completed.text()).replaceAll('<!-- -->','');
  assert.match(receipt,/Recorded actor other@example\.test/);
  assert.match(receipt,/Completed/);
  const revokedJob=await restored(jobDetail,{headers:other});
  assert.equal(revokedJob.status,404);
  assert.doesNotMatch(await revokedJob.text(),/Recorded actor/);
}
