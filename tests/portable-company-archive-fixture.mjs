import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const archivePath='/api/recycle-bin';
const crm='/api/crm';
const change=(record,action)=>({kind:'companies',id:record.id,expectedRevision:record.revision,action,requestId:randomUUID()});

export async function verifyPortableCompanyArchive({request,origin,headers,other,sql,sharing}){
  const workspaceId=sharing.workspaceId,shared='&workspaceId='+workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const send=(path,body,auth=headers,site=origin)=>request(path,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const receipt=async response=>{
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    return (await response.json()).receipt;
  };
  const create=async(path,body)=>{
    const response=await send(path,{action:'save',...body});
    assert.equal(response.status,201,await response.clone().text());
    const result=await response.json();
    return result.record??result;
  };
  const json=async path=>{
    const response=await get(path);
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };

  const name='Archived fictional Company '+randomUUID(),domain='archive-'+randomUUID().slice(0,8)+'.example.test';
  const company=await create(crm,{kind:'companies',data:{name,domain}});
  const id=company.id;
  const contact=await create(crm,{kind:'contacts',primaryCompanyId:id,data:{name:'Company archive linked contact'}});
  const linked=[
    {path:crm+'?kind=contacts&id=',idField:'primaryCompanyId',nameField:'primaryCompanyName',record:contact,
      table:'contacts',column:'primary_company_id',write:crm,base:{kind:'contacts'},link:'primaryCompanyId'},
    {path:crm+'?kind=deals&id=',idField:'companyId',nameField:'companyName',table:'deals',column:'company_id',write:crm,
      base:{kind:'deals'},link:'companyId',record:await create(crm,{kind:'deals',companyId:id,data:{name:'Company archive linked deal'}})},
    {path:crm+'?kind=tasks&id=',idField:'companyId',nameField:'companyName',table:'portable_tasks',column:'company_id',write:crm,
      base:{kind:'tasks'},link:'related',record:await create(crm,{kind:'tasks',related:{kind:'companies',id},data:{name:'Company archive linked task'}})},
    {path:'/api/leads?id=',idField:'companyId',nameField:'companyName',table:'portable_leads',column:'company_id',write:'/api/leads',
      base:{},link:'companyId',record:await create('/api/leads',{companyId:id,data:{name:'Company archive linked lead'}})},
    {path:'/api/tickets?id=',idField:'companyId',nameField:'companyName',table:'portable_tickets',column:'company_id',write:'/api/tickets',
      base:{},link:'companyId',record:await create('/api/tickets',{companyId:id,data:{name:'Company archive linked ticket'}})},
  ];
  for(const row of linked){
    const item=await json(row.path+row.record.id);
    assert.deepEqual([item[row.idField],item[row.nameField]],[id,name],row.table);
  }
  const associationPath='/api/associations?'+new URLSearchParams({kind:'contacts',id:contact.id});
  assert.equal((await send(associationPath,{action:'link',target:{kind:'companies',id},labels:['Fictional']})).status,200);
  const activityPath='/api/logged-activities?'+new URLSearchParams({kind:'companies',recordId:id});
  const activityId=randomUUID(),occurredAt=Date.now()-1000;
  assert.equal((await send(activityPath,{id:activityId,kind:'Note',occurredAt,summary:'Archived Company retained activity'})).status,201);

  const detail=crm+'?kind=companies&id='+id,history=crm+'?kind=companies&history='+id+'&field=name';
  const search=crm+'?'+new URLSearchParams({kind:'companies',search:name});
  const postSearch=()=>send('/api/crm/search',{kind:'companies',query:name});
  const report=async()=>{
    const response=await send('/api/reporting',{action:'preview',definition:{name:'Company archive counts',kind:'companies'}});
    assert.equal(response.status,200);
    return Number((await response.json()).result.total);
  };
  assert.equal((await get(detail+shared,other)).status,200);
  assert.equal((await get(history)).status,200);
  assert.equal((await get(activityPath)).status,200);
  assert.equal((await json(search)).records[0].id,id);
  assert.equal((await (await postSearch()).json()).counts.companies,1);
  assert.deepEqual((await json(associationPath)).items.map(item=>item.target.id),[id]);
  const reportBefore=await report();

  const editor=await get('/?'+new URLSearchParams({kind:'companies',record:id}));
  assert.equal(editor.status,200);
  assert.match(await editor.text(),/Archive company/);
  const binPage=await get('/?view=recycle-bin&kind=companies');
  assert.equal(binPage.status,200);
  assert.match(await binPage.text(),/Loading archived companies/);

  const archive={...change(company,'archive'),requestId:'00000000-0000-4000-8000-0000000000c1'};
  assert.equal((await request(archivePath+'?kind=companies')).status,401);
  assert.equal((await send(archivePath,archive,other)).status,404);
  assert.equal((await send(archivePath,archive,headers,'https://outside.example.test')).status,403);
  assert.equal((await send(archivePath,{...archive,expectedRevision:company.revision+1})).status,409);
  assert.equal((await send(archivePath,{...archive,kind:'contacts'})).status,404);

  await sql`ALTER TABLE portable_company_archive_receipts ADD CONSTRAINT fixture_company_archive_fail CHECK (request_id<>'00000000-0000-4000-8000-0000000000c1'::uuid)`;
  try{
    assert.equal((await send(archivePath,archive)).status,503);
    assert.equal((await json(detail)).revision,company.revision);
  }finally{await sql`ALTER TABLE portable_company_archive_receipts DROP CONSTRAINT fixture_company_archive_fail`;}

  const archived=await receipt(await send(archivePath,archive));
  assert.deepEqual([archived.id,archived.action,archived.revision],[id,'archive',company.revision+1]);
  assert.ok(Number.isFinite(Date.parse(archived.archivedAt)));
  assert.deepEqual(await receipt(await send(archivePath,archive)),archived);
  assert.equal((await send(archivePath,{...archive,action:'restore'})).status,409);
  const bin=await json(archivePath+'?kind=companies');
  assert.ok(bin.records.some(row=>row.id===id&&row.domain===domain&&row.archivedAt===archived.archivedAt));
  assert.ok(!(await (await get(archivePath+'?kind=companies',other)).json()).records.some(row=>row.id===id));
  assert.ok(!(await json(archivePath)).records.some(row=>row.id===id));

  for(const path of [detail,history,activityPath,'/api/associations?'+new URLSearchParams({kind:'companies',id})]){
    assert.equal((await get(path)).status,404,path);
  }
  assert.equal((await get(detail+shared,other)).status,404);
  assert.deepEqual((await json(search)).records,[]);
  assert.equal((await (await postSearch()).json()).counts.companies,0);
  assert.equal(await report(),reportBefore-1);
  assert.deepEqual((await json(associationPath)).items,[]);
  assert.equal((await send(crm,{action:'save',kind:'companies',id,expectedRevision:archived.revision,data:{name:'Stale archived edit'}})).status,404);
  assert.equal((await send(activityPath,{id:randomUUID(),kind:'Note',occurredAt,summary:'Stale log'})).status,404);
  assert.equal((await send(activityPath,{action:'update',id:activityId,expectedRevision:1,occurredAt,summary:'Stale edit'})).status,404);
  assert.equal((await send(associationPath,{action:'link',target:{kind:'companies',id},labels:['Other']})).status,404);
  for(const path of [crm+'?kind=contacts&companyId=',crm+'?kind=deals&companyId=','/api/tickets?companyId=']){
    assert.deepEqual((await json(path+id)).records,[],path);
  }

  // Linked records stay readable without the Company, keep the stored link,
  // reject new links to it, and keep the dormant link across unrelated edits.
  const stored=async row=>(await sql`SELECT revision,${sql(row.column)} AS company_id FROM ${sql(row.table)}
    WHERE workspace_id=${workspaceId} AND id=${row.record.id}`)[0];
  const explicit=row=>row.link==='related'?{related:{kind:'companies',id}}:{[row.link]:id};
  for(const row of linked){
    const item=await json(row.path+row.record.id);
    assert.deepEqual([item.id,item[row.idField],item[row.nameField]],[row.record.id,null,null],row.table);
    const before=await stored(row);
    assert.equal(before.company_id,id);
    const data={name:'Edited '+row.table+' beside an archived Company'};
    const update={action:'save',...row.base,id:row.record.id,expectedRevision:before.revision,data};
    assert.equal((await send(row.write,{action:'save',...row.base,...explicit(row),data})).status,404,'new '+row.table);
    assert.equal((await send(row.write,{...update,...explicit(row)})).status,404,'explicit '+row.table);
    const edited=await send(row.write,update);
    assert.equal(edited.status,200,row.table+' '+await edited.clone().text());
    const result=await edited.json();
    if(result.record)assert.equal(result.record[row.idField],null,row.table);
    assert.deepEqual({...await stored(row)},{revision:before.revision+1,company_id:id},row.table);
  }

  const duplicate=await create(crm,{kind:'companies',data:{name:'Fictional domain conflict',domain:domain.toUpperCase()}});
  const restore=change(archived,'restore');
  const collision=await send(archivePath,restore);
  assert.equal(collision.status,409);
  assert.match((await collision.json()).error,/already has this domain/);
  const cleared=await send(crm,{action:'save',kind:'companies',id:duplicate.id,expectedRevision:duplicate.revision,
    data:{...duplicate.data,domain:'conflict-cleared-'+domain}});
  assert.equal(cleared.status,200);
  const restored=await receipt(await send(archivePath,restore));
  assert.deepEqual(restored,{id,action:'restore',revision:company.revision+2,archivedAt:null});
  assert.deepEqual(await receipt(await send(archivePath,restore)),restored);
  const visible=await json(detail);
  assert.deepEqual([visible.id,visible.revision,visible.data],[id,restored.revision,company.data]);
  assert.deepEqual((await sql`SELECT revision FROM company_events WHERE company_id=${id} ORDER BY revision`).map(row=>row.revision),[1,2,3]);
  for(const row of linked){
    const item=await json(row.path+row.record.id);
    assert.deepEqual([item[row.idField],item[row.nameField]],[id,name],'restored '+row.table);
  }
  assert.deepEqual((await json(associationPath)).items.map(item=>item.target.id),[id]);
  assert.equal((await get(activityPath)).status,200);
  // The restored Company returns alongside the domain-conflict Company created above.
  assert.equal(await report(),reportBefore+1);

  // Archive and a new link serialize: either the link lands first and the
  // Company archives with it, or the link is refused after the archive.
  const target=await create(crm,{kind:'companies',data:{name:'Fictional racing Company'}});
  const [race,link]=await Promise.all([send(archivePath,change(target,'archive')),
    send(crm,{action:'save',kind:'deals',companyId:target.id,data:{name:'Racing Company deal'}})]);
  assert.equal(race.status,200,await race.clone().text());
  assert.ok([201,404].includes(link.status),'link status '+link.status);
  if(link.status===201){
    const deal=(await link.json()).record;
    assert.equal((await json(crm+'?kind=deals&id='+deal.id)).companyId,null);
  }

  // Leave one archived Company with a linked Contact for the second-instance restore.
  const recoveryCompany=await create(crm,{kind:'companies',data:{name:'Fictional recovered Company '+randomUUID()}});
  const recoveryContact=await create(crm,{kind:'contacts',primaryCompanyId:recoveryCompany.id,data:{name:'Recovered Company contact'}});
  const recoveryArchive=change(recoveryCompany,'archive');
  const recoveryReceipt=await receipt(await send(archivePath,recoveryArchive));
  await reset();
  return {archive:recoveryArchive,receipt:recoveryReceipt,company:recoveryCompany,contactId:recoveryContact.id};
}

export async function verifyRestoredPortableCompanyArchive({restored,origin,owner,other,source,sourceOwner,fixture}){
  const send=(input,auth=owner)=>restored(archivePath,{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(input)});
  const read=async(request,path,auth)=>{
    const response=await request(path,{headers:auth});
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  const receipt=async response=>{
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).receipt;
  };
  const detail=crm+'?kind=companies&id='+fixture.company.id,contact=crm+'?kind=contacts&id='+fixture.contactId;
  // The restored database carries the receipt, the archived state and the retained link.
  assert.deepEqual(await receipt(await send(fixture.archive)),fixture.receipt);
  assert.equal((await restored(detail,{headers:owner})).status,404);
  assert.ok((await read(restored,archivePath+'?kind=companies',owner)).records.some(row=>row.id===fixture.company.id));
  assert.equal((await read(restored,contact,owner)).primaryCompanyId,null);
  assert.equal((await send(change(fixture.receipt,'restore'),other)).status,404);
  const result=await receipt(await send(change(fixture.receipt,'restore')));
  assert.deepEqual(result,{id:fixture.company.id,action:'restore',revision:fixture.receipt.revision+1,archivedAt:null});
  const visible=await read(restored,detail,owner);
  assert.deepEqual([visible.id,visible.revision,visible.data],[fixture.company.id,result.revision,fixture.company.data]);
  const relinked=await read(restored,contact,owner);
  assert.deepEqual([relinked.primaryCompanyId,relinked.primaryCompanyName],[fixture.company.id,fixture.company.data.name]);
  // The source instance stays independent of the restored copy.
  assert.equal((await source(detail,{headers:sourceOwner})).status,404);
}
