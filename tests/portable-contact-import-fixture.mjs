import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

export async function verifyPortableContactImport({request,origin,headers,other,sql,workspaceId}){
  const marker='Import fixture '+crypto.randomUUID();
  const rollbackName='Contact import fixture rollback';
  const path='/api/crm/import';
  const call=(body,auth=headers,site=origin,target=path)=>request(target,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const resetBudget=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const rows=()=>sql`SELECT id,workspace_id,data FROM contacts WHERE data->>'name' LIKE ${marker+'%'} OR data->>'name'=${rollbackName} ORDER BY id`;
  const [owner]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspaceId}`;
  const [jobCount]=await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE workspace_id=${workspaceId}`;
  const requestIds=[];
  const seeds=[];
  const companyIds=[];
  const propertyIds=[];
  const save=(auth,data)=>request('/api/crm',{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'save',kind:'contacts',data})});
  const seed=async(auth,email)=>{
    const response=await save(auth,{name:'Seed '+marker,email});
    assert.equal(response.status,201);
    const {record}=await response.json();
    seeds.push(record.id);
    return record.id;
  };
  const importBody=(csv,review)=>{
    const requestId=crypto.randomUUID();
    requestIds.push(requestId);
    return {action:'import',csv,review,requestId};
  };
  const preview=async(csv,auth=headers)=>{
    const response=await call({action:'preview',csv},auth);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    return response.json();
  };
  async function verifyContactCorrections(linkedId,companyId){
    await resetBudget();
    const key='linked-import@example.test',companion='correction-companion@example.test';
    const foreignContact=await seed(other,key);
    const saved=await call({action:'save',kind:'contacts',id:linkedId,expectedRevision:1,assigneeId:owner.owner_id,
      primaryCompanyId:companyId,data:{name:marker+' original',email:key,phone:'2025550108',city:'Portland',lifecycle:'Customer'}},
      headers,origin,'/api/crm');
    assert.equal(saved.status,200);
    const snapshot=async id=>(await sql`SELECT data,revision,primary_company_id FROM contacts WHERE id=${id}`)[0];
    const original=await snapshot(linkedId),foreignBefore=await snapshot(foreignContact);
    assert.ok(original.data.recordOwner);
    const sheet=`Name,Email,Phone,City\n${marker} corrected,${key.toUpperCase()},+12025550144,\n${marker} companion,${companion},,\n`;
    const reviewCorrection=async(csv=sheet)=>{
      const response=await call({action:'preview',csv,reviewMatches:true});
      assert.equal(response.status,200,await response.clone().text());
      return response.json();
    };
    const reviewed=await reviewCorrection();
    assert.deepEqual([reviewed.created,reviewed.updates,reviewed.skipped,reviewed.errors],[1,1,0,0]);
    assert.deepEqual(reviewed.rows[0].changes,[
      {field:'name',label:'Name',before:original.data.name,after:marker+' corrected'},
      {field:'phone',label:'Phone',before:'2025550108',after:'+12025550144'},
    ]);
    assert.deepEqual(await snapshot(linkedId),original,'Preview writes nothing.');
    const correctionBody=token=>({...importBody(sheet,token),reviewMatches:true,updateRows:[2],includeNew:true});
    const old=correctionBody(reviewed.review);
    assert.equal((await call({...old,updateRows:[],includeNew:false})).status,400);
    assert.equal((await call({...old,updateRows:[3]})).status,400);
    assert.equal((await call({...old,kind:'companies'})).status,409);
    assert.equal((await call(old,other)).status,409);
    const edit=await call({action:'patchContactText',id:linkedId,expectedRevision:original.revision,field:'title',value:'Buyer'},
      headers,origin,'/api/crm');
    assert.equal(edit.status,200);
    assert.equal((await call(old)).status,409);
    assert.equal((await sql`SELECT id FROM contacts WHERE workspace_id=${workspaceId} AND data->>'email'=${companion}`).length,0);
    const before=await snapshot(linkedId);
    const fresh=correctionBody((await reviewCorrection()).review);
    const applied=await Promise.all([call(fresh),call(fresh)]);
    assert.deepEqual(applied.map(r=>r.status).sort(),[200,201]);
    for(const response of applied)assert.deepEqual(await response.json(),{created:1,updated:1,skipped:0});
    assert.equal((await call({...fresh,updateRows:[]})).status,409);
    assert.equal((await call({...fresh,includeNew:false})).status,409);
    assert.deepEqual(await snapshot(foreignContact),foreignBefore);
    const after=await snapshot(linkedId);
    assert.equal(after.revision,before.revision+1);
    assert.equal(after.primary_company_id,companyId);
    assert.deepEqual(after.data,{...before.data,name:marker+' corrected',phone:'+12025550144'});
    const events=await sql`SELECT actor_id,previous,data,primary_company_id FROM contact_events WHERE contact_id=${linkedId}
      AND revision>${before.revision}`;
    assert.deepEqual(events.map(e=>({...e})),[{actor_id:owner.owner_id,previous:before.data,data:after.data,primary_company_id:companyId}]);
    const repeated=await reviewCorrection();
    assert.deepEqual([repeated.created,repeated.updates,repeated.skipped],[0,0,2]);
    const emailOnly=await reviewCorrection('Email\n'+key);
    assert.equal(emailOnly.updates,0,'A derived name from an email-only row never overwrites the real name.');
    const definition=await call({action:'create',kind:'contacts',label:'Check '+marker,type:'checkbox'},headers,origin,'/api/custom-properties');
    assert.equal(definition.status,201);
    const {property}=await definition.json();
    propertyIds.push(property.id);
    const choiceCsv=`Email,Consent\n${key},No\nnew-choice@example.test,Yes`,mapping=['email','custom:'+property.id];
    const choice=await call({action:'preview',csv:choiceCsv,mapping,reviewMatches:true});
    assert.equal(choice.status,200);
    const choices=await choice.json();
    assert.deepEqual(choices.rows[0].changes,[{field:mapping[1],label:property.label,before:null,after:false}]);
    const selected={...importBody(choiceCsv,choices.review),reviewMatches:true,mapping,updateRows:[2],includeNew:false};
    const updateOnly=await call(selected);
    assert.equal(updateOnly.status,201);
    assert.deepEqual(await updateOnly.json(),{created:0,updated:1,skipped:1});
    assert.deepEqual((await snapshot(linkedId)).data,{...after.data,custom:{...after.data.custom,[property.id]:false}});
    assert.equal((await sql`SELECT id FROM contacts WHERE workspace_id=${workspaceId} AND data->>'email'='new-choice@example.test'`).length,0);
    await sql`DELETE FROM portable_custom_properties WHERE id=${property.id}`;
    assert.equal((await call(selected)).status,200,'A committed receipt survives a subsequent change to the property catalog.');
    const duplicates=await reviewCorrection(sheet+`${marker} conflict,${key},+12025550999,\n`);
    assert.equal(duplicates.errors,2);
    assert.equal(duplicates.updates,0);
    await seed(headers,key);
    const ambiguous=await reviewCorrection();
    assert.match(ambiguous.rows[0].message,/Multiple contacts/);
    assert.equal(ambiguous.updates,0);
    assert.equal((await call(correctionBody(ambiguous.review))).status,400);
  }
  await resetBudget();

  try{
    const existingEmail='import-existing@example.test',foreignEmail='import-foreign@example.test';
    await seed(headers,existingEmail);
    await seed(other,foreignEmail);
    const archivedEmail='import-archived@example.test',archivedId=await seed(headers,archivedEmail);
    const [archivedBefore]=await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${workspaceId} AND id=${archivedId}
      RETURNING archived_at,data,revision`;
    const csv=['Full name,Email address,Description,Ignored',
      `${marker} no email,,"Line one\nLine ""two""",x`,
      `${marker} existing,${existingEmail.toUpperCase()},,x`,
      `${marker} new,${foreignEmail},,x`,
      `${marker} repeated,${foreignEmail.toUpperCase()},,x`,
      `${marker} replaces archived match,${archivedEmail.toUpperCase()},,x`,
    ].join('\r\n');
    assert.equal((await call({action:'preview',csv},{})).status,401);
    assert.equal((await call({action:'preview',csv},headers,'https://outside.example.test')).status,403);
    assert.equal((await call({action:'preview',csv},other,origin,path+'?workspaceId='+workspaceId)).status,403);
    assert.equal((await call({action:'preview',csv:'Name\n'+Array.from({length:501},(_,i)=>'Name '+i).join('\n')})).status,400);
    assert.equal((await call({action:'preview',csv:'Name\n"Unclosed'})).status,400);
    const ownHtml=await (await request('/',{headers})).text();
    const sharedHtml=await (await request('/?workspaceId='+workspaceId,{headers:other})).text();
    assert.match(ownHtml,/>Import Contacts CSV</);
    assert.doesNotMatch(sharedHtml,/>Import Contacts CSV</);

    const invalid=csv+`\r\n${marker} invalid,not-an-email,,x`;
    const failedReview=await preview(invalid);
    assert.equal(failedReview.errors,1);
    assert.equal(failedReview.rows.at(-1).state,'error');
    assert.equal((await call(importBody(invalid,failedReview.review))).status,400);
    assert.equal((await rows()).length,0,'A bad row blocks the entire reviewed file.');

    const reviewed=await preview(csv);
    assert.deepEqual([reviewed.created,reviewed.skipped,reviewed.errors],[3,2,0]);
    assert.deepEqual(reviewed.rows.map(row=>[row.row,row.state]),[[2,'create'],[3,'skip'],[4,'create'],[5,'skip'],[6,'create']]);
    assert.deepEqual(reviewed.columns.at(-1),{header:'Ignored',field:null});
    const automatic=['name','email','description',''];
    const sameMapping=await call({action:'preview',csv,mapping:automatic});
    assert.equal(sameMapping.status,200);
    assert.equal((await sameMapping.json()).review,reviewed.review,'Restating automatic mappings preserves the existing review.');
    assert.equal((await rows()).length,0,'Preview never writes contacts.');
    const body=importBody(csv,reviewed.review);
    const concurrent=await Promise.all([call(body),call(body)]);
    assert.deepEqual(concurrent.map(response=>response.status).sort(),[200,201]);
    assert.deepEqual(await concurrent[0].json(),{created:3,skipped:2});
    assert.deepEqual(await concurrent[1].json(),{created:3,skipped:2});
    assert.equal((await call({...body,mapping:automatic})).status,200,'Restating automatic mappings preserves an existing receipt.');
    assert.equal((await call({...body,csv:csv+'\r\n'})).status,409,'A request ID is bound to exact CSV and review.');
    assert.equal((await call({...body,review:'a'.repeat(43)})).status,409);
    const created=await rows();
    assert.equal(created.length,3);
    assert.ok(created.every(row=>row.workspace_id===workspaceId));
    assert.equal(created.find(row=>row.data.name.endsWith('no email')).data.description,'Line one\nLine "two"');
    assert.equal(created.find(row=>row.data.name.endsWith('new')).data.email,foreignEmail);
    assert.equal(created.find(row=>row.data.name.endsWith('archived match')).data.email,archivedEmail.toUpperCase());
    assert.deepEqual((await sql`SELECT archived_at,data,revision FROM contacts WHERE workspace_id=${workspaceId}
      AND id=${archivedId}`)[0],archivedBefore);
    const history=await sql`SELECT actor_id,revision,previous FROM contact_events
      WHERE workspace_id=${workspaceId} AND contact_id=ANY(${created.map(row=>row.id)}::uuid[])`;
    assert.deepEqual(history.map(row=>[row.actor_id,row.revision,row.previous]),
      Array.from({length:3},()=>[owner.owner_id,1,null]));
    assert.equal((await request('/api/crm?id='+created[0].id,{headers:other})).status,404);
    assert.equal((await call(body,other)).status,409,'Another workspace cannot reuse the owner review or receipt.');

    const mappedCsv=`Source label,Mail,Mail\r\n${marker} remapped,custom-map@example.test,custom-map@example.test`;
    const discovery=await call({action:'columns',csv:mappedCsv});
    assert.equal(discovery.status,200);
    assert.deepEqual((await discovery.json()).columns,[
      {header:'Source label',target:''},{header:'Mail',target:''},{header:'Mail',target:''},
    ]);
    assert.equal((await call({action:'preview',csv:mappedCsv})).status,400);
    for(const mapping of [['name','email'],['name','email','email'],['name','email','recordId'],['name','email','custom:example']]){
      assert.equal((await call({action:'preview',csv:mappedCsv,mapping})).status,400);
    }
    const firstMap=['name','email',''],secondMap=['name','','email'];
    const firstPreview=await call({action:'preview',csv:mappedCsv,mapping:firstMap});
    const secondPreview=await call({action:'preview',csv:mappedCsv,mapping:secondMap});
    assert.equal(firstPreview.status,200);
    assert.equal(secondPreview.status,200);
    const firstPlan=await firstPreview.json(),secondPlan=await secondPreview.json();
    assert.deepEqual(firstPlan.rows,secondPlan.rows);
    assert.notEqual(firstPlan.review,secondPlan.review,'Moving a mapping requires a fresh preview even when values match.');
    const mappedBody={...importBody(mappedCsv,firstPlan.review),mapping:firstMap};
    assert.equal((await call({...mappedBody,mapping:secondMap})).status,409);
    assert.equal((await call(mappedBody)).status,201);
    assert.equal((await call(mappedBody)).status,200);
    assert.equal((await call({...mappedBody,mapping:secondMap})).status,409,'A receipt cannot replay with a changed mapping.');
    assert.equal((await rows()).find(row=>row.data.name.endsWith('remapped')).data.email,'custom-map@example.test');

    const changedCsv=`Name,Email\r\n${marker} concurrent,import-race@example.test\r\n${marker} after,`;
    const beforeRace=await preview(changedCsv);
    assert.notEqual(beforeRace.review,(await preview(changedCsv,other)).review,'Identical plans have owner-bound review IDs.');
    const manual=await save(headers,{name:marker+' inserted meanwhile',email:'import-race@example.test'});
    assert.equal(manual.status,201);
    assert.equal((await call(importBody(changedCsv,beforeRace.review))).status,409);
    assert.ok(!(await rows()).some(row=>row.data.name.endsWith('after')));
    const afterRace=await preview(changedCsv);
    assert.deepEqual([afterRace.created,afterRace.skipped],[1,1]);
    assert.equal((await call(importBody(changedCsv,afterRace.review))).status,201);

    const restoredEmail='import-restored-during-commit@example.test',restoredId=await seed(headers,restoredEmail);
    await sql`UPDATE contacts SET archived_at=now() WHERE workspace_id=${workspaceId} AND id=${restoredId}`;
    const archiveCsv=`Name,Email\r\n${marker} archive race,${restoredEmail}\r\n${marker} archive companion,`;
    const archivePreview=await preview(archiveCsv);
    assert.equal(archivePreview.created,2);
    const archiveRequest=importBody(archiveCsv,archivePreview.review);
    let pendingImport;
    await sql.begin(async tx=>{
      await tx`SELECT id FROM private_workspaces WHERE id=${workspaceId} FOR NO KEY UPDATE`;
      await tx`UPDATE contacts SET archived_at=NULL WHERE workspace_id=${workspaceId} AND id=${restoredId}`;
      pendingImport=call(archiveRequest);
      let waiting=false;
      for(let i=0;i<80&&!waiting;i++){
        [{waiting}]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
          AND query LIKE '%from "private_workspaces"%for no key update%') AS waiting`;
        if(!waiting)await delay(25);
      }
      assert.ok(waiting,'CSV commit should wait behind the same workspace lock as Contact restore.');
    });
    assert.equal((await pendingImport).status,409);
    assert.ok(!(await rows()).some(row=>row.data.name.endsWith('archive race')||row.data.name.endsWith('archive companion')));
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_contact_import_receipts
      WHERE workspace_id=${workspaceId} AND request_id=${archiveRequest.requestId}`)[0].count,0);
    const afterRestore=await preview(archiveCsv);
    assert.deepEqual([afterRestore.created,afterRestore.skipped],[1,1]);
    assert.equal((await call(importBody(archiveCsv,afterRestore.review))).status,201);
    const replay=await call(body);
    assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),{created:3,skipped:2},'The original receipt wins over a fresh duplicate check.');

    const rollbackCsv=`Name\r\n${marker} atomic\r\n${rollbackName}`;
    const rollback=importBody(rollbackCsv,(await preview(rollbackCsv)).review);
    await sql`ALTER TABLE contact_events ADD CONSTRAINT fixture_import_rollback
      CHECK (data->>'name'<>'Contact import fixture rollback')`;
    try{
      assert.equal((await call(rollback)).status,503);
      assert.ok(!(await rows()).some(row=>row.data.name.endsWith('atomic')||row.data.name===rollbackName));
      assert.equal((await sql`SELECT count(*)::int AS count FROM portable_contact_import_receipts
        WHERE workspace_id=${workspaceId} AND request_id=${rollback.requestId}`)[0].count,0);
    }finally{await sql`ALTER TABLE contact_events DROP CONSTRAINT fixture_import_rollback`;}
    assert.equal((await call(rollback)).status,201,'An atomic failure leaves the reviewed request retryable.');
    await resetBudget();
    const saveCompany=(auth,data,id)=>request('/api/crm',{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'save',kind:'companies',data,...(id?{id,expectedRevision:1}:{})})});
    async function seedCompany(auth,name){
      const response=await saveCompany(auth,{name});
      assert.equal(response.status,201);
      const {record}=await response.json();
      companyIds.push(record.id);
      return record.id;
    }
    const companyId=await seedCompany(headers,'Own import company'),foreignId=await seedCompany(other,'Foreign import company');
    const linkedCsv=`Name,Email,Company Record ID\n${marker} linked,linked-import@example.test,${companyId.toUpperCase()}\n${marker} blank,blank-import@example.test,`;
    const companyMapping=['name','email','primaryCompanyId'];
    const companyPreview=async csv=>{
      const response=await call({action:'preview',csv,mapping:companyMapping});
      assert.equal(response.status,200);
      return response.json();
    };
    assert.equal((await preview(linkedCsv)).columns.at(-1).field,null,'Company linking is explicitly mapped.');
    const invalidLink=await companyPreview(linkedCsv+`\n${marker} foreign,foreign-company@example.test,${foreignId}\n${marker} invalid,invalid-company@example.test,invalid`);
    assert.equal(invalidLink.errors,2);
    assert.deepEqual(invalidLink.rows.slice(-2).map(row=>row.message),Array(2).fill('Choose an existing primary company Record ID from this workspace.'));
    assert.doesNotMatch(JSON.stringify(invalidLink),/Foreign import company/);
    const firstLink=await companyPreview(linkedCsv);
    assert.equal(firstLink.rows[0].company,'Own import company');
    assert.equal(firstLink.rows[1].company,undefined);
    const beforeRename={...importBody(linkedCsv,firstLink.review),mapping:companyMapping};
    assert.equal((await saveCompany(headers,{name:'Renamed import company'},companyId)).status,200);
    assert.equal((await call(beforeRename)).status,409);
    assert.ok(!(await rows()).some(row=>row.data.name.endsWith('linked')||row.data.name.endsWith('blank')));
    const approvedLink=await companyPreview(linkedCsv);
    assert.equal(approvedLink.rows[0].company,'Renamed import company');
    const approvedBody={...importBody(linkedCsv,approvedLink.review),mapping:companyMapping};
    assert.equal((await call(approvedBody)).status,201);
    assert.equal((await call(approvedBody)).status,200);
    const [{primary_company_id:storedCompany,data:linkedData,id:linkedId}]=await sql`SELECT id,data,primary_company_id FROM contacts
      WHERE workspace_id=${workspaceId} AND data->>'email'='linked-import@example.test'`;
    assert.equal(storedCompany,companyId);
    assert.equal(linkedData.importCompany,undefined);
    const [associationHistory]=await sql`SELECT primary_company_id,actor_id FROM contact_events
      WHERE workspace_id=${workspaceId} AND contact_id=${linkedId} AND revision=1`;
    assert.deepEqual({...associationHistory},{primary_company_id:companyId,actor_id:owner.owner_id});
    const linkedRecord=await (await request('/api/crm?id='+linkedId,{headers})).json();
    assert.equal(linkedRecord.primaryCompanyId,companyId);
    await resetBudget();
    const pairedCall=(data,auth=headers)=>call({kind:'paired',...data},auth);
    const pairedCsv=[
      'Contact Name,Contact Email,Company Name,Company Domain',
      `${marker} pair one,pair-one@example.test,${marker} company,new-paired.example.test`,
      `${marker} pair two,pair-two@example.test,${marker} company,NEW-PAIRED.EXAMPLE.TEST`,
      `${marker} pair existing,pair-existing@example.test,Ignored name,existing-paired.example.test`,
    ].join('\n');
    assert.match(ownHtml,/>Import Contacts and Companies CSV</);
    assert.doesNotMatch(sharedHtml,/>Import Contacts and Companies CSV</);
    const mapped=await pairedCall({action:'columns',csv:pairedCsv});
    assert.equal(mapped.status,200);
    assert.deepEqual((await mapped.json()).columns.map(column=>column.target),['contacts/name','contacts/email','companies/name','companies/domain']);
    const existingCompany=await saveCompany(headers,{name:'Retained paired company',domain:'existing-paired.example.test'});
    assert.equal(existingCompany.status,201);
    const existingCompanyId=(await existingCompany.json()).record.id;
    companyIds.push(existingCompanyId);
    const pairedPreview=async csv=>{
      const response=await pairedCall({action:'preview',csv});
      assert.equal(response.status,200,await response.clone().text());
      return response.json();
    };
    const firstPair=await pairedPreview(pairedCsv);
    const stalePair=importBody(pairedCsv,firstPair.review);
    assert.equal((await saveCompany(headers,{name:'Renamed paired company',domain:'existing-paired.example.test'},existingCompanyId)).status,200);
    assert.equal((await pairedCall(stalePair)).status,409);
    const reviewedPair=await pairedPreview(pairedCsv);
    assert.deepEqual(reviewedPair.paired,{contacts:3,companies:1,reusedCompanies:1});
    assert.equal(reviewedPair.errors,0);
    assert.deepEqual(reviewedPair.rows.filter(row=>row.object==='Contact').map(row=>row.company),
      [marker+' company',marker+' company','Renamed paired company']);
    assert.ok(!(await rows()).some(row=>row.data.name.includes(' pair ')));
    const pairRequest=importBody(pairedCsv,reviewedPair.review);
    assert.equal((await pairedCall(pairRequest,other)).status,409);
    const acceptedPair=await pairedCall(pairRequest);
    assert.equal(acceptedPair.status,201,await acceptedPair.clone().text());
    assert.deepEqual((await acceptedPair.json()).paired,reviewedPair.paired);
    assert.equal((await pairedCall(pairRequest)).status,200);
    const linked=await sql`SELECT c.data->>'name' AS name,o.data->>'name' AS company FROM contacts c
      JOIN companies o ON o.workspace_id=c.workspace_id AND o.id=c.primary_company_id
      WHERE c.workspace_id=${workspaceId} AND c.data->>'email' IN ('pair-one@example.test','pair-two@example.test','pair-existing@example.test')
      ORDER BY c.data->>'email'`;
    assert.deepEqual(linked.map(row=>row.company),['Renamed paired company',marker+' company',marker+' company']);
    assert.equal((await sql`SELECT count(*)::int AS total FROM companies WHERE workspace_id=${workspaceId}
      AND lower(data->>'domain')='new-paired.example.test'`)[0].total,1);
    const duplicateCompany=await saveCompany(headers,{name:'Duplicate paired company',domain:'existing-paired.example.test'});
    assert.equal(duplicateCompany.status,201);
    companyIds.push((await duplicateCompany.json()).record.id);
    const ambiguousCsv=`Contact Name,Contact Email,Company Name,Company Domain\n${marker} ambiguous,ambiguous-paired@example.test,Ignored,existing-paired.example.test`;
    const ambiguous=await pairedPreview(ambiguousCsv);
    assert.equal(ambiguous.errors,1);
    assert.equal((await pairedCall(importBody(ambiguousCsv,ambiguous.review))).status,400);
    const conflicting=pairedCsv+`\n${marker} pair one,pair-one@example.test,Conflicting company,conflict-paired.example.test`;
    assert.equal((await pairedCall({action:'preview',csv:conflicting})).status,400);
    const atomicCsv=`Contact Name,Contact Email,Company Name,Company Domain\n${marker} paired rollback,paired-rollback@example.test,${marker} rollback company,rollback-paired.example.test`;
    const pairRollback=importBody(atomicCsv,(await pairedPreview(atomicCsv)).review);
    await sql`ALTER TABLE contact_events ADD CONSTRAINT fixture_paired_rollback CHECK (data->>'name' NOT LIKE '% paired rollback')`;
    try{
      assert.equal((await pairedCall(pairRollback)).status,503);
      assert.equal((await sql`SELECT count(*)::int AS total FROM companies WHERE workspace_id=${workspaceId}
        AND data->>'domain'='rollback-paired.example.test'`)[0].total,0);
    }finally{await sql`ALTER TABLE contact_events DROP CONSTRAINT fixture_paired_rollback`;}
    await verifyContactCorrections(linkedId,companyId);
    assert.equal((await sql`SELECT count(*)::int AS count FROM portable_jobs WHERE workspace_id=${workspaceId}`)[0].count,jobCount.count);
  }finally{
    const ids=[...seeds,...(await rows()).map(row=>row.id)];
    await sql`DELETE FROM contact_events WHERE contact_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM contacts WHERE id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM portable_contact_import_receipts WHERE request_id=ANY(${requestIds}::uuid[])`;
    await sql`DELETE FROM portable_custom_properties WHERE id=ANY(${propertyIds}::uuid[])`;
    const pairedCompanies=await sql`SELECT id FROM companies WHERE workspace_id=${workspaceId} AND data->>'name' LIKE ${marker+'%'}`;
    companyIds.push(...pairedCompanies.map(row=>row.id));
    await sql`DELETE FROM company_events WHERE company_id=ANY(${companyIds}::uuid[])`;
    await sql`DELETE FROM companies WHERE id=ANY(${companyIds}::uuid[])`;
    await resetBudget();
  }
}
