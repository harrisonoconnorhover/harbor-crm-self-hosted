import assert from 'node:assert/strict';
import {verifyStandardPropertyAccess} from './portable-standard-property-access-fixture.mjs';

export async function verifyRecordPropertyAccess({request,origin,headers,other,sql},kind){
  const owner=headers,crm='/api/crm',settings='/api/custom-properties',teams='/api/workspaces';
  const post=(url,body,auth=owner)=>request(url,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const get=(url,auth=other)=>request(url,{headers:auth});
  const checked=async(pending,status=200)=>{
    const response=await pending;
    assert.equal(response.status,status,await response.clone().text());
    return response.json();
  };
  const workspaceId=(await checked(get(teams,owner))).owned;
  if(kind==='contacts')await verifyHistoryCursor({get,checked,owner,sql,workspaceId});
  const scope='workspaceId='+workspaceId;
  const email='other@example.test';
  const change=body=>checked(post(teams,body));
  const team=crypto.randomUUID();
  await change({action:'team_create',id:team,name:'Pricing team',parentId:null});
  const rep=(await change({action:'grant',email})).viewers.find(row=>row.email===email);
  await change({action:'role',role:'editor',id:rep.id});
  const member=(await checked(get(teams,owner))).viewers.find(row=>row.email===email);
  const assign=(teamId,previousTeamId)=>change({action:'team_assign',id:member.id,teamId,previousTeamId});
  const preview='/?view=settings&section=properties&member='+member.id;
  const write=crm+'?'+scope+'&grantId='+member.id;
  await verifyStandardPropertyAccess({request,origin,get,post,checked,owner,other,kind,scope,team,member,assign,write});
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const create=async(label,audience)=>(await checked(post(settings,{action:'create',kind,type:'text',label,audience}),201)).property;
  const field=await create('Confidential pricing');
  const ownerOnly=await create('Owner margin','owner');
  const value=kind+' fictional confidential margin',previous='Old margin',privateValue='Owner margin marker';
  const record=(await checked(post(crm,{action:'save',kind,data:{name:'Fictional quote',custom:{[field.id]:previous,[ownerOnly.id]:privateValue}}}),201)).record;
  const set=(url,revision,data,auth)=>post(url,{action:'save',kind,id:record.id,expectedRevision:revision,data:{name:'Fictional quote',...data}},auth);
  let saved=(await checked(set(crm,record.revision,{custom:{[field.id]:value}},owner))).record;
  const access=(audience,expectedRevision)=>post(settings,{action:'access',kind,id:field.id,audience,expectedRevision});
  assert.equal((await access(crypto.randomUUID(),field.revision)).status,400);
  const restricted=(await checked(access(team,field.revision))).property;
  assert.equal(restricted.audience,team);
  assert.equal((await access('workspace',field.revision)).status,409);
  async function checkPreview(label){
    const response=await get(preview,owner);
    assert.equal(response.status,200);
    const html=(await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
    const section=html.split('<section aria-label="'+kind[0].toUpperCase()+kind.slice(1)+'">')[1]?.split('</section>')[0];
    assert.ok(section?.includes('<dt>Confidential pricing</dt><dd>'+label+'</dd>'));
    assert.ok(section.includes('<dt>Owner margin</dt><dd>Hidden</dd>'));
    assert.ok(!html.includes(privateValue)&&!html.includes(value));
  }
  await checkPreview('Hidden');
  assert.equal((await get(preview,other)).status,404);
  const url=crm+'?kind='+kind+'&id='+record.id;
  const history=crm+'?kind='+kind+'&history='+record.id+'&field=custom:'+field.id+'&'+scope;
  const allHistory=crm+'?kind='+kind+'&history='+record.id+'&'+scope;
  const searchHistory=term=>checked(get(allHistory+'&search='+encodeURIComponent(term)));
  const search=()=>checked(post('/api/crm/search?'+scope,{kind,query:value},other));
  const reporting='/api/reporting';
  const report=async(name,customFilter)=>(await checked(post(reporting,{action:'report',definition:{kind,name,customFilter}}),201)).item;
  const general=await report(kind+' visible forecast');
  const filtered=await report(kind+' confidential report',{propertyId:field.id,operator:'is',value});
  const definition={name:kind+' leadership figures',cards:[general,filtered].map(row=>({reportId:row.id,wide:false}))};
  const dashboard=(await checked(post(reporting,{action:'dashboard',definition,teamVisible:true}),201)).item;
  const dashboardPath=reporting+'?view=dashboard&id='+dashboard.id+'&'+scope;
  const drill=reporting+'?view=dashboardRecords&id='+dashboard.id+'&reportId='+filtered.id+'&'+scope;
  const views='/api/crm/views';
  const {view}=await checked(post(views,{action:'create',kind,name:'Quote review',filters:{},columns:['name','custom:'+field.id]}),201);
  await checked(post(views,{action:'setSharing',kind,id:view.id,expectedRevision:view.revision,shared:true}));
  const pipeline=kind==='deals'?(await checked(post('/api/pipeline',{name:'Pricing approvals',stages:[
    {name:'Draft',outcome:'open'},{name:'Accepted',outcome:'won',requiredProperties:[{field:'custom:'+field.id,required:true}]},
    {name:'Declined',outcome:'lost'},
  ]}),201)).pipeline:null;
  await assign(team,null);
  await checkPreview('Visible');
  assert.deepEqual((await checked(get(url+'&'+scope))).data.custom,{[field.id]:value});
  assert.equal((await checked(get(history))).items[0].previous,previous);
  const changes=(await searchHistory(field.label.toUpperCase())).items;
  assert.deepEqual(changes.map(row=>[row.field,row.label,row.previous,row.value]),[
    ['custom:'+field.id,field.label,previous,value],['custom:'+field.id,field.label,null,previous],
  ]);
  assert.ok(changes[0].actorName&&Number.isFinite(Date.parse(changes[0].occurredAt)));
  assert.deepEqual((await searchHistory(previous)).items,changes);
  assert.deepEqual((await searchHistory('%_')).items,[]);
  assert.equal((await search()).total,1);
  assert.equal((await checked(get(dashboardPath))).cards[1].result.count,'1');
  saved=(await checked(set(write,saved.revision,{custom:{[field.id]:'Team-edited price'}},other))).record;
  assert.deepEqual(saved.data.custom,{[field.id]:'Team-edited price'});
  saved=(await checked(set(write,saved.revision,{custom:{[field.id]:value}},other))).record;
  await assign(null,team);
  if(kind!=='deals'){
    // Grant every merge permission, isolating the field audience as the reason for refusal.
    await sql`UPDATE portable_workspace_viewers SET contact_files=true, scheduled_notes=true,
      contact_outreach=true, record_activities=true WHERE id=${member.id}`;
    const secondary=(await checked(post(crm,{action:'save',kind,data:{name:'Fictional duplicate'}}),201)).record;
    const pair={kind,primaryId:record.id,secondaryId:secondary.id};
    const mergePath='/api/record-merge?'+scope+'&grantId='+member.id;
    for(const body of [{action:'preview',...pair},{action:'merge',...pair,requestId:crypto.randomUUID(),
      expectedRevisions:{primary:saved.revision,secondary:secondary.revision},choices:{}}]){
      const denied=await checked(post(mergePath,body,other),403);
      assert.match(denied.error,/access to all properties/);
    }
    const {preview}=await checked(post('/api/record-merge',{action:'preview',...pair}));
    assert.equal(preview.primary.data.custom[field.id],value);
  }
  if(pipeline){
    const move=()=>post(write,{action:'save',kind,id:saved.id,expectedRevision:saved.revision,data:{name:'Fictional quote'},
    pipelineId:pipeline.id,stageId:pipeline.stages[1].id},other);
    assert.equal((await move()).status,403);
  }
  const privateMarkers=[field.id,ownerOnly.id,value,privateValue,field.label,ownerOnly.label];
  const excludes=(text,markers=privateMarkers)=>{for(const marker of markers)assert.ok(!text.includes(marker),'Unexpected '+marker);};
  for(const path of [url+'&'+scope,crm+'?kind='+kind+'&'+scope,settings+'?kind='+kind+'&'+scope,views+'?kind='+kind+'&'+scope,'/?kind='+kind+'&savedView='+view.id+'&'+scope,
    ...(pipeline?['/?kind=deals&view=board&'+scope]:[]),'/?kind='+kind+'&record='+record.id+'&'+scope]){
    const response=await get(path);
    assert.equal(response.status,200,path);
    excludes(await response.text());
  }
  const csvPath=crm+'?kind='+kind+'&export=csv&savedView='+view.id;
  assert.equal((await get(csvPath+'&'+scope)).status,403);
  const ownerCsv=await get(csvPath,owner);
  assert.equal(ownerCsv.status,200);
  assert.ok((await ownerCsv.text()).includes(value));
  assert.equal((await get(history)).status,404);
  excludes(JSON.stringify(await checked(get(allHistory))));
  assert.deepEqual((await searchHistory(value)).items,[]);
  assert.equal((await post(write,{action:'save',kind,data:{name:'Fictional blocked write',custom:{[field.id]:value}}},other)).status,403);
  assert.equal((await search()).total,0);
  const summary=await checked(get(dashboardPath));
  assert.equal(summary.cards[1].missing,true);
  assert.equal(summary.cards[0].missing,false);
  excludes(JSON.stringify(summary));
  assert.equal((await get(drill)).status,404);
  for(const next of [value,null]){
    assert.equal((await set(write,saved.revision,{custom:{[field.id]:next}},other)).status,403);
  }
  const bulk=await post(write,{action:'editProperty',kind,field:'custom:'+field.id,mode:'replace',value,
    records:[{id:record.id,expectedRevision:saved.revision}]},other);
  assert.equal(bulk.status,400,await bulk.clone().text());
  saved=(await checked(set(write,saved.revision,{name:'Updated fictional quote'},other))).record;
  excludes(JSON.stringify(saved));
  assert.equal((await checked(get(url,owner))).data.custom[field.id],value);
  const {token}=await checked(post('/api/api-tokens',{name:kind+' privacy fixture',permission:'read',objects:[kind],days:30}),201);
  const bearer={authorization:'Bearer '+token},api='/api/v1/records/'+kind;
  for(const response of [await get(api,bearer),await get(api+'/'+record.id,bearer),await post(api+'/batch/read',{inputs:[{id:record.id}]},bearer)]){
    assert.equal(response.status,200);
    excludes(await response.text());
  }
  await assign(team,null);
  await change({action:'revoke',id:member.id});
  assert.equal((await get(allHistory)).status,404);
  assert.equal((await get(preview,owner)).status,404);
  await change({action:'grant',email});
  assert.equal((await get(preview,owner)).status,404);
  assert.equal((await checked(get(url+'&'+scope))).data.custom,undefined);
  const fresh=(await checked(get(teams,owner))).viewers.find(row=>row.email===email);
  await change({action:'revoke',id:fresh.id});
  assert.equal((await post(teams,{action:'team_remove',id:team,revision:1})).status,409);
  await checked(access('owner',restricted.revision));
  await change({action:'team_remove',id:team,revision:1});
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')`;
}

// A single form submission changes enough fields to split one revision over two pages.
async function verifyHistoryCursor({get,checked,owner,sql,workspaceId}){
  const id=crypto.randomUUID(),form=crypto.randomUUID(),at='2026-01-01T12:34:56.000Z';
  const editor=crypto.randomUUID(),editorEmail=editor+'@example.test';
  const fields=await sql`INSERT INTO portable_custom_properties(workspace_id,kind,id,label,type,options,revision)
    SELECT ${workspaceId},'contacts',gen_random_uuid(),'History ' || n,'text','[]',1 FROM generate_series(1,28) n RETURNING id`;
  const data={name:'Fictional historical submission',custom:Object.fromEntries(fields.map(({id})=>[id,'Recorded']))};
  await sql`INSERT INTO portable_lead_forms(workspace_id,id,revision,definition) VALUES(${workspaceId},${form},1,'{}')`;
  await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
    VALUES(${workspaceId},${id},1,${sql.json(data)},${at},${at})`;
  await sql`INSERT INTO contact_events(workspace_id,contact_id,revision,intake_form_id,data,occurred_at)
    VALUES(${workspaceId},${id},1,${form},${sql.json(data)},${at})`;
  try{
    const path='/api/crm?kind=contacts&history='+id;
    const page=await checked(get(path,owner));
    assert.equal(page.items.length,25);
    assert.deepEqual(page.next,{revision:1,field:page.items.at(-1).field});
    const older=await checked(get(path+'&before=1&afterField='+encodeURIComponent(page.next.field),owner));
    assert.equal(older.next,null);
    const combined=[...page.items,...older.items];
    assert.deepEqual(combined.map(change=>change.field),[...fields.map(row=>'custom:'+row.id),'name'].sort());
    for(const row of combined){
      assert.equal(row.actorName,null);
      assert.equal(row.occurredAt,at);
      assert.equal(row.previous,null);
    }
    // The signed-in editor has no display name. A genuine identity still resolves.
    await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
      VALUES(${editor},${editor},${editorEmail},0,0)`;
    await sql`INSERT INTO contact_events(workspace_id,contact_id,revision,actor_id,previous,data,occurred_at)
      VALUES(${workspaceId},${id},2,${editor},${sql.json(data)},${sql.json({...data,name:'Edited submission'})},now())`;
    const updated=await checked(get(path+'&search='+editorEmail,owner));
    assert.deepEqual(updated.items.map(row=>[row.field,row.actorName,row.previous,row.value]),[
      ['name',editorEmail,data.name,'Edited submission'],
    ]);
    assert.equal((await checked(get(path+'&field=name',owner))).items[0].actorName,editorEmail);
    assert.equal((await get(path+'&before=1',owner)).status,400);
    assert.equal((await get(path+'&afterField=name',owner)).status,400);
  }finally{
    await sql`DELETE FROM contact_events WHERE workspace_id=${workspaceId} AND contact_id=${id}`;
    await sql`DELETE FROM login_identities WHERE id=${editor}`;
    await sql`DELETE FROM contacts WHERE workspace_id=${workspaceId} AND id=${id}`;
    await sql`DELETE FROM portable_lead_forms WHERE id=${form}`;
    await sql`DELETE FROM portable_custom_properties WHERE workspace_id=${workspaceId} AND id=ANY(${fields.map(row=>row.id)}::uuid[])`;
  }
}
