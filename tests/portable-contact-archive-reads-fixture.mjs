import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {launchFault} from './portable-jobs-fixture.mjs';
import {verifyPortableDormantContactLinkWrites} from './portable-dormant-contact-link-fixture.mjs';

const crm='/api/crm';
const archivedAt='2026-01-02T03:04:05.000Z';
const read=(request,path,headers)=>request(path,{headers});
const post=(request,path,headers,origin,body)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const associations=(kind,id)=>'/api/associations?'+new URLSearchParams({kind,id});

export async function verifyPortableContactArchiveReads({request,origin,headers,other,record,sql,sharing,fixture,env}){
  const get=(path,auth=headers)=>read(request,path,auth);
  const send=(path,body)=>post(request,path,headers,origin,body);
  const workspaceId=sharing.workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const name='Dormant fictional Contact '+randomUUID();
  const create=async(path,body)=>{
    const response=await send(path,{action:'save',...body});
    assert.equal(response.status,201,await response.clone().text());
    const result=await response.json();
    return result.record??result;
  };
  const candidate=await create(crm,{kind:'contacts',data:{name,email:'dormant-fixture@example.test',lifecycle:'Lead'}});
  const id=candidate.id;
  const related=await Promise.all([
    create(crm,{kind:'deals',primaryContactId:id,data:{name:'Independent archived-link deal'}}),
    create(crm,{kind:'tasks',contactId:id,data:{name:'Independent archived-link task'}}),
    create('/api/leads',{contactId:id,data:{name:'Independent archived-link lead'}}),
    create('/api/tickets',{contactId:id,data:{name:'Independent archived-link ticket'}}),
  ]);
  const company=await create(crm,{kind:'companies',data:{name:'Independent archived-link company'}});
  const associationPath=associations('companies',company.id);
  assert.equal((await send(associationPath,{action:'link',target:{kind:'contacts',id},labels:['Fictional']})).status,200);
  const associationId='00000000-0000-4000-8000-000000000001';
  await sql`UPDATE portable_associations SET id=${associationId} WHERE workspace_id=${workspaceId} AND second_id=${id}`;
  const activityPath='/api/logged-activities?contactId='+id,activityId=randomUUID(),occurredAt=Date.now()-1000;
  assert.equal((await send(activityPath,{id:activityId,kind:'Note',occurredAt,summary:'Archived Contact retained activity'})).status,201);

  const notePath='/api/background-jobs?recordId='+id;
  const note={id:randomUUID(),body:'Dormant contact must not receive this Note',scheduledFor:Date.now()+60_000};
  assert.equal((await send(notePath,note)).status,202);

  const detail=crm+'?id='+id, history=crm+'?kind=contacts&history='+id+'&field=name';
  const search=crm+'?'+new URLSearchParams({search:name});
  const exportPath=crm+'?'+new URLSearchParams({kind:'contacts',export:'csv',search:name});
  const postSearch=()=>send('/api/crm/search',{kind:'contacts',query:name});
  const report=async()=>{
    const response=await send('/api/reporting',{action:'preview',definition:{name:'Contact archive counts',kind:'contacts'}});
    assert.equal(response.status,200);
    return Number((await response.json()).result.total);
  };
  const segment={id:randomUUID(),revision:0,name:'Contact archive test segment',kind:'contacts',mode:'active',
    criteria:{groups:[[{field:'name',operator:'contains',value:name}]]}};
  assert.equal((await send('/api/segments',{action:'save',segment})).status,201);
  const segmentPath='/api/segments?id='+segment.id;
  const shared='&workspaceId='+workspaceId;
  assert.equal((await get(detail+shared,other)).status,200);
  assert.equal((await get(history)).status,200);
  assert.equal((await get(activityPath)).status,200);
  assert.equal((await (await get(search)).json()).records[0].id,id);
  assert.ok((await (await get(exportPath)).text()).includes(id));
  assert.equal((await (await postSearch()).json()).total,1);
  assert.equal((await (await get(segmentPath)).json()).total,'1');
  const before=await report();
  // The feature has no application write route. Only this local test writes the marker.
  await sql`UPDATE contacts SET archived_at=${archivedAt} WHERE workspace_id=${workspaceId} AND id=${id}`;
  for(const path of [detail,history,activityPath,associations('contacts',id),
    crm+'?kind=tasks&completionHistoryFor='+id,'/?contact='+id,'/api/background-jobs?recordId='+id]){
    assert.equal((await get(path)).status,404,path);
  }
  assert.equal((await get(detail+shared,other)).status,404);
  assert.equal((await get(detail,other)).status,404);
  const changed={action:'save',kind:'contacts',id,expectedRevision:candidate.revision,data:{name:'Stale archived edit'}};
  assert.equal((await send(crm,changed)).status,404);
  assert.equal((await send(associationPath,{action:'unlink',linkId:associationId})).status,404);
  assert.equal((await send(associationPath,{action:'link',target:{kind:'contacts',id},labels:['Fictional']})).status,404);
  assert.equal((await send(activityPath,{id:randomUUID(),kind:'Note',occurredAt,summary:'Stale log'})).status,404);
  assert.equal((await send(activityPath,{action:'update',id:activityId,expectedRevision:1,occurredAt,summary:'Stale edit'})).status,404);
  assert.equal((await send(activityPath,{action:'remove',id:activityId,expectedRevision:1})).status,404);
  assert.equal((await send(notePath,{...note,id:randomUUID()})).status,404);
  await sql`UPDATE portable_jobs SET available_at=0 WHERE id=${note.id}`;
  const blocked=await launchFault(env,`
    const db=worker.portableDb();
    const claim=await worker.claimPortableJob(db);
    if(claim?.id!==${JSON.stringify(note.id)})throw Error('Expected the dormant Contact Note');
    process.send({id:claim.id,applied:await worker.finishNote(db,claim)});
  `);
  assert.deepEqual(blocked,{id:note.id,applied:false});
  const [held]=await sql`SELECT status,issue,attempts FROM portable_jobs WHERE id=${note.id}`;
  assert.deepEqual({...held},{status:'failed',issue:'authority_changed',attempts:1});
  assert.equal((await sql`SELECT 1 FROM portable_notes WHERE job_id=${note.id}`).length,0);
  await sql`DELETE FROM portable_job_attempts WHERE job_id=${note.id}`;
  await sql`DELETE FROM portable_jobs WHERE id=${note.id}`;
  assert.deepEqual((await (await get(search)).json()).records,[]);
  assert.deepEqual((await (await get(search+shared,other)).json()).records,[]);
  assert.ok(!(await (await get(exportPath)).text()).includes(id));
  assert.equal((await (await postSearch()).json()).counts.contacts,0);
  assert.equal((await (await get(segmentPath)).json()).total,'0');
  assert.equal((await send('/api/segments',{action:'delete',id:segment.id,revision:1})).status,200);
  assert.equal(await report(),before-1);

  const linkedPaths=[crm+'?kind=deals&id=',crm+'?kind=tasks&id=','/api/leads?id=','/api/tickets?id='];
  for(const [index,row] of related.entries()){
    const response=await get(linkedPaths[index]+row.id);
    assert.equal(response.status,200);
    const item=await response.json();
    const idField=index===0?'primaryContactId':'contactId', nameField=index===0?'primaryContactName':'contactName';
    assert.deepEqual([item.id,item[idField],item[nameField]],[row.id,null,null]);
  }
  for(const path of [crm+'?kind=deals&primaryContactId=',crm+'?kind=tasks&contactId=','/api/tickets?contactId=']){
    assert.deepEqual((await (await get(path+id)).json()).records,[]);
  }

  // Seed 25 visible edges behind the dormant edge. Filtering after LIMIT
  // would underfill this page and expose a next cursor for a full last page.
  const live=Array.from({length:25},()=>randomUUID());
  try{
    await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      SELECT ${workspaceId},id,1,'{"name":"Temporary association contact"}',now(),now() FROM unnest(${live}::uuid[]) AS id`;
    await sql`INSERT INTO portable_associations(workspace_id,id,first_kind,first_id,second_kind,second_id,labels)
      SELECT ${workspaceId},gen_random_uuid(),'companies',${company.id},'contacts',id,'[]' FROM unnest(${live}::uuid[]) AS id`;
    const page=await (await get(associationPath)).json();
    assert.equal(page.next,null);
    assert.deepEqual(new Set(page.items.map(item=>item.target.id)),new Set(live));
    assert.deepEqual(await (await get(associationPath+shared,other)).json(),page);
  }finally{
    await sql`DELETE FROM portable_associations WHERE workspace_id=${workspaceId} AND second_id=ANY(${live}::uuid[])`;
    await sql`DELETE FROM contacts WHERE workspace_id=${workspaceId} AND id=ANY(${live}::uuid[])`;
  }

  if(fixture){
    const filePath='/api/record-attachments?recordId='+record.id;
    const existing=await (await get(filePath)).json();
    assert.ok(existing.files.length>0);
    const download=filePath+'&fileId='+existing.files[0].id;
    await sql`UPDATE contacts SET archived_at=${archivedAt} WHERE workspace_id=${workspaceId} AND id=${record.id}`;
    try{
      assert.equal((await get(filePath)).status,404);
      assert.equal((await get(download)).status,404);
      assert.equal((await get(filePath+shared,other)).status,404);
    }finally{
      await sql`UPDATE contacts SET archived_at=NULL WHERE workspace_id=${workspaceId} AND id=${record.id}`;
    }
    assert.equal((await get(download)).status,200);
  }
  await verifyPortableDormantContactLinkWrites({request,origin,headers,other,record,sql,sharing,contactId:id,related});
  await reset();
  return {id,dealId:related[0].id,associationId};
}

export async function verifyRestoredContactArchiveReads({request,owner,db,fixture}){
  const {id,dealId,associationId}=fixture;
  const [dormant]=await db`SELECT archived_at FROM contacts WHERE id=${id}`;
  assert.equal(new Date(dormant.archived_at).toISOString(),archivedAt);
  assert.equal((await request(crm+'?id='+id,{headers:owner})).status,404);
  assert.equal((await request(crm+'?kind=contacts&history='+id+'&field=name',{headers:owner})).status,404);
  const [deal]=await db`SELECT primary_contact_id FROM deals WHERE id=${dealId}`;
  assert.equal(deal.primary_contact_id,id);
  assert.equal((await db`SELECT id FROM portable_associations WHERE id=${associationId} AND second_id=${id}`).length,1);
  assert.equal((await db`SELECT revision FROM contact_events WHERE contact_id=${id}`).length,1);
  assert.equal((await db`SELECT id FROM portable_contact_activities WHERE contact_id=${id}`).length,1);
  const visible=await request(crm+'?kind=deals&id='+dealId,{headers:owner});
  assert.equal(visible.status,200);
  assert.equal((await visible.json()).primaryContactId,null);
}
