import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const kinds=['contacts','companies','deals','tasks','leads','tickets'];
const base='/api/v1/records/';
const settings='/api/api-tokens';
async function result(response,status){
  assert.equal(response.status,status,await response.clone().text());
  return status===204?null:response.json();
}
export async function verifyExternalWrites({request,origin,headers,other,sql}){
  const ownerPost=(path,data,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  const issue=async(permissions,auth=headers)=>result(await ownerPost(settings,{name:'Fictional provisioning integration',days:30,permissions},auth),201);
  const external=(method,path,token,data,etag)=>request(base+path,{method,headers:{
    authorization:'Bearer '+token,...(etag?{'if-match':etag}:{}),...(data?{'content-type':'application/json'}:{})
  },...(data?{body:JSON.stringify(data)}:{})});
  const writer=await issue(Object.fromEntries(kinds.map(kind=>[kind,'read_write_archive'])));
  const limited=await issue({contacts:'read_write',companies:'read'});
  const foreign=await issue({contacts:'read_write_archive'},other);
  const history=await issue({contacts:'read_history',companies:'read_write_history',tasks:'read'});
  assert.deepEqual(history.info.scopes,['contacts:read','contacts:archive_history','companies:read','companies:write','companies:archive_history','tasks:read']);
  const invalidLinks=await ownerPost(settings,{name:'History only',days:30,permissions:{contacts:'read_history'},associationAccess:'read_write'});
  assert.equal(invalidLinks.status,400);
  const token=writer.token;
  const send=(method,path,data,etag)=>external(method,path,token,data,etag);
  const extras={contacts:{email:'studio@example.test'},companies:{domain:'studio.example.test'},deals:{amount:75},tasks:{notes:'Call after lunch'},leads:{description:'From the showroom'},tickets:{description:'A scanner question'}};
  const refill=()=>sql`DELETE FROM portable_request_budgets WHERE scope='api_write' AND subject IN
    (SELECT 'token:' || issuer_id FROM portable_api_tokens WHERE id=${writer.info.id})`;
  for(const kind of kinds){
    const id=randomUUID(),path=kind+'/'+id,create={id,properties:{name:'Fictional '+kind,...extras[kind]}};
    const created=await send('POST',kind,create),record=await result(created,201);
    assert.equal(record.id,id);assert.equal(record.properties.name,create.properties.name);
    assert.equal(created.headers.get('location'),base+path);
    assert.equal(created.headers.get('etag'),record.etag);
    const read=await result(await send('GET',path),200);
    assert.equal(read.etag,record.etag);
    const projectedResponse=await send('GET',path+'?properties=name');
    const projected=await result(projectedResponse,200);
    assert.deepEqual(projected,{...read,properties:{name:create.properties.name}});
    assert.equal(projectedResponse.headers.get('etag'),read.etag);
    assert.equal((await send('POST',kind,create)).status,409);
    const change={properties:{name:'Updated '+kind}};
    assert.equal((await send('PATCH',path,change)).status,428);
    const patched=await result(await send('PATCH',path,change,projected.etag),200);
    assert.equal(patched.properties.name,change.properties.name);
    const stamp=new Date(patched.updatedAt).getTime();
    const changed=await result(await send('GET',kind+'?'+new URLSearchParams({updatedSince:new Date(stamp).toISOString(),updatedBefore:new Date(stamp+1).toISOString()})),200);
    assert.deepEqual(changed.results.find(row=>row.id===id),patched);
    for(const field of Object.keys(extras[kind]))assert.deepEqual(patched.properties[field],read.properties[field]);
    assert.notEqual(patched.etag,read.etag);
    assert.equal((await send('PATCH',path,change,read.etag)).status,412);
    assert.equal((await send('DELETE',path,undefined,read.etag)).status,412);
    assert.equal((await send('PATCH',path,{properties:{unrecognized:true}},patched.etag)).status,400);
    if(kind==='contacts'){
      assert.equal((await external('PATCH',path,foreign.token,change,patched.etag)).status,404);
      assert.equal((await external('DELETE',path,limited.token,undefined,patched.etag)).status,403);
    }
    if(kind==='companies')assert.equal((await external('PATCH',path,limited.token,change,patched.etag)).status,403);
    if(kind==='deals'){
      const rule={action:'standardAccess',kind,id:'stage'};
      const {property}=await result(await ownerPost('/api/custom-properties',{...rule,audience:'owner',expectedRevision:0}),200);
      assert.equal((await send('PATCH',path,{properties:{stage:'Closed won'}},patched.etag)).status,403);
      assert.equal((await send('POST',kind,{id:randomUUID(),properties:{name:'Restricted start',stage:'Closed won'}})).status,403);
      const unchanged=await result(await send('GET',path),200);
      assert.equal(unchanged.etag,patched.etag);
      assert.equal(unchanged.properties.stage,patched.properties.stage);
      await result(await ownerPost('/api/custom-properties',{...rule,audience:'workspace',expectedRevision:property.revision}),200);
    }
    const noop=await result(await send('PATCH',path,change,patched.etag),200);
    assert.equal(noop.etag,patched.etag,kind+' no-op');
    if(kind==='contacts'){
      // A failed audit insert must roll back the archive, including its domain receipts.
      await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_archive_audit_unavailable
        CHECK (integration_operation IS DISTINCT FROM 'archive') NOT VALID`;
      try{
        assert.equal((await send('DELETE',path,undefined,patched.etag)).status,503);
        const [stillActive]=await sql`SELECT archived_at FROM contacts WHERE id=${id}`;
        assert.equal(stillActive.archived_at,null);
      }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_archive_audit_unavailable`;}
    }
    if(kind==='contacts'||kind==='companies'){
      assert.equal((await external('DELETE',path,history.token,undefined,patched.etag)).status,403);
      assert.equal((await external('POST',kind+'/batch/archive',history.token,{inputs:[{id,etag:patched.etag}]})).status,403);
      const unchanged=await external('PATCH',path,history.token,change,patched.etag);
      assert.equal(unchanged.status,kind==='contacts'?403:200);
    }
    await result(await send('DELETE',path,undefined,patched.etag),204);
    assert.equal((await send('GET',path)).status,404);
    assert.equal((await send('POST',kind,create)).status,409);
    const archivePath=path+'?archived=true';
    const tombstone=await result(await send('GET',archivePath),200);
    assert.deepEqual(tombstone,{id,object:kind,archivedAt:new Date(tombstone.archivedAt).toISOString()});
    const archiveWindow=kind+'?'+new URLSearchParams({archived:'true',archivedSince:tombstone.archivedAt,
      archivedBefore:new Date(Date.parse(tombstone.archivedAt)+1).toISOString()});
    assert.deepEqual(await result(await send('GET',archiveWindow),200),{results:[tombstone],next:null});
    if(kind==='contacts'||kind==='companies'){
      assert.deepEqual(await result(await external('GET',archivePath,history.token),200),tombstone);
      assert.deepEqual(await result(await external('GET',archiveWindow,history.token),200),{results:[tombstone],next:null});
      const batch=await result(await external('POST',kind+'/batch/read?archived=true',history.token,{inputs:[{id}]}),200);
      assert.deepEqual(batch.results,[{index:0,identifier:id,status:'found',...tombstone}]);
    }else{
      assert.equal((await external('GET',archivePath,history.token)).status,403);
    }
    const deletionWindow=kind+'?'+new URLSearchParams({deletedSince:tombstone.archivedAt,
      deletedBefore:new Date(Date.parse(tombstone.archivedAt)+1).toISOString()});
    assert.deepEqual(await result(await send('GET',deletionWindow),200),{results:[],next:null});
    const archivedPage=await result(await send('GET',kind+'?archived=true&limit=1'),200);
    assert.deepEqual(archivedPage,{results:[tombstone],next:null});
    assert.deepEqual(await result(await send('GET',kind+'?archived=true&after='+id),200),{results:[],next:null});
    if(kind==='contacts'){
      assert.equal((await external('GET',archivePath,limited.token)).status,403);
      assert.equal((await external('GET',archivePath,foreign.token)).status,404);
      assert.deepEqual((await result(await external('GET',kind+'?archived=true',foreign.token),200)).results,[]);
    }
    const list=await result(await send('GET',kind),200);
    assert.ok(!list.results.some(row=>row.id===id));
    if(kind==='deals')await refill();
    // Operators use the normal recycle bin for recovery. Revision is the creation, edit and archive sequence.
    const restore=await ownerPost('/api/recycle-bin',{kind,id,action:'restore',expectedRevision:3,requestId:randomUUID()});
    await result(restore,200);
    const restored=await result(await send('GET',path),200);
    assert.equal(restored.properties.name,change.properties.name);
    assert.deepEqual(await result(await send('GET',archiveWindow),200),{results:[],next:null});
    assert.ok(Date.parse(restored.updatedAt)>=Date.parse(tombstone.archivedAt));
    const restoredPage=await result(await send('GET',kind+'?'+new URLSearchParams({updatedSince:tombstone.archivedAt,
      updatedBefore:new Date(Date.parse(restored.updatedAt)+1).toISOString()})),200);
    assert.deepEqual(restoredPage.results.find(row=>row.id===id),restored);
    assert.equal((await send('GET',archivePath)).status,404);
    const auditRows=()=>sql`SELECT record_ids,actor_email,integration_operation FROM portable_record_access_events
      WHERE token_id=${writer.info.id} AND kind=${kind} AND action='integration' ORDER BY occurred_at,id`;
    const prior=await auditRows();
    const stageReadback=kind==='deals'?1:0;
    const operations=prior.map(row=>row.integration_operation).sort();
    assert.deepEqual(operations,['create','update','update','archive',...Array(8+stageReadback).fill('read')].sort(),kind);
    if(kind==='contacts'){
      const history='/?view=record-access&token='+writer.info.id+'&operation=archive&record='+id;
      const response=await request(history,{headers});
      assert.equal(response.status,200);
      const body=(await response.text()).match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]??'';
      assert.ok(body.includes('Integration archive')&&body.includes(writer.info.id)&&body.includes(id));
      assert.equal((body.match(/<tr>/g)??[]).length,1);
      assert.ok((await (await request(history,{headers:other})).text()).includes('No matching access events.'));
    }
    assert.ok(prior.every(row=>row.actor_email==='owner@example.test'&&row.record_ids.length===1&&row.record_ids[0]===id));
    const second=randomUUID();
    await result(await send('POST',kind,{id:second,properties:{name:'Audit order '+kind}}),201);
    const found=await result(await send('GET',kind+'?properties='),200);
    assert.ok(found.results.length>=2&&found.results.every(row=>Object.keys(row.properties).length===0));
    const batch=await result(await send('POST',kind+'/batch/read',{inputs:[{id:second},{id:randomUUID()},{id}]}),207);
    assert.equal(batch.results[1].status,'error');
    const rows=await auditRows();
    assert.deepEqual(rows.slice(-2).map(row=>row.record_ids),
      [found.results.map(row=>row.id),batch.results.filter(row=>row.status==='found').map(row=>row.id)]);
    await result(await send('POST',kind+'/batch/read',{inputs:[{id:randomUUID()}]}),207);
    assert.equal((await auditRows()).length,rows.length);
  }
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_read' AND subject IN
    (SELECT 'token:' || issuer_id FROM portable_api_tokens WHERE id=${writer.info.id})`;
  for(const query of ['properties=name&properties=email','properties=name,,email','properties=unsupported',
    'archived=true&properties=','deletedSince=2021-04-12T12:00:00Z&deletedBefore=2021-04-13T12:00:00Z&properties=name']){
    assert.equal((await send('GET','contacts?'+query)).status,400,query);
  }
  const archivedIds=[randomUUID(),randomUUID()].sort();
  for(const archiveId of archivedIds){
    const record=await result(await send('POST','tickets',{id:archiveId,properties:{name:'Archived inquiry'}}),201);
    await result(await send('DELETE','tickets/'+archiveId,undefined,record.etag),204);
  }
  const firstPage=await result(await send('GET','tickets?archived=true&limit=1'),200);
  assert.deepEqual(firstPage.results.map(row=>row.id),archivedIds.slice(0,1));
  assert.equal(firstPage.next.after,archivedIds[0]);
  const nextPage=await result(await send('GET','tickets?archived=true&limit=1&after='+firstPage.next.after),200);
  assert.deepEqual(nextPage.results.map(row=>row.id),archivedIds.slice(1));
  assert.equal(nextPage.next,null);
  await refill();
  for(const kind of kinds){
    const seeded=await Promise.all([1,2,3].map(async number=>{
      const id=randomUUID(),record=await result(await send('POST',kind,{id,properties:{name:'Batch '+number}}),201);
      return {id,etag:record.etag};
    }));
    const [first,changed,last]=seeded;
    await result(await send('PATCH',kind+'/'+changed.id,{properties:{name:'Edited since review'}},changed.etag),200);
    const archive=kind+'/batch/archive',check=kind+'/batch/read?archived=true';
    const inputs=seeded.map(({id})=>({id}));
    if(kind==='contacts'){
      assert.equal((await external('POST',archive,limited.token,{inputs:seeded})).status,403);
      assert.equal((await external('POST',check,limited.token,{inputs})).status,403);
      assert.equal((await send('POST',archive,{inputs:[first,{...first,id:first.id.toUpperCase()}]})).status,400);
      assert.equal((await send('POST',archive,{inputs:[first,{id:last.id}]})).status,400);
    }
    const saved=await result(await send('POST',archive,{inputs:seeded}),207);
    assert.deepEqual(saved.results.map(r=>[r.id,r.status,r.error?.status]),[
      [first.id,'archived',undefined],[changed.id,'error',412],[last.id,'archived',undefined],
    ]);
    const checked=await result(await send('POST',check,{inputs}),207);
    assert.deepEqual(checked.results.map(r=>r.status),['found','error','found']);
    for(const i of [0,2])assert.deepEqual(checked.results[i],{index:i,identifier:inputs[i].id,status:'found',id:inputs[i].id,
      object:kind,archivedAt:new Date(checked.results[i].archivedAt).toISOString()});
    assert.equal(checked.results[1].error.status,404);
    assert.equal((await result(await send('GET',kind+'/'+changed.id),200)).properties.name,'Edited since review');
    if(kind==='contacts'){
      const denied=await result(await external('POST',check,foreign.token,{inputs}),207);
      assert.ok(denied.results.every(r=>r.error.status===404));
      await result(await ownerPost('/api/recycle-bin',{kind,id:first.id,action:'restore',expectedRevision:2,requestId:randomUUID()}),200);
      const replay=await result(await send('POST',archive,{inputs:[first,last]}),207);
      assert.deepEqual(replay.results.map(r=>r.error.status),[412,404]);
    }
  }
  await refill();
  // The integration starts with business identifiers, then edits only an unambiguous match.
  for(const [kind,idProperty] of [['contacts','email'],['companies','domain']]){
    const path=kind+'/batch/read',identifier=idProperty==='email'?'mira@juniper.test':'juniper.test';
    const archived=await result(await send('POST',kind,{id:randomUUID(),properties:{name:'Archived match',[idProperty]:identifier}}),201);
    await result(await send('DELETE',kind+'/'+archived.id,undefined,archived.etag),204);
    const current=await result(await send('POST',kind,{id:randomUUID(),properties:{name:'Current match',[idProperty]:identifier}}),201);
    const input={idProperty,inputs:[{id:identifier.toUpperCase()}],properties:['name']};
    const unresolved={id:idProperty==='email'?'absent@juniper.test':'absent.test'};
    const mixed=await result(await external('POST',path,limited.token,{...input,inputs:[unresolved,...input.inputs]}),207);
    assert.equal(mixed.results[0].error.status,404);
    const match=mixed.results[1];
    assert.equal(match.id,current.id);assert.equal(match.etag,current.etag);
    assert.deepEqual(match.properties,{name:'Current match'});
    await result(await send('PATCH',kind+'/'+match.id,{properties:{name:'Reconciled'}},match.etag),200);
    await result(await send('POST',kind,{id:randomUUID(),properties:{name:'Another match',[idProperty]:identifier}}),201);
    const ambiguous=await result(await send('POST',path,input),207);
    assert.deepEqual(ambiguous.results[0],{index:0,identifier:input.inputs[0].id,status:'error',
      error:{status:409,code:'ambiguous',message:'Multiple active records match this identifier.'}});
    const denied=await external('POST',path,foreign.token,input);
    if(kind==='contacts')assert.equal((await result(denied,207)).results[0].error.status,404);
    else assert.equal(denied.status,403);
    assert.equal((await send('POST',path+'?archived=true',input)).status,400);
    assert.equal((await send('POST',path,{...input,inputs:[...input.inputs,{id:identifier}]})).status,400);
    assert.equal((await send('POST','deals/batch/read',input)).status,400);
  }
  await refill();
  // A reviewed change set can include a record that a teammate edited in the meantime.
  for(const kind of kinds){
    const path=kind+'/batch/update';
    const createPath=kind+'/batch/create';
    const inputs=[1,2,3].map(i=>({id:randomUUID(),properties:{name:'Reviewed '+kind+' '+i,...extras[kind]}}));
    if(kind==='companies')assert.equal((await external('POST',createPath,limited.token,{inputs})).status,403);
    if(kind==='contacts'){
      assert.equal((await send('POST',createPath,{inputs:[inputs[0],{...inputs[0],id:inputs[0].id.toUpperCase()}]})).status,400);
      assert.equal((await send('POST',createPath,{inputs:[{...inputs[0],properties:{name:'x'.repeat(65536)}}]})).status,413);
    }
    const created=await result(await send('POST',createPath,{inputs}),200);
    assert.deepEqual(created.results.map(r=>[r.index,r.id,r.status]),inputs.map((item,i)=>[i,item.id,'created']));
    const rows=created.results.map(({id,etag},i)=>({id,etag,properties:{name:'Imported '+kind+' '+(i+1)}}));
    if(kind==='contacts'){
      const extra={id:randomUUID(),properties:{name:'Additional contact'}},invalid={id:randomUUID(),properties:{name:''}};
      const mixed=await result(await send('POST',createPath,{inputs:[{...inputs[0],properties:{name:'Overwritten'}},invalid,extra]}),207);
      assert.deepEqual(mixed.results.map(r=>[r.status,r.error?.status]),[['error',409],['error',400],['created',undefined]]);
      const check=await result(await send('POST',kind+'/batch/read',{inputs:[inputs[0],invalid,extra].map(({id})=>({id}))}),207);
      assert.deepEqual(check.results.map(r=>r.properties?.name),[inputs[0].properties.name,undefined,extra.properties.name]);
    }
    const [first,concurrent,last]=rows;
    if(kind==='companies')assert.equal((await external('POST',path,limited.token,{inputs:rows})).status,403);
    if(kind==='contacts'){
      assert.equal((await send('POST',path,{inputs:[first,{...first,id:first.id.toUpperCase()}]})).status,400);
      assert.equal((await send('POST',path,{inputs:[first,{id:last.id,properties:{name:'Missing version'}}]})).status,400);
      assert.equal((await send('POST',path,{inputs:[{...first,properties:{name:'x'.repeat(65536)}}]})).status,413);
      const foreignResult=await result(await external('POST',path,foreign.token,{inputs:[first]}),207);
      assert.equal(foreignResult.results[0].error.status,404);
    }
    await result(await send('PATCH',kind+'/'+concurrent.id,{properties:{name:'Teammate change'}},concurrent.etag),200);
    const response=await result(await (kind==='contacts'?external('POST',path,limited.token,{inputs:rows}):send('POST',path,{inputs:rows})),207);
    assert.deepEqual(response.results.map(r=>[r.index,r.id,r.status,r.error?.status]),[
      [0,first.id,'updated',undefined],[1,concurrent.id,'error',412],[2,last.id,'updated',undefined]]);
    const {results}=await result(await send('POST',kind+'/batch/read',{inputs:rows.map(({id})=>({id}))}),200);
    assert.deepEqual(results.map(r=>r.properties.name),[first.properties.name,'Teammate change',last.properties.name]);
    for(const i of [0,2]){
      assert.equal(response.results[i].etag,results[i].etag);
      assert.notEqual(rows[i].etag,results[i].etag);
      for(const key of Object.keys(extras[kind]))assert.deepEqual(results[i].properties[key],extras[kind][key]);
    }
    const replay=await result(await send('POST',path,{inputs:rows}),207);
    assert.deepEqual(replay.results.map(r=>r.error.status),[412,412,412]);
    if(kind==='deals')await refill();
  }
  await refill();
  // Withhold data and roll back the new record if the audit insert fails.
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_block_service_audit
    CHECK (kind NOT IN ('leads','tasks','tickets')) NOT VALID`;
  try{
    assert.equal((await send('GET','tickets?archived=true')).status,503);
    assert.equal((await send('POST','tickets/batch/read?archived=true',{inputs:archivedIds.map(id=>({id}))})).status,503);
    for(const kind of ['leads','tasks','tickets']){
      const id=randomUUID();
      const withheld=await send('GET',kind);
      assert.equal(withheld.status,503);
      assert.ok(!(await withheld.text()).includes('Audit order'));
      assert.equal((await send('POST',kind,{id,properties:{name:'Rollback '+kind}})).status,503);
      assert.equal((await send('GET',kind+'/'+id)).status,404);
    }
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_block_service_audit`;}
  for(const kind of ['contacts','companies','deals']){
    const prop=await result(await ownerPost('/api/custom-properties',{action:'create',kind,type:'text',label:'Owner margin',audience:'owner'}),201);
    const secretId=prop.property.id;
    const saved=await result(await ownerPost('/api/crm',{action:'save',kind,data:{name:'Private margin',custom:{[secretId]:'owner only'}}}),201);
    const path=kind+'/'+saved.record.id;
    const visible=await result(await send('GET',path),200);
    assert.ok(!JSON.stringify(visible).includes(secretId));
    const denied={properties:{custom:{[secretId]:'owner only'}}};
    assert.equal((await send('PATCH',path,denied,visible.etag)).status,403);
    await result(await send('PATCH',path,{properties:{name:'Studio update'}},visible.etag),200);
    const own=await result(await request('/api/crm?kind='+kind+'&id='+saved.record.id,{headers}),200);
    assert.equal(own.data.custom[secretId],'owner only');
  }
  await refill();
  await verifyRelationships({sql,external,writer,ownerPost,other,request,headers});
  await refill();
  await verifyPrimaryLinkWrites({external,ownerPost,writer,other});
  await refill();
  await verifyUpdateWindow({sql,send,external,writer,foreign,limited});
  await verifyDeletionWindow({sql,send,external,writer,limited,foreign,history});
  await verifyPropertyMapping({request,sql,writer,limited,foreign,send,ownerPost,headers});
  const workflowId=randomUUID();
  await result(await ownerPost('/api/workflows',{action:'save',id:workflowId,revision:0,
    definition:{name:'Integration intake',trigger:'contact_created',delayMinutes:5,body:'Review the fictional inquiry.'}}),200);
  await result(await ownerPost('/api/workflows',{action:'setEnabled',id:workflowId,revision:1,enabled:true}),200);
  const id=randomUUID(),create={id,properties:{name:'Contended edit'}};
  const concurrent=await Promise.all([send('POST','contacts',create),send('POST','contacts',create)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[201,409]);
  const intake=[0,1].map(i=>({id:randomUUID(),properties:{name:'Batch inquiry '+i}}));
  const attempts=await Promise.all([0,1].map(async()=>{
    const response=await send('POST','contacts/batch/create',{inputs:intake});
    assert.ok([200,207].includes(response.status));
    return (await response.json()).results;
  }));
  const workflow=await result(await request('/api/workflows',{headers}),200);
  for(const [index,item] of intake.entries()){
    const attemptsForId=attempts.map(rows=>rows[index]);
    assert.ok(attemptsForId.every(row=>row.id===item.id));
    assert.deepEqual(attemptsForId.map(row=>row.error?.status??row.status).sort(),[409,'created']);
    assert.equal(workflow.runs.filter(run=>run.contactId===item.id&&run.workflowName==='Integration intake').length,1);
  }
  const jobs=workflow.runs.filter(run=>run.contactId===id&&run.workflowName==='Integration intake');
  assert.equal(jobs.length,1);
  assert.equal(jobs[0].jobStatus,'queued');
  const {etag}=await concurrent.find(r=>r.status===201).json();
  const edits=await Promise.all(['A','B'].map(name=>send('PATCH','contacts/'+id,{properties:{name}},etag)));
  assert.deepEqual(edits.map(r=>r.status).sort(),[200,412]);
  const [actor]=await sql`SELECT issuer_id FROM portable_api_tokens WHERE id=${writer.info.id}`;
  const rateRows=[];
  for(let n=0;n<3;n++){
    const id=randomUUID(),record=await result(await send('POST','deals',{id,properties:{name:'Budget deal '+n}}),201);
    rateRows.push({id,etag:record.etag});
  }
  await sql`UPDATE portable_request_budgets SET used=59 WHERE scope='api_write' AND subject=${'token:'+actor.issuer_id}`;
  const updateInputs=rateRows.map(row=>({...row,properties:{name:'Budgeted update'}}));
  const fresh=rateRows.map((_,i)=>({id:randomUUID(),properties:{name:'Rate-limited batch '+i}}));
  const budgetedCreate=await send('POST','deals/batch/create',{inputs:fresh});
  assert.equal(budgetedCreate.headers.get('retry-after'),'60');
  const limitedCreate=await result(budgetedCreate,207);
  assert.deepEqual(limitedCreate.results.map(r=>[r.status,r.error?.status]),[['created',undefined],['error',429],['not_attempted',undefined]]);
  const actual=await result(await send('POST','deals/batch/read',{inputs:fresh.map(({id})=>({id}))}),207);
  assert.deepEqual(actual.results.map(r=>r.status),['found','error','error']);
  await sql`UPDATE portable_request_budgets SET used=59 WHERE scope='api_write' AND subject=${'token:'+actor.issuer_id}`;
  const budgetedUpdate=await send('POST','deals/batch/update',{inputs:updateInputs});
  assert.equal(budgetedUpdate.headers.get('retry-after'),'60');
  const updates=await result(budgetedUpdate,207);
  assert.deepEqual(updates.results.map(r=>[r.status,r.error?.status]),[['updated',undefined],['error',429],['not_attempted',undefined]]);
  const readback=await result(await send('POST','deals/batch/read',{inputs:rateRows.map(({id})=>({id}))}),200);
  assert.deepEqual(readback.results.map(r=>r.properties.name),['Budgeted update','Budget deal 1','Budget deal 2']);
  rateRows[0].etag=updates.results[0].etag;
  await sql`UPDATE portable_request_budgets SET used=59 WHERE scope='api_write' AND subject=${'token:'+actor.issuer_id}`;
  const exhausted=await send('POST','deals/batch/archive',{inputs:rateRows});
  assert.equal(exhausted.headers.get('retry-after'),'60');
  const partial=await result(exhausted,207);
  assert.deepEqual(partial.results.map(r=>[r.status,r.error?.status]),[['archived',undefined],['error',429],['not_attempted',undefined]]);
  const archiveReceipts=await sql`SELECT record_ids FROM portable_record_access_events
    WHERE token_id=${writer.info.id} AND integration_operation='archive'
    AND record_ids && ${sql.array(rateRows.map(row=>row.id))}::uuid[]`;
  assert.deepEqual(archiveReceipts.map(row=>row.record_ids),[[rateRows[0].id]]);
  const remainder=await result(await send('POST','deals/batch/read',{inputs:rateRows.slice(1).map(({id})=>({id}))}),200);
  assert.deepEqual(remainder.results.map(row=>row.etag),rateRows.slice(1).map(row=>row.etag));
  await sql`UPDATE portable_request_budgets SET used=60 WHERE scope='api_write' AND subject=${'token:'+actor.issuer_id}`;
  assert.equal((await send('POST','contacts',{id:randomUUID(),properties:{name:'Rate limited'}})).status,429);
  await refill();
  // Simulate a busy workspace. An otherwise valid request queued before revocation must recheck its key once admitted.
  let queued;
  const latest=await result(await send('GET','contacts/'+id),200);
  await sql.begin(async tx=>{
    await tx`SELECT id FROM private_workspaces WHERE owner_id=${actor.issuer_id} FOR NO KEY UPDATE`;
    queued=send('PATCH','contacts/'+id,{properties:{name:'Revoked before commit'}},latest.etag);
    let waiting=false;
    for(let n=0;n<100&&!waiting;n++){
      const [state]=await tx`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE pg_backend_pid()=ANY(pg_blocking_pids(a.pid))) AS waiting`;
      waiting=state.waiting;if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(waiting,'Integration reached the locked workspace');
    await result(await ownerPost(settings,{action:'revoke',id:writer.info.id}),200);
  });
  assert.equal((await queued).status,401);
  assert.equal((await request('/api/v1/properties/contacts',{headers:{authorization:'Bearer '+writer.token}})).status,401);
  assert.equal((await send('PATCH','contacts/'+id,{properties:{name:'Revoked'}},latest.etag)).status,401);
  assert.equal((await result(await external('GET','contacts/'+id,limited.token),200)).properties.name,latest.properties.name);
  console.log('Six record types completed create, read, conditional update, archive and browser-API restore. Duplicate creates, competing updates, scopes, throttling and revoked tokens passed.');
  if(process.env.HARBOR_TEST_PLAYWRIGHT){
    // The browser walkthrough represents a fresh session budget after scripted owner setup.
    await sql`DELETE FROM portable_request_budgets WHERE scope='api_write' AND subject=(SELECT issuer_id FROM portable_api_tokens WHERE id=${writer.info.id})`;
    await browserJourney({origin,request,headers,other,external,refill});
  }
}
async function verifyPrimaryLinkWrites({external,ownerPost,writer,other}){
  const permissions={contacts:'read_write',companies:'read_write',deals:'read_write'};
  const issue=async(associationAccess,grants=permissions)=>(await result(await ownerPost(settings,{
    name:'Fictional account sync',days:30,permissions:grants,associationAccess}),201)).token;
  const primary=await issue('primary'),labels=await issue('read_write');
  const call=(method,path,data,etag,key=primary)=>external(method,path,key,data,etag);
  const create=(kind,name,links)=>call('POST',kind,{id:randomUUID(),properties:{name},primary:links});
  const company=await result(await create('companies','Willow CRM sync'),201);
  const buyer=await result(await create('contacts','Willow purchaser',{companyId:company.id}),201);
  const dealId=randomUUID(),start={id:dealId,properties:{name:'Willow renewal'},primary:{contactId:buyer.id,companyId:company.id}};
  const [batch]=(await result(await call('POST','deals/batch/create',{inputs:[start]}),200)).results;
  const path='deals/'+dealId;
  const readPrimary=async(from,kind)=>(await result(await call('GET',from+'/associations/'+kind),200)).results.filter(link=>link.primary).map(link=>link.id);
  assert.deepEqual(await readPrimary('contacts/'+buyer.id,'companies'),[company.id]);
  assert.deepEqual(await readPrimary(path,'contacts'),[buyer.id]);
  assert.deepEqual(await readPrimary(path,'companies'),[company.id]);
  const patch=(links,etag,key=primary,properties={})=>call('PATCH',path,{properties,primary:links},etag,key);
  const same=await result(await patch(start.primary,batch.etag),200);
  assert.equal(same.etag,batch.etag);
  assert.equal((await patch({companyId:null},same.etag,writer.token)).status,403);
  assert.equal((await patch({companyId:null},same.etag,labels)).status,403);
  const partial=await issue('primary',{...permissions,companies:'read'});
  assert.equal((await patch({companyId:null},same.etag,partial)).status,403);
  assert.equal((await call('PUT',path+'/associations/contacts/'+buyer.id,{labels:['Approver']})).status,403);
  const outside=(await result(await ownerPost('/api/crm',{action:'save',kind:'companies',data:{name:'Different workspace'}},other),201)).record;
  assert.equal((await patch({companyId:outside.id,contactId:null},same.etag,primary,{name:'Must roll back'})).status,404);
  assert.deepEqual(await readPrimary(path,'contacts'),[buyer.id]);
  assert.equal((await result(await call('GET',path),200)).etag,same.etag);
  const revised=await result(await patch({companyId:null},same.etag,primary,{name:'Willow amended'}),200);
  assert.notEqual(revised.etag,same.etag);
  assert.deepEqual(await readPrimary(path,'companies'),[]);
  assert.deepEqual(await readPrimary(path,'contacts'),[buyer.id]);
  const update=etag=>call('POST','deals/batch/update',{inputs:[{id:dealId,etag,properties:{},primary:{contactId:null}}]});
  assert.equal((await result(await update(same.etag),207)).results[0].error.status,412);
  assert.equal((await result(await update(revised.etag),200)).results[0].status,'updated');
  assert.deepEqual(await readPrimary(path,'contacts'),[]);
  const companyLink='contacts/'+buyer.id+'/associations/companies/'+company.id;
  await result(await call('PUT',companyLink,{labels:['Billing']},undefined,labels),204);
  const clearBuyer=links=>call('PATCH','contacts/'+buyer.id,{properties:{},primary:links},buyer.etag);
  await result(await call('DELETE','companies/'+company.id,undefined,company.etag,writer.token),204);
  assert.equal((await clearBuyer({companyId:company.id})).status,404);
  const cleared=await result(await clearBuyer({companyId:null}),200);
  assert.notEqual(cleared.etag,buyer.etag,'Clear the stored primary link even while its target is archived.');
  await result(await ownerPost('/api/recycle-bin',{action:'restore',kind:'companies',id:company.id,
    expectedRevision:2,requestId:randomUUID()}),200);
  const kept=await result(await call('GET',companyLink),200);
  assert.equal(kept.primary,false);assert.deepEqual(kept.labels,['Billing']);
  assert.equal((await create('companies','Invalid company link',{contactId:buyer.id})).status,400);
  assert.equal((await create('contacts','Invalid contact link',{contactId:buyer.id})).status,400);
}

async function verifyRelationships({sql,external,writer,ownerPost,other,request,headers}){
  const create=async(kind,name,primary={})=>(await result(await ownerPost('/api/crm',{action:'save',kind,data:{name},...primary}),201)).record;
  const company=await create('companies','Fictional Juniper Studio');
  const buyer=await create('contacts','Juniper Buyer',{primaryCompanyId:company.id});
  const sponsor=await create('contacts','Project Sponsor');
  const deal=await create('deals','Juniper renewal',{companyId:company.id,primaryContactId:buyer.id});
  const path=(kind,id,target)=>kind+'/'+id+'/associations/'+target;
  const link=async(kind,id,targetKind,targetId,labels)=>result(await ownerPost('/api/associations?'+new URLSearchParams({kind,id}),
    {action:'link',target:{kind:targetKind,id:targetId},labels}),200);
  await link('contacts',buyer.id,'companies',company.id,['Billing']);
  await link('contacts',sponsor.id,'companies',company.id,['Sponsor']);
  await link('contacts',sponsor.id,'contacts',buyer.id,['Introduced by']);
  const permissions={companies:'read',contacts:'read',deals:'read'};
  const issue=async(permissions,auth,associationAccess='read')=>(await result(await ownerPost(settings,{name:'Relationship lookup',permissions,days:30,associationAccess},auth),201));
  const token=await issue(permissions);
  const get=(route,key=token)=>external('GET',route,key.token);
  const route=path('companies',company.id,'contacts');
  assert.equal((await get(route,writer)).status,403);
  assert.equal((await get(route,await issue({companies:'read'}))).status,403);
  assert.equal((await get(route,await issue(permissions,other))).status,404);
  const first=await result(await get(route+'?limit=1'),200);
  const second=await result(await get(route+'?limit=1&after='+first.next.after),200);
  assert.equal(second.next,null);
  const rows=[...first.results,...second.results];
  assert.deepEqual(rows.map(row=>row.id),[buyer.id,sponsor.id].sort());
  const match=rows.find(row=>row.id===buyer.id);
  assert.match(match.etag,/^"[a-f\d]{64}"$/);
  assert.deepEqual(match,{etag:match.etag,object:'contacts',id:buyer.id,labels:['Billing'],explicit:true,primary:false,reversePrimary:true});
  assert.equal(rows.find(row=>row.id===sponsor.id).reversePrimary,false);
  const read=async(kind,id,target)=>(await result(await get(path(kind,id,target)),200)).results;
  assert.ok((await read('contacts',buyer.id,'companies'))[0].primary);
  assert.equal((await read('contacts',buyer.id,'contacts'))[0].id,sponsor.id);
  for(const [kind,target] of [['contacts',buyer],['companies',company]]){
    assert.deepEqual(await read('deals',deal.id,kind),[{object:kind,id:target.id,labels:[],explicit:false,primary:true,reversePrimary:false}]);
    assert.ok((await read(kind,target.id,'deals'))[0].reversePrimary);
  }
  const history=await sql`SELECT kind,record_ids FROM portable_record_access_events WHERE token_id=${token.info.id} AND integration_operation='read'`;
  for(const [kind,record] of [['contacts',buyer],['companies',company],['contacts',sponsor],['deals',deal]]){
    assert.ok(history.some(event=>event.kind===kind&&event.record_ids.includes(record.id)));
  }
  const pair=route+'/'+buyer.id;
  const edit=await issue({contacts:'read_write',companies:'read_write'},undefined,'read_write');
  const partial=await issue({contacts:'read_write',companies:'read'},undefined,'read_write');
  const put=(route,labels,key=edit)=>external('PUT',route,key.token,{labels});
  const remove=(route,etag,key=edit)=>external('DELETE',route,key.token,undefined,etag);
  const reverse=path('contacts',buyer.id,'companies')+'/'+company.id;
  assert.equal((await put(pair,[],token)).status,403);
  assert.equal((await put(pair,[],partial)).status,403);
  assert.equal((await remove(reverse,match.etag,partial)).status,403);
  const original=await get(pair,edit);
  assert.equal(original.headers.get('etag'),match.etag);
  assert.deepEqual(await result(original,200),match);
  assert.equal((await put(pair,['New billing label'])).status,409);
  assert.equal((await remove(pair)).status,428);
  const replace=(labels,etag,key=edit)=>external('PUT',pair,key.token,{labels},etag);
  assert.equal((await replace(['Decision maker'],match.etag,partial)).status,403);
  const requests=await Promise.all([replace(['Decision maker'],match.etag),replace(['Project sponsor'],match.etag)]);
  assert.deepEqual(requests.map(r=>r.status).sort(),[204,412]);
  const revised=await result(await get(pair,edit),200);
  assert.deepEqual(revised.labels,requests[0].status===204?['Decision maker']:['Project sponsor']);
  assert.ok(revised.explicit&&revised.reversePrimary);
  assert.notEqual(revised.etag,match.etag);
  const cleared=await replace([],revised.etag);
  await result(cleared,204);
  const unlabeled=await result(await get(pair,edit),200);
  assert.deepEqual(unlabeled.labels,[]);
  assert.ok(unlabeled.explicit&&unlabeled.reversePrimary);
  const fromContact=await result(await get(reverse,edit),200);
  await result(await remove(reverse,fromContact.etag),204);
  const primaryOnly=await result(await get(pair,edit),200);
  assert.ok(primaryOnly.reversePrimary&&!primaryOnly.explicit&&!primaryOnly.etag);
  const attempts=await Promise.all([put(pair,['Accounts payable']),put(reverse,['Accounts payable'])]);
  for(const attempt of attempts)await result(attempt,204);
  const replacement=await result(await get(pair,edit),200);
  assert.notEqual(replacement.etag,match.etag);
  assert.deepEqual(replacement.labels,['Accounts payable']);
  assert.ok(replacement.reversePrimary&&replacement.explicit);
  assert.equal((await remove(pair,match.etag)).status,412);
  assert.deepEqual(await result(await get(pair,edit),200),replacement);
  // Merging records can combine labels on an existing link without replacing its ID.
  await sql`UPDATE portable_associations SET labels='["Accounts payable","Renewal"]'
    WHERE first_id=${company.id} AND second_id=${buyer.id}`;
  assert.equal((await remove(pair,replacement.etag)).status,412);
  assert.deepEqual((await result(await get(pair,edit),200)).labels,['Accounts payable','Renewal']);
  const foreignCompany=(await result(await ownerPost('/api/crm',{action:'save',kind:'companies',data:{name:'Separate workspace'}},other),201)).record;
  assert.equal((await put(path('contacts',buyer.id,'companies')+'/'+foreignCompany.id,['Billing'])).status,404);
  assert.equal((await get(path('contacts',buyer.id,'companies')+'/'+foreignCompany.id,edit)).status,404);
  const onCompany=await result(await request('/api/associations?kind=companies&id='+company.id,{headers}),200);
  assert.deepEqual(onCompany.items.find(item=>item.target.id===buyer.id).labels,['Accounts payable','Renewal']);
  await result(await ownerPost(settings,{action:'revoke',id:edit.info.id}),200);
  assert.equal((await put(pair,['Billing'])).status,401);
  const writes=await sql`SELECT DISTINCT kind FROM portable_record_access_events WHERE token_id=${edit.info.id} AND integration_operation='update'`;
  assert.deepEqual(writes.map(row=>row.kind).sort(),['companies','contacts']);
  const batch=(sources,targets,body,key=token)=>request('/api/v1/associations/'+sources+'/'+targets+'/batch/read',{
    method:'POST',headers:{authorization:'Bearer '+key.token,'content-type':'application/json'},body:JSON.stringify(body),
  });
  const empty=await create('companies','No linked contacts');
  const inputs=[{id:foreignCompany.id},{id:company.id.toUpperCase()},{id:empty.id},{id:randomUUID()}];
  const firstBatch=await result(await batch('companies','contacts',{inputs,limit:1}),207);
  assert.deepEqual(firstBatch.results.map(r=>r.index),[0,1,2,3]);
  assert.deepEqual(firstBatch.results.map(r=>r.status),['error','found','found','error']);
  assert.deepEqual(firstBatch.results[0].error,firstBatch.results[3].error);
  assert.deepEqual(firstBatch.results[2],{index:2,id:empty.id,status:'found',results:[],next:null});
  const updatedFirst=await result(await get(route+'?limit=1'),200);
  assert.deepEqual(firstBatch.results[1],{index:1,id:company.id,status:'found',...updatedFirst});
  const follow=await result(await batch('companies','contacts',{inputs:[{id:company.id,after:updatedFirst.next.after},{id:empty.id}],limit:1}),200);
  const updatedSecond=await result(await get(route+'?limit=1&after='+updatedFirst.next.after),200);
  assert.deepEqual(follow.results[0],{index:0,id:company.id,status:'found',...updatedSecond});
  const sameKind=await result(await batch('contacts','contacts',{inputs:[{id:buyer.id},{id:sponsor.id}]}),200);
  assert.deepEqual(sameKind.results.map(r=>r.results[0].id),[sponsor.id,buyer.id]);
  assert.equal((await batch('companies','contacts',{inputs},writer)).status,403);
  for(const body of [{inputs:[]},{inputs:[{id:company.id},{id:company.id.toUpperCase()}]},{inputs,limit:51},{inputs:[{id:company.id,after:'invalid'}]}])
    assert.equal((await batch('companies','contacts',body)).status,400);
  await verifyLargeAssociationBatch({sql,token,batch});
  const sponsorUrl='contacts/'+sponsor.id;
  const current=await result(await external('GET',sponsorUrl,writer.token),200);
  await result(await external('DELETE',sponsorUrl,writer.token,undefined,current.etag),204);
  assert.deepEqual((await read('companies',company.id,'contacts')).map(row=>row.id),[buyer.id]);
  assert.equal((await get(path('contacts',sponsor.id,'companies'))).status,404);
  const archivedResult=await result(await batch('contacts','companies',{inputs:[{id:sponsor.id},{id:buyer.id}]}),207);
  assert.equal(archivedResult.results[0].error.status,404);
  assert.deepEqual(archivedResult.results[1].results.map(row=>row.id),[company.id]);
  await result(await ownerPost(settings,{action:'revoke',id:token.info.id}),200);
  assert.equal((await get(route)).status,401);
}

async function verifyLargeAssociationBatch({sql,token,batch}){
  const [{workspace_id:workspace}]=await sql`SELECT workspace_id FROM portable_api_tokens WHERE id=${token.info.id}`;
  const ids=Array.from({length:50},()=>randomUUID());
  await sql`INSERT INTO companies(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${workspace},id,1,'{"name":"Batch account"}',now(),now() FROM unnest(${ids}::uuid[]) id`;
  await sql`INSERT INTO contacts(workspace_id,id,primary_company_id,revision,data,created_at,updated_at)
    SELECT ${workspace},gen_random_uuid(),id,1,'{"name":"Batch contact"}',now(),now()
    FROM unnest(${ids}::uuid[]) id CROSS JOIN generate_series(1,51)`;
  const page=await result(await batch('companies','contacts',{inputs:ids.map(id=>({id})),limit:50}),200);
  const seen=page.results.flatMap(source=>{
    assert.equal(source.results.length,50);
    assert.deepEqual(source.next,{after:source.results[49].id});
    return source.results.map(row=>row.id);
  });
  const receipts=await sql`SELECT record_ids FROM portable_record_access_events
    WHERE token_id=${token.info.id} AND kind='contacts' AND record_ids && ${seen}::uuid[]`;
  assert.deepEqual(receipts.map(row=>row.record_ids.length),[500,500,500,500,500]);
  assert.deepEqual(receipts.flatMap(row=>row.record_ids).sort(),[...seen].sort());
  const last=await result(await batch('companies','contacts',{inputs:page.results.map(r=>({id:r.id,...r.next})),limit:50}),200);
  assert.deepEqual(last.results.map(r=>r.id),ids);
  assert.ok(last.results.every(r=>r.results.length===1&&r.next===null&&!seen.includes(r.results[0].id)));
  console.log('One batch returned 2,500 linked contacts across 50 companies. Five receipts matched the returned IDs and each company resumed at its own 51st contact.');
}

async function verifyUpdateWindow({sql,send,external,writer,foreign,limited}){
  await sql`DELETE FROM portable_request_budgets WHERE scope='api_read' AND subject IN
    (SELECT 'token:' || issuer_id FROM portable_api_tokens WHERE id=${writer.info.id})`;
  const [{workspace_id:workspace}]=await sql`SELECT workspace_id FROM portable_api_tokens WHERE id=${writer.info.id}`;
  const start='2021-04-12T12:00:00.000Z',end='2021-04-12T12:00:00.001Z';
  const ids=Array.from({length:4},()=>randomUUID()).sort();
  await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at,archived_at)
    SELECT ${workspace},id,1,'{"name":"Import window test","email":"sync@example.test"}',${start}::timestamptz,
      ${start}::timestamptz+CASE n WHEN 1 THEN interval '900 microseconds' WHEN 2 THEN interval '100 microseconds'
        WHEN 3 THEN interval '1 millisecond' ELSE interval '0' END,CASE WHEN n=4 THEN now() END
    FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS batch(id,n)`;
  await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${workspace},gen_random_uuid(),1,'{"name":"Fictional historical sync fixture"}','2020-01-01',
      timestamptz '2020-01-01'+n*interval '1 minute' FROM generate_series(1,12000) n`;
  await sql`ANALYZE contacts`;
  const plan=await sql`EXPLAIN (ANALYZE,FORMAT JSON) SELECT id FROM contacts WHERE workspace_id=${workspace} AND archived_at IS NULL
    AND date_trunc('milliseconds',updated_at AT TIME ZONE 'UTC')>=timestamp '2021-04-12 12:00:00'
    AND date_trunc('milliseconds',updated_at AT TIME ZONE 'UTC')<timestamp '2021-04-12 12:00:00.001'
    ORDER BY date_trunc('milliseconds',updated_at AT TIME ZONE 'UTC'),id LIMIT 2`;
  assert.match(JSON.stringify(plan),/contacts_recent_page/);
  const window={updatedSince:start,updatedBefore:end,limit:'1',properties:'name'};
  const path=params=>'contacts?'+new URLSearchParams(params);
  const first=await result(await send('GET',path(window)),200);
  assert.deepEqual(first.results.map(r=>r.id),[ids[0]]);
  assert.deepEqual(first.next,{after:ids[0],afterUpdatedAt:start});
  const second=await result(await send('GET',path({...window,...first.next})),200);
  assert.deepEqual(second.results.map(r=>r.id),[ids[1]]);
  for(const row of [...first.results,...second.results])assert.deepEqual(Object.keys(row.properties),['name']);
  assert.equal(second.next,null);
  const adjacent=await result(await send('GET',path({updatedSince:end,updatedBefore:'2021-04-12T12:00:01Z'})),200);
  assert.deepEqual(adjacent.results.map(row=>row.id),[ids[2]]);
  assert.deepEqual(await result(await external('GET',path(window),foreign.token),200),{results:[],next:null});
  assert.equal((await external('GET','tickets?'+new URLSearchParams(window),limited.token)).status,403);
  for(const params of [{updatedSince:start},{...window,updatedBefore:start},{...window,after:ids[0]},
    {...window,afterUpdatedAt:start},{...window,...first.next,afterUpdatedAt:end},{...window,archived:'true'}])
    assert.equal((await send('GET',path(params))).status,400);
  // Archive the fictional history, including the selected rows with sub-millisecond ties.
  await sql`UPDATE contacts SET archived_at=updated_at WHERE workspace_id=${workspace} AND archived_at IS NULL AND
    (id=ANY(${ids}::uuid[]) OR (created_at=timestamptz '2020-01-01' AND data->>'name'='Fictional historical sync fixture'))`;
  await sql`ANALYZE contacts`;
  const archivePlan=await sql`EXPLAIN (ANALYZE,FORMAT JSON) SELECT id FROM contacts WHERE workspace_id=${workspace} AND archived_at IS NOT NULL
    AND date_trunc('milliseconds',archived_at AT TIME ZONE 'UTC')>=timestamp '2021-04-12 12:00:00'
    AND date_trunc('milliseconds',archived_at AT TIME ZONE 'UTC')<timestamp '2021-04-12 12:00:00.001'
    ORDER BY date_trunc('milliseconds',archived_at AT TIME ZONE 'UTC'),id LIMIT 2`;
  assert.match(JSON.stringify(archivePlan),/contacts_archived_time_page/);
  const archives={archived:'true',archivedSince:start,archivedBefore:end,limit:'1'};
  const head=await result(await send('GET',path(archives)),200);
  assert.deepEqual(head,{results:[{id:ids[0],object:'contacts',archivedAt:start}],next:{after:ids[0],afterArchivedAt:start}});
  assert.deepEqual(await result(await send('GET',path({...archives,...head.next})),200),
    {results:[{id:ids[1],object:'contacts',archivedAt:start}],next:null});
  assert.equal((await external('GET',path(archives),limited.token)).status,403);
  assert.deepEqual(await result(await external('GET',path(archives),foreign.token),200),{results:[],next:null});
  for(const params of [{...archives,archived:'false'},{...archives,archivedSince:end},{...archives,afterUpdatedAt:start},
    {...archives,after:ids[0]},{...archives,afterArchivedAt:start},{...archives,...head.next,afterArchivedAt:end}])
    assert.equal((await send('GET',path(params))).status,400);
  await sql`DELETE FROM contacts WHERE workspace_id=${workspace} AND
    (id=ANY(${ids}::uuid[]) OR (created_at=timestamptz '2020-01-01' AND data->>'name'='Fictional historical sync fixture'))`;
}

async function verifyDeletionWindow({sql,send,external,writer,limited,foreign,history}){
  const [{workspace_id:workspace}]=await sql`SELECT workspace_id FROM portable_api_tokens WHERE id=${writer.info.id}`;
  const ids=[randomUUID(),randomUUID()].sort(),empty={results:[],next:null};
  const tables={contacts:'contacts',companies:'companies',deals:'deals',tasks:'portable_tasks',leads:'portable_leads',tickets:'portable_tickets'};
  for(const [kind,table] of Object.entries(tables)){
    const insert=()=>sql`INSERT INTO ${sql(table)}(workspace_id,id,revision,data,created_at,updated_at)
      SELECT ${workspace},id,1,${sql.json({name:'Private deletion fixture',...(kind==='tasks'?{status:'Not started'}:kind==='tickets'?{ticketStatus:'New'}:{})})},
        now(),now() FROM unnest(${ids}::uuid[]) id`;
    await insert();
    const erase=tx=>tx`DELETE FROM ${tx(table)} WHERE workspace_id=${workspace} AND id=ANY(${ids}::uuid[])`;
    if(kind==='contacts'){
      await assert.rejects(sql.begin(async tx=>{await erase(tx);throw Error('cancel deletion');}),/cancel deletion/);
      assert.equal((await sql`SELECT record_id FROM portable_record_deletions WHERE workspace_id=${workspace}
        AND record_id=ANY(${ids}::uuid[])`).length,0);
    }
    await sql.begin(erase);
    const [{at}]=await sql`SELECT deleted_at AT TIME ZONE 'UTC' AS at FROM portable_record_deletions
      WHERE workspace_id=${workspace} AND object_kind=${kind} AND record_id=${ids[0]}`;
    const start=at.toISOString(),end=new Date(+at+1).toISOString();
    const window={deletedSince:start,deletedBefore:end,limit:'1'};
    const path=params=>kind+'?'+new URLSearchParams(params);
    const receipt=id=>({id,object:kind,deletedAt:start});
    const head=await result(await send('GET',path(window)),200);
    if(kind==='contacts'||kind==='companies'){
      assert.deepEqual(await result(await external('GET',path(window),history.token),200),head);
    }else{
      assert.equal((await external('GET',path(window),history.token)).status,403);
    }
    assert.deepEqual(head,{results:[receipt(ids[0])],next:{after:ids[0],afterDeletedAt:start}});
    assert.deepEqual(await result(await send('GET',path({...window,...head.next})),200),{results:[receipt(ids[1])],next:null});
    if(kind==='contacts'){
      assert.deepEqual(await result(await external('GET',path(window),foreign.token),200),empty);
      assert.equal((await external('GET',path(window),limited.token)).status,403);
      for(const query of [{deletedBefore:end},{...window,archived:'true'},{...window,after:ids[0]},
        {...window,deletedBefore:start},{...window,...head.next,afterDeletedAt:end}]){
        assert.equal((await send('GET',path(query))).status,400);
      }
      assert.deepEqual(await result(await send('GET',path({deletedSince:new Date(+at-1).toISOString(),deletedBefore:start})),200),empty);
      const [audit]=await sql`SELECT record_ids FROM portable_record_access_events WHERE token_id=${writer.info.id}
        AND kind='contacts' AND record_ids=ARRAY[${ids[0]}::uuid]`;
      assert.deepEqual(audit.record_ids,[ids[0]]);
      await insert();
      assert.equal((await send('GET',kind+'/'+ids[0])).status,200);
      await sql.begin(erase);
      assert.deepEqual(await result(await send('GET',path(window)),200),empty,'A second deletion advances the existing ID.');
      await sql`ANALYZE portable_record_deletions`;
      const plan=await sql`EXPLAIN SELECT record_id FROM portable_record_deletions
        WHERE workspace_id=${workspace} AND object_kind='contacts' AND deleted_at>=${start}::timestamp AND deleted_at<${end}::timestamp
        ORDER BY deleted_at,record_id LIMIT 2`;
      assert.match(plan.map(row=>row['QUERY PLAN']).join('\n'),/portable_record_deletion_window/);
    }
  }
}

async function verifyPropertyMapping({request,sql,writer,limited,foreign,send,ownerPost,headers}){
  const catalog=(kind,token=writer.token)=>request('/api/v1/properties/'+kind,{headers:{authorization:'Bearer '+token}});
  const readBudget=async()=>sql`DELETE FROM portable_request_budgets WHERE scope='api_read' AND subject IN
    (SELECT 'token:' || issuer_id FROM portable_api_tokens WHERE id=${writer.info.id})`;
  await readBudget();
  assert.equal((await request('/api/v1/properties/contacts',{headers})).status,401);
  assert.equal((await catalog('deals',limited.token)).status,403);
  for(const kind of kinds){
    if(['tasks','leads','tickets'].includes(kind)){
      const schema=await result(await catalog(kind),200);
      assert.equal(schema.object,kind);
      assert.ok(schema.standardProperties.includes('name'));
      assert.deepEqual(schema.customProperties,[]);
      continue;
    }
    const create=async(label,type,extra={})=>(await result(await ownerPost('/api/custom-properties',{action:'create',kind,label,type,...extra}),201)).property;
    const service=await create('Service level','select',{options:['Standard','Priority']});
    const region=await create('Service region','text');
    const rule={action:'standardAccess',kind,id:'description'};
    await result(await ownerPost('/api/custom-properties',{...rule,audience:'owner',expectedRevision:0}),200);
    const response=await catalog(kind);
    assert.match(response.headers.get('cache-control'),/no-store/);
    const schema=await result(response,200);
    assert.equal(schema.object,kind);
    assert.ok(schema.standardProperties.includes('name'));
    assert.ok(!schema.standardProperties.includes('description'));
    const discovered=schema.customProperties.find(field=>field.label==='Service level');
    assert.deepEqual(discovered,{id:service.id,label:service.label,type:'select',options:service.options});
    assert.ok(!schema.customProperties.some(field=>field.label==='Owner margin'));
    if(kind==='contacts')assert.deepEqual((await result(await catalog(kind,foreign.token),200)).customProperties,[]);
    const record=await result(await send('POST',kind,{id:randomUUID(),properties:{name:'Mapped customer',
      custom:{[discovered.id]:discovered.options[0],[region.id]:'East'}}}),201);
    const select=(fields)=>send('POST',kind+'/batch/read',{inputs:[{id:record.id}],properties:fields});
    const current=(await result(await select(['name','custom:'+discovered.id]),200)).results[0];
    assert.deepEqual(current.properties,{name:'Mapped customer',custom:{[service.id]:'Standard'}});
    const query=new URLSearchParams({properties:'name,custom:'+discovered.id});
    const detail=kind+'/'+record.id+'?'+query;
    assert.deepEqual((await result(await send('GET',detail),200)).properties,current.properties);
    assert.equal((await send('POST',kind+'/batch/read',{idProperty:'custom:'+service.id,inputs:[{id:'Standard'}]})).status,400);
    const renamed=await result(await ownerPost('/api/custom-properties',{action:'rename',kind,id:service.id,label:'Support tier',expectedRevision:service.revision}),200);
    assert.equal((await result(await catalog(kind),200)).customProperties.find(field=>field.label==='Support tier').id,discovered.id);
    const revised=await result(await send('PATCH',kind+'/'+record.id,{properties:{custom:{[discovered.id]:'Priority'}}},current.etag),200);
    assert.deepEqual((await result(await select(['custom']),200)).results[0].properties,{custom:{[service.id]:'Priority',[region.id]:'East'}});
    await result(await ownerPost('/api/custom-properties',{action:'access',kind,id:service.id,audience:'owner',expectedRevision:renamed.property.revision}),200);
    assert.ok(!(await result(await catalog(kind),200)).customProperties.some(field=>field.id===service.id));
    assert.equal((await select(['custom:'+discovered.id])).status,400);
    assert.equal((await send('GET',detail)).status,400);
    assert.deepEqual((await result(await select(['custom']),200)).results[0].properties,{custom:{[region.id]:'East'}});
    const time=new Date(revised.updatedAt).getTime();
    const page=await result(await send('GET',kind+'?'+new URLSearchParams({updatedSince:new Date(time).toISOString(),updatedBefore:new Date(time+1).toISOString()})),200);
    const visible=page.results.find(row=>row.id===record.id).properties;
    assert.deepEqual(visible.custom,{[region.id]:'East'});
    assert.ok(!Object.hasOwn(visible,'description'));
    await verifyExternalIdentifier({kind,sql,region,create,record,send,request,ownerPost,writer,foreign});
    await result(await ownerPost('/api/custom-properties',{...rule,audience:'workspace',expectedRevision:1}),200);
  }
  await sql`UPDATE portable_request_budgets SET used=120 WHERE scope='api_read' AND subject IN
    (SELECT 'token:' || issuer_id FROM portable_api_tokens WHERE id=${writer.info.id})`;
  const throttled=await catalog('contacts');
  assert.equal(throttled.status,429);
  assert.ok(throttled.headers.has('retry-after'));
  await readBudget();
}

async function verifyExternalIdentifier({kind,sql,region,create,record,send,request,ownerPost,writer,foreign}){
  const field=await create('External CRM ID','text'),ref='000A7';
  const path=kind+'/batch/read';
  const lookup=(ids,selector=field.id)=>({idProperty:'custom:'+selector,inputs:ids.map(id=>({id})),properties:['name']});
  const save=(name,value)=>send('POST',kind,{id:randomUUID(),properties:{name,custom:{[field.id]:value}}});
  const upper=await result(await save('ERP account A',ref),201);
  const lower=await result(await save('ERP account a',ref.toLowerCase()),201);
  const mixed=await result(await send('POST',path,lookup([ref.toLowerCase(),'absent',ref],field.id.toUpperCase())),207);
  assert.deepEqual(mixed.results.map(row=>row.id??row.error.status),[lower.id,404,upper.id]);
  assert.deepEqual(mixed.results[2].properties,{name:'ERP account A'});
  assert.equal(mixed.results[2].etag,upper.etag);
  const duplicate=await result(await save('Second ERP account A',ref),201);
  const ambiguous=await result(await send('POST',path,lookup([ref])),207);
  assert.equal(ambiguous.results[0].error.code,'ambiguous');
  await result(await send('DELETE',kind+'/'+duplicate.id,undefined,duplicate.etag),204);
  const match=await result(await send('POST',path,lookup([ref])),200);
  assert.equal(match.results[0].id,upper.id);
  await result(await send('PATCH',kind+'/'+upper.id,{properties:{name:'Updated from ERP'}},match.results[0].etag),200);
  assert.equal((await result(await send('GET',kind+'/'+upper.id),200)).properties.name,'Updated from ERP');
  assert.equal((await send('POST',path+'?archived=true',lookup([ref]))).status,400);
  assert.equal((await send('POST',path,lookup([ref,ref]))).status,400);
  assert.equal((await request('/api/v1/records/'+path,{method:'POST',headers:{authorization:'Bearer '+foreign.token,'content-type':'application/json'},
    body:JSON.stringify(lookup([ref]))})).status,kind==='contacts'?400:403);
  if(kind==='contacts'){
    const [{workspace_id:workspace}]=await sql`SELECT workspace_id FROM portable_api_tokens WHERE id=${writer.info.id}`;
    await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      SELECT ${workspace},gen_random_uuid(),1,jsonb_build_object('name','External ID lookup fixture','custom',
        jsonb_build_object(${field.id}::text,'CRM-'||i)),now(),now() FROM generate_series(1,12000) i`;
    await sql`ANALYZE contacts`;
    const indexReads=async()=>Number((await sql`SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname='contacts_custom_identifier'`)[0].idx_scan);
    const before=await indexReads();
    const batch=Array.from({length:50},(_,i)=>'CRM-'+(11951+i));
    const found=await result(await send('POST',path,lookup(batch)),200);
    assert.deepEqual(found.results.map(r=>r.identifier),batch);
    assert.equal(new Set(found.results.map(r=>r.id)).size,50);
    for(let i=0;i<30&&await indexReads()<=before;i++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(await indexReads()>before,'The actual API used the custom ID index');
    console.log('Matched 50 case-sensitive external IDs in a 12,000-contact fixture using the custom identifier index.');
  }
  await result(await ownerPost('/api/custom-properties',{kind,action:'access',id:field.id,audience:'owner',expectedRevision:field.revision}),200);
  const denied=await send('POST',path,lookup([ref]));
  assert.equal(denied.status,400);
  assert.deepEqual(await denied.json(),await (await send('POST',path,lookup([ref],randomUUID()))).json());
  assert.equal((await result(await send('POST',path,lookup(['East'],region.id)),200)).results[0].id,record.id);
}

