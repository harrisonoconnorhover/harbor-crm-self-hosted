import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const archivePath='/api/recycle-bin';
const crm='/api/crm';

export async function verifyPortableSharedArchive({request,origin,headers,other,sql,sharing}){
  const workspaceId=sharing.workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const send=(path,body,auth=headers,site=origin)=>request(path,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const scoped=(grantId=sharing.grantId,query={})=>archivePath+'?'+new URLSearchParams({...query,workspaceId,grantId});
  const receipt=async response=>{
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).receipt;
  };
  const json=async(path,auth=headers)=>{
    const response=await get(path,auth);
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  const save=async body=>{
    const response=await send(crm,{action:'save',...body});
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).record;
  };
  const changeGrant=async role=>{
    const response=await send('/api/workspaces',{action:'role',id:sharing.grantId,role});
    assert.equal(response.status,200,await response.clone().text());
    const grant=(await response.json()).viewers.find(entry=>entry.email==='other@example.test');
    assert.equal(grant.role,role);
    sharing.grantId=grant.id;
    return grant;
  };
  const current=(await json('/api/workspaces')).viewers.find(grant=>grant.email==='other@example.test');
  assert.equal(current.role,'editor');
  assert.equal(current.id,sharing.grantId);
  const [{id:editorId,label:editorLabel}]=await sql`SELECT id,coalesce(nullif(full_name,''),email) AS label
    FROM login_identities WHERE email='other@example.test'`;
  const [{label:ownerLabel}]=await sql`SELECT coalesce(nullif(full_name,''),email) AS label FROM login_identities WHERE email='owner@example.test'`;

  const marker='Shared archive '+randomUUID();
  const records={
    contacts:await save({kind:'contacts',data:{name:marker+' contact'}}),
    companies:await save({kind:'companies',data:{name:marker+' company'}}),
    deals:await save({kind:'deals',data:{name:marker+' deal'}}),
    tasks:await save({kind:'tasks',data:{name:marker+' task'}}),
  };
  const detail=(kind,id,shared=true)=>crm+'?'+new URLSearchParams({kind,id,...(shared?{workspaceId}:{})});
  const input=(kind,record,action)=>({kind,id:record.id,expectedRevision:record.revision,action,requestId:randomUUID()});

  // Editors see the shared archive controls; the owner's own pages still work unscoped.
  const page=await get('/?'+new URLSearchParams({contact:records.contacts.id,workspaceId}),other);
  assert.equal(page.status,200);
  const pageHtml=await page.text();
  assert.match(pageHtml,/Archive contact/);
  const binLink=`href="/?view=recycle-bin&amp;workspaceId=${workspaceId}">Recycle Bin</a>`;
  assert.ok(pageHtml.includes(binLink),'Editors have a Recycle Bin link to this workspace');
  const sharedBin=await get('/?'+new URLSearchParams({view:'recycle-bin',kind:'deals',workspaceId}),other);
  assert.equal(sharedBin.status,200);
  assert.match(await sharedBin.text(),/Loading archived deals/);
  assert.equal((await get('/?'+new URLSearchParams({view:'recycle-bin',workspaceId:randomUUID()}),other)).status,404);

  // Scope checks: a wrong grant, extra parameters, an unscoped call and the owner using a member scope are refused.
  const contactArchive=input('contacts',records.contacts,'archive');
  assert.equal((await send(scoped(randomUUID()),contactArchive,other)).status,403);
  assert.equal((await send(scoped()+'&kind=contacts',contactArchive,other)).status,403);
  assert.equal((await send(archivePath,contactArchive,other)).status,404);
  assert.equal((await send(scoped(),contactArchive)).status,403);
  assert.equal((await send(scoped(),contactArchive,other,'https://outside.example.test')).status,403);
  assert.equal((await get(scoped(randomUUID()),other)).status,403);
  assert.equal((await get(scoped(sharing.grantId,{kind:'contacts'}),headers)).status,403);

  // Viewers can neither list nor change the shared Recycle Bin.
  const viewerGrant=await changeGrant('viewer');
  try{
    assert.equal((await send(scoped(),contactArchive,other)).status,403);
    assert.equal((await send(scoped(current.id),contactArchive,other)).status,403);
    assert.equal((await get(scoped(),other)).status,403);
    assert.equal((await get('/?'+new URLSearchParams({view:'recycle-bin',workspaceId}),other)).status,404);
    const viewerPage=await (await get('/?'+new URLSearchParams({contact:records.contacts.id,workspaceId}),other)).text();
    assert.doesNotMatch(viewerPage,/Archive contact/);
    assert.ok(!viewerPage.includes(binLink),'Viewers cannot open the shared Recycle Bin from a record');
    assert.equal(viewerGrant.id,sharing.grantId);
  }finally{await changeGrant('editor');}
  assert.equal((await json(detail('contacts',records.contacts.id,false))).revision,records.contacts.revision);

  for(const kind of ['contacts','companies','deals','tasks']){
    const record=records[kind];
    const archive=input(kind,record,'archive');
    const archived=await receipt(await send(scoped(),archive,other));
    assert.deepEqual([archived.id,archived.action,archived.revision],[record.id,'archive',record.revision+1],kind);
    assert.deepEqual(await receipt(await send(scoped(),archive,other)),archived,kind+' replay');
    assert.equal((await get(detail(kind,record.id),other)).status,404,kind);
    assert.equal((await get(detail(kind,record.id,false))).status,404,kind);
    const query=kind==='contacts'?{}:{kind};
    const ownerRow=(await json(archivePath+(kind==='contacts'?'':'?kind='+kind))).records.find(row=>row.id===record.id);
    const memberRow=(await json(scoped(sharing.grantId,query),other)).records.find(row=>row.id===record.id);
    assert.equal(ownerRow?.archivedBy,editorLabel,kind);
    assert.deepEqual(memberRow,ownerRow,kind);
    const events={contacts:['contact_events','contact_id'],companies:['company_events','company_id'],
      deals:['deal_events','deal_id'],tasks:['portable_task_events','task_id']}[kind];
    const [event]=await sql`SELECT actor_id FROM ${sql(events[0])} WHERE workspace_id=${workspaceId}
      AND ${sql(events[1])}=${record.id} AND revision=${archived.revision}`;
    assert.equal(event.actor_id,editorId,kind);

    // The owner restores one kind and the member restores the rest; both are attributed.
    const restoreBy=kind==='companies'?headers:other;
    const restoreUrl=kind==='companies'?archivePath:scoped();
    const restored=await receipt(await send(restoreUrl,input(kind,archived,'restore'),restoreBy));
    assert.deepEqual(restored,{id:record.id,action:'restore',revision:record.revision+2,archivedAt:null},kind);
    assert.equal((await json(detail(kind,record.id),other)).revision,restored.revision,kind);
    const [restoreEvent]=await sql`SELECT actor_id FROM ${sql(events[0])} WHERE workspace_id=${workspaceId}
      AND ${sql(events[1])}=${record.id} AND revision=${restored.revision}`;
    assert.equal(restoreEvent.actor_id,kind==='companies'?(await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`)[0].id:editorId);
  }

  // An archive made by the owner shows the owner's label to editors.
  const ownerArchived=await receipt(await send(archivePath,input('deals',await json(detail('deals',records.deals.id,false)),'archive')));
  const ownerRow=(await json(scoped(sharing.grantId,{kind:'deals'}),other)).records.find(row=>row.id===records.deals.id);
  assert.equal(ownerRow.archivedBy,ownerLabel);
  await receipt(await send(scoped(),input('deals',ownerArchived,'restore'),other));
  await reset();
}
