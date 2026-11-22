import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';

const base='/api/v1/records/';
const settings='/api/api-tokens';
const bearer=token=>({authorization:'Bearer '+token});
const post=(request,origin,headers,body)=>request(settings,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
const batchPath=kind=>base+kind+'/batch/read';
const batchInputs=(...ids)=>({inputs:ids.map(id=>({id}))});
const readBatch=(request,kind,headers,body,query='')=>request(batchPath(kind)+query,{
  method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body),
});
const foundItem=(index,identifier,record)=>({index,identifier,status:'found',...record});
const missingItem=(index,identifier)=>({index,identifier,status:'error',
  error:{status:404,code:'not_found',message:'Record not found.'}});
const secretHash=token=>createHash('sha256').update(token).digest('hex');
const contactAccess={name:'Fictional contact integration',objects:['contacts'],permission:'read',days:30};
const taskAccess={...contactAccess,name:'Fictional task integration',objects:['tasks']};

export async function verifyPortableExternalApi({request,origin,headers,other,record,otherRecord,company,deal,sql,inquiryTimeline}){
  const manage=(body,auth=headers,site=origin)=>post(request,site,auth,body);
  const get=(path,auth={})=>request(path,{headers:auth});
  const list=(auth=headers)=>get(settings,auth);
  const contact=base+'contacts/'+record.id;
  const batch=(kind,auth,body,query)=>readBatch(request,kind,auth,body,query);
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;

  assert.match(await (await get('/?view=settings&section=data-management',headers)).text(),/href="\/\?view=api-access"/);
  const page=await get('/?view=api-access',headers);
  assert.equal(page.status,200);
  const pageHtml=await page.text();
  assert.match(pageHtml,/Create record token/);
  for(const kind of ['tasks','leads','tickets'])assert.match(pageHtml,new RegExp(`<select[^>]* name="${kind}"`));
  const noBearer=await get(contact,headers);
  assert.equal(noBearer.status,401);
  assert.equal(noBearer.headers.get('www-authenticate'),'Bearer');
  assert.match(noBearer.headers.get('cache-control'),/private, no-store/);
  assert.equal((await get(contact,bearer('harbor_'+randomBytes(32).toString('hex')))).status,401);
  const batchWithoutBearer=await batch('contacts',headers,batchInputs(record.id));
  assert.equal(batchWithoutBearer.status,401);
  assert.equal(batchWithoutBearer.headers.get('www-authenticate'),'Bearer');
  assert.equal((await list({})).status,401);
  assert.equal((await manage(contactAccess,headers,'https://elsewhere.example.test')).status,403);
  const mixed=await manage({name:'Warehouse connector',days:30,permissions:{contacts:'read_write_archive',companies:'read',tasks:'read_write',leads:'read_write_archive',tickets:'read_write_archive'}});
  assert.equal(mixed.status,201);
  const {info:mixedInfo}=await mixed.json();
  assert.deepEqual(mixedInfo.scopes,['contacts:read','contacts:write','contacts:archive','companies:read','tasks:read','tasks:write','leads:read','leads:write','leads:archive','tickets:read','tickets:write','tickets:archive']);
  assert.ok((await manage({action:'revoke',id:mixedInfo.id})).ok);
  for(const permissions of [{},{custom:'read'},{inquiries:'read_write'},{tickets:'delete'}]){
    assert.equal((await manage({name:'Unsupported connector',days:30,permissions})).status,400);
  }
  assert.equal((await manage({...contactAccess,objects:['inquiries','contacts'],permission:'read_write'})).status,400);
  assert.equal((await manage({...contactAccess,objects:['contacts','files']})).status,400);
  assert.equal((await manage({...contactAccess,workspaceId:randomUUID()})).status,400);

  const create=await manage(contactAccess);
  assert.equal(create.status,201);
  assert.equal(create.headers.get('cache-control'),'private, no-store');
  const {token,info}=await create.json();
  assert.match(token,/^harbor_[a-f0-9]{64}$/);
  assert.equal(info.prefix,token.slice(0,15));
  assert.deepEqual(info.scopes,['contacts:read']);
  const [stored]=await sql`SELECT token_hash,issuer_id,workspace_id FROM portable_api_tokens WHERE id=${info.id}`;
  assert.equal(stored.token_hash,secretHash(token));
  const ownerAuth=bearer(token);

  const ownSettings=await list();
  const listed=await ownSettings.text();
  assert.ok(listed.includes(info.prefix));
  assert.ok(!listed.includes(token));
  assert.ok(!listed.includes(stored.token_hash));
  assert.deepEqual(await (await list(other)).json(),{tokens:[],next:null});
  assert.equal((await manage({action:'revoke',id:info.id},other)).status,404);
  assert.equal((await list(ownerAuth)).status,401);

  const activityContact=await request('/api/crm',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'save',kind:'contacts',data:{name:'Fictional integration activity contact'}})});
  assert.equal(activityContact.status,201);
  const activityId=(await activityContact.json()).record.id;
  const callAt=Date.now()-2_000,noteAt=callAt+1_000;
  for(const [kind,occurredAt] of [['Call',callAt],['Note',noteAt]]){
    const logged=await request('/api/logged-activities?contactId='+activityId,{method:'POST',
      headers:{...headers,origin,'content-type':'application/json'},
      body:JSON.stringify({id:randomUUID(),kind,occurredAt,summary:'Fictional integration activity'})});
    assert.equal(logged.status,201);
  }
  const response=await get(contact,ownerAuth);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const own=await response.json();
  assert.equal(own.id,record.id);
  assert.equal(own.object,'contacts');
  assert.equal(typeof own.properties.name,'string');
  const activity=(await (await get(base+'contacts/'+activityId,ownerAuth)).json());
  assert.equal(activity.lastContacted,new Date(callAt).toISOString());
  assert.equal(activity.lastActivity,new Date(noteAt).toISOString());
  const inquiryDates=await (await get(base+'contacts/'+inquiryTimeline.contactId,ownerAuth)).json();
  const timelinePage=await (await get(inquiryTimeline.path,headers)).json();
  assert.equal(inquiryDates.lastActivity,new Date(timelinePage.lastActivity).toISOString());
  assert.equal(inquiryDates.lastContacted,null);
  assert.ok(!JSON.stringify(inquiryDates).includes(inquiryTimeline.preserved.summary));
  const upperId=record.id.toUpperCase();
  const orderedBatch=await batch('contacts',ownerAuth,batchInputs(activityId,upperId),'?archived=false');
  assert.equal(orderedBatch.status,200);
  assert.match(orderedBatch.headers.get('cache-control'),/private, no-store/);
  assert.deepEqual(await orderedBatch.json(),{results:[foundItem(0,activityId,activity),foundItem(1,upperId,own)]});
  const projected=await batch('contacts',ownerAuth,{...batchInputs(activityId),properties:['name','department']});
  assert.equal(projected.status,200);
  assert.deepEqual(await projected.json(),{results:[foundItem(0,activityId,{
    ...activity,properties:{name:'Fictional integration activity contact'},
  })]});
  const metadata=await batch('contacts',ownerAuth,{...batchInputs(record.id),properties:[]});
  assert.equal(metadata.status,200);
  assert.deepEqual(await metadata.json(),{results:[foundItem(0,record.id,{...own,properties:{}})]});

  const absentIds=Array.from({length:46},()=>randomUUID());
  for(const invalid of [batchInputs(),batchInputs('invalid'),batchInputs(record.id,upperId),
    batchInputs(...Array.from({length:51},()=>randomUUID())),
    {inputs:[{id:record.id,workspaceId:stored.workspace_id}]},
    {...batchInputs(record.id),idProperty:'email'},...[
      'name',null,[''],[123],['x'.repeat(151)],Array(101).fill('name'),['__proto__'],
      ['amount'],['recordOwner'],['companyId'],['custom:not-a-field-id'],['custom:'+randomUUID()],
    ].map(properties=>({...batchInputs(record.id),properties}))]){
    assert.equal((await batch('contacts',ownerAuth,invalid)).status,400);
  }
  assert.equal((await batch('contacts',ownerAuth,batchInputs(record.id),'?archived=true')).status,403);
  for(const query of ['?archived=','?archived=false&archived=false','?workspaceId='+stored.workspace_id]){
    assert.equal((await batch('contacts',ownerAuth,batchInputs(record.id),query)).status,400);
  }
  const overLimit=new ReadableStream({start(controller){
    const chunk=new TextEncoder().encode(' '.repeat(4097));
    controller.enqueue(chunk);
    controller.enqueue(chunk);
    controller.close();
  }});
  assert.equal((await request(batchPath('contacts'),{method:'POST',headers:{...ownerAuth,'content-type':'application/json'},
    body:overLimit,duplex:'half'})).status,413);
  const [prior]=await sql`SELECT id FROM contacts WHERE workspace_id=${stored.workspace_id} AND archived_at IS NULL AND id<${activityId} ORDER BY id DESC LIMIT 1`;
  const aroundActivity=base+'contacts?limit=1'+(prior?'&after='+prior.id:'');
  assert.equal((await (await get(aroundActivity,ownerAuth)).json()).results[0].id,activityId);
  await sql`UPDATE contacts SET archived_at=now() WHERE id=${activityId}`;
  try{
    assert.equal((await get(base+'contacts/'+activityId,ownerAuth)).status,404);
    assert.ok(!(await (await get(aroundActivity,ownerAuth)).json()).results.some(row=>row.id===activityId));
    const mixed=await batch('contacts',ownerAuth,{
      ...batchInputs(otherRecord.id,record.id,company.id,activityId,...absentIds),properties:['name'],
    });
    assert.equal(mixed.status,207);
    assert.match(mixed.headers.get('cache-control'),/private, no-store/);
    assert.deepEqual(await mixed.json(),{results:[missingItem(0,otherRecord.id),foundItem(1,record.id,{...own,properties:{name:own.properties.name}}),
      missingItem(2,company.id),missingItem(3,activityId),...absentIds.map((id,index)=>missingItem(index+4,id))]});
  }finally{
    await sql`UPDATE contacts SET archived_at=NULL WHERE id=${activityId}`;
  }
  assert.match(own.etag,/^"[a-f0-9]{64}"$/);
  assert.equal(response.headers.get('etag'),own.etag);
  assert.equal((await get(base+'contacts/'+otherRecord.id,ownerAuth)).status,404);
  assert.equal((await get(base+'companies/'+company.id,ownerAuth)).status,403);
  assert.equal((await get(base+'deals',ownerAuth)).status,403);
  assert.equal((await get(base+'tasks',ownerAuth)).status,403);
  assert.equal((await get(base+'leads',ownerAuth)).status,403);
  assert.equal((await get(base+'tickets',ownerAuth)).status,403);
  assert.equal((await get(base+'contacts/search',ownerAuth)).status,404);
  assert.equal((await get(base+'contacts?workspaceId='+randomUUID(),ownerAuth)).status,400);
  for(const query of ['limit=51','limit=0','limit=1&limit=2','after=invalid']){
    assert.equal((await get(base+'contacts?'+query,ownerAuth)).status,400);
  }
  for(const [method,path] of [['POST',base+'contacts'],['PATCH',contact],['DELETE',contact]]){
    assert.equal((await request(path,{method,headers:ownerAuth})).status,403);
  }
  const first=await (await get(base+'contacts?limit=1',ownerAuth)).json();
  assert.equal(first.results.length,1);
  assert.equal(first.next.after,first.results[0].id);
  const second=await (await get(base+'contacts?limit=1&after='+first.next.after,ownerAuth)).json();
  assert.equal(second.results.length,1);
  assert.ok(second.results[0].id>first.results[0].id);

  const otherToken=(await (await manage(contactAccess,other)).json()).token;
  assert.equal((await get(contact,bearer(otherToken))).status,404);
  assert.equal((await get(base+'contacts/'+otherRecord.id,bearer(otherToken))).status,200);
  const multi=(await (await manage({...contactAccess,objects:['companies','deals']})).json()).token;
  // Leave one read in the shared token budget, with time to test across a minute boundary.
  const tokenSubject='token:'+stored.issuer_id;
  const readBudget=()=>sql`SELECT minute,used FROM portable_request_budgets WHERE scope='api_read' AND subject=${tokenSubject}`;
  const [previousBudget]=await readBudget();
  await sql`INSERT INTO portable_request_budgets(scope,subject,minute,used)
    VALUES('api_read',${tokenSubject},floor(extract(epoch FROM clock_timestamp())/60)::integer+1,119)
    ON CONFLICT(scope,subject) DO UPDATE SET minute=excluded.minute,used=excluded.used`;
  try{
    assert.equal((await get(contact,ownerAuth)).status,200);
    assert.equal((await readBudget())[0].used,120);
    const limited=await Promise.all([
      batch('deals',bearer(multi),batchInputs(deal.id)),
      get(base+'companies',bearer(multi)),
    ]);
    for(const response of limited){
      assert.equal(response.status,429);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.equal(response.headers.get('retry-after'),'60');
    }
    assert.equal((await readBudget())[0].used,120);
    assert.equal((await get(base+'contacts/'+otherRecord.id,bearer(otherToken))).status,200);
    assert.equal((await get('/api/crm?id='+record.id,headers)).status,200);

    await sql`UPDATE portable_request_budgets SET minute=floor(extract(epoch FROM clock_timestamp())/60)::integer-1
      WHERE scope='api_read' AND subject=${tokenSubject}`;
    assert.equal((await batch('deals',bearer(multi),batchInputs(deal.id))).status,200);
    assert.equal((await readBudget())[0].used,1);
  }finally{
    if(previousBudget){
      await sql`UPDATE portable_request_budgets SET minute=${previousBudget.minute},used=${previousBudget.used}
        WHERE scope='api_read' AND subject=${tokenSubject}`;
    }else{
      await sql`DELETE FROM portable_request_budgets WHERE scope='api_read' AND subject=${tokenSubject}`;
    }
  }
  for(const [kind,expected] of [['companies',company],['deals',deal]]){
    const detail=await get(base+kind+'/'+expected.id,bearer(multi));
    assert.equal(detail.status,200);
    const body=await detail.json();
    assert.deepEqual(body.properties,expected.data);
    assert.equal('lastContacted' in body,false);
    assert.equal('lastActivity' in body,false);
    const batchResult=await batch(kind,bearer(multi),batchInputs(expected.id));
    assert.equal(batchResult.status,200);
    assert.deepEqual(await batchResult.json(),{results:[foundItem(0,expected.id,body)]});
    const field=kind==='companies'?'domain':'amount';
    const selected=await batch(kind,bearer(multi),{...batchInputs(expected.id),properties:[field]});
    assert.equal(selected.status,200);
    assert.deepEqual(await selected.json(),{results:[foundItem(0,expected.id,{
      ...body,properties:{[field]:body.properties[field]},
    })]});
    let after,found=false;
    for(let page=0;page<10;page++){
      const query=new URLSearchParams({limit:'25'});
      if(after)query.set('after',after);
      const response=await get(base+kind+'?'+query,bearer(multi));
      assert.equal(response.status,200);
      const result=await response.json();
      found=result.results.some(row=>row.id===expected.id);
      if(found||!result.next)break;
      after=result.next.after;
    }
    assert.ok(found);
  }
  assert.equal((await get(contact,bearer(multi))).status,403);
  assert.equal((await batch('contacts',bearer(multi),batchInputs(record.id))).status,403);

  const makeTask=async(auth,data)=>{
    const result=await request('/api/crm',{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'tasks',...data})});
    assert.equal(result.status,201,await result.clone().text());
    return (await result.json()).record;
  };
  const task=await makeTask(headers,{
    data:{name:'Fictional follow-up task',notes:'Task-scoped note'},
    related:{kind:'contacts',id:record.id},assigneeId:stored.issuer_id,
  });
  const secondTask=await makeTask(headers,{data:{name:'Fictional second follow-up'}});
  const foreignTask=await makeTask(other,{data:{name:'Fictional foreign follow-up'}});
  const issueTaskToken=await manage(taskAccess);
  assert.equal(issueTaskToken.status,201);
  const taskCredential=await issueTaskToken.json();
  assert.deepEqual(taskCredential.info.scopes,['tasks:read']);
  const taskAuth=bearer(taskCredential.token),taskPath=base+'tasks/'+task.id;
  const taskDetail=await get(taskPath,taskAuth);
  assert.equal(taskDetail.status,200);
  assert.equal(taskDetail.headers.get('cache-control'),'private, no-store');
  const externalTask=await taskDetail.json();
  assert.deepEqual(externalTask,{id:task.id,object:'tasks',properties:task.data,createdAt:task.createdAt,
    updatedAt:task.updatedAt,etag:taskDetail.headers.get('etag')});
  assert.match(externalTask.etag,/^"[a-f0-9]{64}"$/);
  assert.ok(!JSON.stringify(externalTask).includes(record.id));
  assert.ok(!JSON.stringify(externalTask).includes(stored.issuer_id));
  assert.equal((await get(contact,taskAuth)).status,403);
  assert.equal((await get(base+'tasks/'+foreignTask.id,taskAuth)).status,404);
  const taskBatch=await batch('tasks',taskAuth,batchInputs(task.id,foreignTask.id));
  assert.equal(taskBatch.status,207);
  assert.deepEqual(await taskBatch.json(),{results:[foundItem(0,task.id,externalTask),missingItem(1,foreignTask.id)]});
  const taskNotes=await batch('tasks',taskAuth,{...batchInputs(task.id),properties:['notes']});
  assert.equal(taskNotes.status,200);
  assert.deepEqual(await taskNotes.json(),{results:[foundItem(0,task.id,{
    ...externalTask,properties:{notes:'Task-scoped note'},
  })]});
  for(const field of ['assigneeId','queueId','contactId']){
    assert.equal((await batch('tasks',taskAuth,{...batchInputs(task.id),properties:[field]})).status,400);
  }
  assert.equal((await get(taskPath+'?limit=1',taskAuth)).status,400);
  assert.equal((await get(base+'tasks?workspaceId='+stored.workspace_id,taskAuth)).status,400);
  assert.equal((await get(base+'tasks?limit=51',taskAuth)).status,400);
  for(const [method,path] of [['POST',base+'tasks'],['PATCH',taskPath],['PUT',taskPath],['DELETE',taskPath]]){
    assert.equal((await request(path,{method,headers:taskAuth})).status,method==='PUT'?404:403);
  }
  const [earlier,later]=[task,secondTask].sort((a,b)=>a.id.localeCompare(b.id));
  const [previousTask]=await sql`SELECT id FROM portable_tasks WHERE workspace_id=${stored.workspace_id}
    AND id<${earlier.id} ORDER BY id DESC LIMIT 1`;
  const firstTasks=await (await get(base+'tasks?limit=1'+(previousTask?'&after='+previousTask.id:''),taskAuth)).json();
  assert.equal(firstTasks.results.length,1);
  assert.equal(firstTasks.results[0].id,earlier.id);
  assert.equal(firstTasks.next.after,earlier.id);
  const [{count:betweenTasks}]=await sql`SELECT count(*)::int AS count FROM portable_tasks
    WHERE workspace_id=${stored.workspace_id} AND id>${earlier.id} AND id<=${later.id}`;
  let after=firstTasks.next.after,foundLater=false;
  // UUIDs are randomly placed. A growing fixture can put the later Task more
  // than one page away even though the continuation is correct.
  for(let page=0;after&&!foundLater&&page<Math.ceil(betweenTasks/50);page++){
    const response=await get(base+'tasks?limit=50&after='+after,taskAuth);
    assert.equal(response.status,200);
    const next=await response.json();
    assert.ok(next.results.every(row=>row.id>after&&row.id!==foreignTask.id));
    foundLater=next.results.some(row=>row.id===later.id);
    after=next.next?.after;
  }
  assert.ok(foundLater);
  assert.equal((await manage({action:'revoke',id:taskCredential.info.id},other)).status,404);
  assert.equal((await manage({action:'revoke',id:taskCredential.info.id})).status,200);
  assert.equal((await get(taskPath,taskAuth)).status,401);
  assert.equal((await batch('tasks',taskAuth,batchInputs(task.id))).status,401);

  const privateRecords=[];
  for(const [kind,otherKind] of [['leads','tickets'],['tickets','leads']]){
    const path='/api/'+kind;
    const create=async(auth,data,links={})=>{
      const response=await request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
        body:JSON.stringify({action:'save',data,...links})});
      assert.equal(response.status,201,await response.clone().text());
      const saved=await response.json();
      if(saved.record)return saved.record;
      const detail=await get(path+'?id='+saved.id,auth);
      assert.equal(detail.status,200);
      return detail.json();
    };
    const data=kind==='tickets'?{owner:'Fictional identity '+stored.issuer_id,ticketStatus:'Waiting on us'}:
      {leadType:'New business',leadLabel:'Warm'};
    const primary=await create(headers,{name:'Fictional linked '+kind,...data},{contactId:record.id,companyId:company.id});
    assert.deepEqual([primary.contactId,primary.companyId],[record.id,company.id]);
    const secondary=await create(headers,{name:'Fictional second '+kind});
    const foreign=await create(other,{name:'Fictional foreign '+kind});
    const access={...contactAccess,name:'Fictional '+kind+' integration',objects:[kind]};
    const issued=await manage(access);
    assert.equal(issued.status,201);
    const credential=await issued.json();
    assert.deepEqual(credential.info.scopes,[kind+':read']);
    const auth=bearer(credential.token),collection=base+kind,detailPath=collection+'/'+primary.id;
    const detail=await get(detailPath,auth);
    assert.equal(detail.status,200);
    assert.equal(detail.headers.get('cache-control'),'private, no-store');
    const external=await detail.json();
    const properties={...primary.data};
    delete properties.owner;
    assert.deepEqual(external,{id:primary.id,object:kind,properties,createdAt:new Date(primary.createdAt).toISOString(),
      updatedAt:new Date(primary.updatedAt).toISOString(),etag:detail.headers.get('etag')});
    assert.match(external.etag,/^"[a-f0-9]{64}"$/);
    assert.equal((await get(contact,auth)).status,403);
    assert.equal((await get(base+otherKind,auth)).status,403);
    assert.equal((await get(collection+'/'+foreign.id,auth)).status,404);
    const privateBatch=await batch(kind,auth,batchInputs(foreign.id,primary.id));
    assert.equal(privateBatch.status,207);
    assert.deepEqual(await privateBatch.json(),{results:[missingItem(0,foreign.id),foundItem(1,primary.id,external)]});
    const field=kind==='leads'?'leadLabel':'ticketStatus';
    const selected=await batch(kind,auth,{...batchInputs(primary.id),properties:[field]});
    assert.equal(selected.status,200);
    assert.deepEqual(await selected.json(),{results:[foundItem(0,primary.id,{
      ...external,properties:{[field]:data[field]},
    })]});
    assert.equal((await batch(kind,auth,{...batchInputs(primary.id),properties:['owner']})).status,400);
    assert.equal((await get(collection+'?workspaceId='+stored.workspace_id,auth)).status,400);
    assert.equal((await get(collection+'?limit=51',auth)).status,400);
    for(const [method,endpoint] of [['POST',collection],['PATCH',detailPath],['PUT',detailPath],['DELETE',detailPath]]){
      assert.equal((await request(endpoint,{method,headers:auth})).status,method==='PUT'?404:403);
    }
    const [earlier,later]=[primary,secondary].sort((a,b)=>a.id.localeCompare(b.id));
    const [prior]=await sql`SELECT id FROM ${sql('portable_'+kind)} WHERE workspace_id=${stored.workspace_id}
      AND id<${earlier.id} ORDER BY id DESC LIMIT 1`;
    const first=await (await get(collection+'?limit=1'+(prior?'&after='+prior.id:''),auth)).json();
    assert.deepEqual(first.results.map(row=>row.id),[earlier.id]);
    assert.equal(first.next.after,earlier.id);
    const next=await (await get(collection+'?limit=50&after='+first.next.after,auth)).json();
    assert.ok(next.results.some(row=>row.id===later.id));
    assert.ok(next.results.every(row=>row.id>earlier.id&&row.id!==foreign.id));
    privateRecords.push({access,auth,detailPath,external});
  }

  await sql`UPDATE portable_api_tokens SET expires_at=0 WHERE token_hash=${secretHash(multi)}`;
  assert.equal((await get(base+'deals',bearer(multi))).status,401);
  assert.equal((await batch('deals',bearer(multi),batchInputs(deal.id))).status,401);
  await sql`UPDATE login_identities SET email='disabled-owner@example.test' WHERE id=${stored.issuer_id}`;
  try{assert.equal((await get(contact,ownerAuth)).status,403);}
  finally{await sql`UPDATE login_identities SET email='owner@example.test' WHERE id=${stored.issuer_id}`;}
  assert.equal((await get(contact,ownerAuth)).status,200);
  assert.equal((await manage({action:'revoke',id:info.id})).status,200);
  assert.equal((await manage({action:'revoke',id:info.id})).status,200);
  assert.equal((await get(contact,ownerAuth)).status,401);

  const fresh=(await (await manage(contactAccess)).json()).token;
  assert.equal((await get(contact,bearer(fresh))).status,200);
  const freshTask=(await (await manage(taskAccess)).json()).token;
  assert.equal((await get(taskPath,bearer(freshTask))).status,200);
  return async ({restored,origin:restoreOrigin,owner,targetSql})=>{
    assert.equal((await targetSql`SELECT count(*)::int AS count FROM portable_api_tokens`)[0].count,0);
    assert.equal((await restored(contact,{headers:bearer(fresh)})).status,401);
    assert.equal((await readBatch(restored,'contacts',bearer(fresh),batchInputs(record.id))).status,401);
    assert.equal((await get(contact,bearer(fresh))).status,200);
    const newCredential=await post(restored,restoreOrigin,owner,contactAccess);
    assert.equal(newCredential.status,201);
    const newToken=(await newCredential.json()).token;
    const restoredRecord=await restored(contact,{headers:bearer(newToken)});
    assert.equal(restoredRecord.status,200);
    assert.deepEqual(await restoredRecord.json(),own);
    const restoredBatch=await readBatch(restored,'contacts',bearer(newToken),batchInputs(record.id));
    assert.equal(restoredBatch.status,200);
    assert.deepEqual(await restoredBatch.json(),{results:[foundItem(0,record.id,own)]});
    const restoredProjection=await readBatch(restored,'contacts',bearer(newToken),{...batchInputs(record.id),properties:['name']});
    assert.equal(restoredProjection.status,200);
    assert.deepEqual(await restoredProjection.json(),{results:[foundItem(0,record.id,{...own,properties:{name:own.properties.name}})]});
    assert.equal((await get(contact,bearer(newToken))).status,401);
    assert.equal((await restored(taskPath,{headers:bearer(freshTask)})).status,401);
    const restoredTaskCredential=await post(restored,restoreOrigin,owner,taskAccess);
    assert.equal(restoredTaskCredential.status,201);
    const restoredTaskAuth=bearer((await restoredTaskCredential.json()).token);
    const restoredTask=await restored(taskPath,{headers:restoredTaskAuth});
    assert.equal(restoredTask.status,200);
    assert.deepEqual(await restoredTask.json(),externalTask);
    assert.equal((await restored(contact,{headers:restoredTaskAuth})).status,403);
    for(const {access,auth,detailPath,external} of privateRecords){
      assert.equal((await restored(detailPath,{headers:auth})).status,401);
      const credential=await post(restored,restoreOrigin,owner,access);
      assert.equal(credential.status,201);
      const newAuth=bearer((await credential.json()).token);
      const restoredRecord=await restored(detailPath,{headers:newAuth});
      assert.equal(restoredRecord.status,200);
      assert.deepEqual(await restoredRecord.json(),external);
      assert.equal((await restored(contact,{headers:newAuth})).status,403);
    }
  };
}