async function browserJourney({request,other,origin,headers,external,refill}){
  await refill();
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
  try{
    const ctx=await browser.newContext({viewport:{width:1365,height:880}});
    const [name,value]=headers.cookie.split('=');await ctx.addCookies([{name,value,url:origin}]);
    const page=await ctx.newPage();page.setDefaultTimeout(10000);
    await page.goto(origin+'/?view=api-access');
    const examples=page.getByRole('region',{name:'API request example'});
    await examples.getByText('API request example',{exact:true}).click();
    await examples.getByText('archivedSince',{exact:true}).waitFor();
    await examples.getByText('/api/v1/associations/companies/contacts/batch/read',{exact:true}).waitFor();
    const label='Fictional studio connector';
    await page.getByLabel('Token name').fill(label);
    await page.getByLabel('Companies access').selectOption({label:'Read records and track removals'});
    assert.equal(await page.getByLabel('Record relationships').locator('option[value="read_write"]').count(),0);
    await page.getByLabel('Contacts access').selectOption('read_write');
    await page.getByLabel('Tickets access').selectOption('read_write_archive');
    assert.equal(await page.getByLabel('Record relationships').locator('option[value="all"]').count(),0);
    await page.getByLabel('Deals access').selectOption('read_write');
    await page.getByLabel('Record relationships').selectOption({label:'Read and manage primary and labeled links'});
    await page.getByRole('button',{name:'Create record token'}).click();
    const secretField=page.getByRole('region',{name:'New token'}).getByRole('textbox');
    await secretField.waitFor();const token=await secretField.inputValue();
    await result(await external('GET','companies?archived=true',token),200);
    assert.equal((await external('POST','companies',token,{id:randomUUID(),properties:{name:'Denied'}})).status,403);
    const id=randomUUID(),record=await result(await external('POST','contacts',token,{id,properties:{name:'Avery Studio Browser'}}),201);
    assert.deepEqual(await result(await external('GET','contacts/'+id+'/associations/contacts',token),200),{results:[],next:null});
    const update=await result(await external('POST','contacts/batch/update',token,{inputs:[{id,etag:record.etag,properties:{name:'Avery Studio Updated'}}]}),200);
    assert.equal(update.results[0].status,'updated');
    await page.goto(origin+'/?view=contacts');
    const search=page.getByRole('searchbox',{name:'Search contacts'});
    await search.fill('Avery Studio Updated');
    await search.press('Enter');
    await page.getByText('Avery Studio Updated',{exact:true}).first().waitFor();
    const buyer=randomUUID(),buyerName='Fictional renewal buyer';
    await result(await external('POST','contacts',token,{id:buyer,properties:{name:buyerName}}),201);
    const deal=await result(await external('POST','deals',token,{id:randomUUID(),properties:{name:'Studio renewal'},primary:{contactId:buyer}}),201);
    await page.goto(origin+'/?kind=deals&record='+deal.id);
    await page.getByRole('link',{name:buyerName,exact:true}).first().waitFor();
    const pair='contacts/'+id+'/associations/contacts/'+buyer;
    await result(await external('PUT',pair,token,{labels:['Billing, North America']}),204);
    await page.goto(origin+'/?contact='+id);
    const panel=page.getByRole('region',{name:'Additional associations'});
    const editLabels=panel.getByRole('button',{name:'Edit labels for '+buyerName});
    await editLabels.click();
    const form=panel.getByRole('form',{name:'Edit labels for '+buyerName});
    assert.equal(await form.getByRole('textbox',{name:'Label 1',exact:true}).inputValue(),'Billing, North America');
    await form.getByRole('button',{name:'Add label'}).click();
    await form.getByLabel('Label 2',{exact:true}).fill('Renewal sponsor');
    await form.getByRole('button',{name:'Save labels'}).click();
    await panel.getByText('Labels saved.',{exact:true}).waitFor();
    const current=await result(await external('GET',pair,token),200);
    assert.deepEqual(current.labels,['Billing, North America','Renewal sponsor']);
    await editLabels.click();
    await form.getByLabel('Label 1',{exact:true}).fill('Buyer');
    await result(await external('PUT',pair,token,{labels:['Finance lead']},current.etag),204);
    await form.getByRole('button',{name:'Save labels'}).click();
    await panel.getByRole('alert').filter({hasText:'This link changed'}).waitFor();
    await editLabels.click();
    assert.equal(await form.getByLabel('Label 1',{exact:true}).inputValue(),'Finance lead');
    await form.getByRole('button',{name:'Cancel'}).click();
    const ticketId=randomUUID(),ticketName='Studio scanner return';
    const ticket=await result(await external('POST','tickets',token,{id:ticketId,properties:{name:ticketName}}),201);
    await result(await external('DELETE','tickets/'+ticketId,token,undefined,ticket.etag),204);
    await page.goto(origin+'/?view=recycle-bin&kind=tickets');
    await page.getByRole('row').filter({hasText:ticketName}).getByRole('button',{name:'Restore ticket'}).click();
    await page.waitForURL(url=>url.pathname==='/tickets'&&url.searchParams.get('id')===ticketId);
    assert.equal((await result(await external('GET','tickets/'+ticketId,token),200)).properties.name,ticketName);
    await page.goto(origin+'/?view=api-access');page.on('dialog',dialog=>dialog.accept());
    const revoke=page.waitForResponse(r=>new URL(r.url()).pathname===settings&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Revoke '+label,exact:true}).click();
    assert.equal((await revoke).status(),200);
    await page.getByText(/Token revoked/i).first().waitFor();
    assert.equal((await external('GET','contacts/'+id,token)).status,401);
    await page.locator('li.portable-token-row').filter({hasText:label}).getByRole('link',{name:'View record access'}).click();
    const auditToken=new URL(page.url()).searchParams.get('token');
    assert.ok(auditToken);
    await page.getByLabel('Object',{exact:true}).selectOption('tickets');
    await page.getByRole('button',{name:'Apply filters'}).click();
    const historyRows=page.locator('tbody tr');
    assert.equal(await historyRows.count(),3,'Ticket create, archive and restored record read');
    assert.equal(await historyRows.filter({hasText:label}).count(),3);
    for(const operation of ['create','archive','read']){
      await page.getByLabel('API operation').selectOption(operation);
      await page.getByRole('button',{name:'Apply filters'}).click();
      await page.waitForURL(url=>url.searchParams.get('operation')===operation);
      assert.equal(await historyRows.count(),1);
      await historyRows.getByRole('cell',{name:'Integration '+operation,exact:true}).waitFor();
    }
    await historyRows.first().getByText(/1 · tickets/).click();
    await historyRows.first().getByRole('link',{name:ticketId}).click();
    await page.waitForURL(url=>url.pathname==='/tickets'&&url.searchParams.get('id')===ticketId);
    const foreignHistory=await request('/?view=record-access&token='+auditToken,{headers:other});
    assert.ok((await foreignHistory.text()).includes('No matching access events.'));

    console.log('Desktop Chrome created a scoped key, displayed a contact changed by that integration, restored an API-archived Ticket from the Recycle Bin, and revoked the key.');
  }finally{await browser.close();}
}
