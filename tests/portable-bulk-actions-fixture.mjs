import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const crm='/api/crm';

export async function verifyPortableBulkActions({request,origin,headers,other,sql,sharing}){
  const workspaceId=sharing.workspaceId;
  const reset=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  await reset();
  const send=(path,body,auth=headers,site=origin)=>request(path,{method:'POST',
    headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(body)});
  const json=async(path,auth=headers)=>{
    const response=await request(path,{headers:auth});
    assert.equal(response.status,200,path+' '+await response.clone().text());
    return response.json();
  };
  const save=async body=>{
    const response=await send(crm,{action:'save',...body});
    assert.equal(response.status,201,await response.clone().text());
    return (await response.json()).record;
  };
  const [{id:ownerId}]=await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`;
  const [{id:memberId}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const marker='Bulk '+randomUUID();
  const contacts=[];
  for(const n of [1,2,3])contacts.push(await save({kind:'contacts',data:{name:marker+' contact '+n}}));
  const companies=[await save({kind:'companies',data:{name:marker+' company 1'}}),await save({kind:'companies',data:{name:marker+' company 2'}})];
  const deals=[await save({kind:'deals',data:{name:marker+' deal 1'}}),await save({kind:'deals',data:{name:marker+' deal 2'}})];
  const pick=rows=>rows.map(row=>({id:row.id,expectedRevision:row.revision}));
  const assign=(kind,rows,assigneeId,auth=headers,path=crm)=>send(path,{action:'assignOwners',kind,assigneeId,records:rows},auth);
  const read=(kind,id)=>json(crm+'?'+new URLSearchParams({kind,id}));
  const revisions=async(kind,rows)=>Promise.all(rows.map(async row=>(await read(kind,row.id)).revision));

  // The list page offers a row checkbox for each record.
  const listPage=await (await request('/?'+new URLSearchParams({search:marker}),{headers})).text();
  assert.match(listPage,new RegExp('aria-label="Select '+marker+' contact 1"'));

  // Input checks.
  assert.equal((await send(crm,{action:'assignOwners',kind:'contacts',assigneeId:memberId,records:[pick(contacts)[0],pick(contacts)[0]]})).status,400);
  assert.equal((await send(crm,{action:'assignOwners',kind:'contacts',assigneeId:memberId,
    records:Array.from({length:51},()=>({id:randomUUID(),expectedRevision:1}))})).status,400);
  assert.equal((await send(crm,{action:'assignOwners',kind:'contacts',assigneeId:memberId,records:[]})).status,400);

  // All-or-nothing: a stale, missing or foreign row leaves every record unchanged.
  const before=await revisions('contacts',contacts);
  const stale=pick(contacts).map((row,index)=>index===1?{...row,expectedRevision:row.expectedRevision+1}:row);
  assert.equal((await assign('contacts',stale,memberId)).status,409);
  assert.equal((await assign('contacts',[...pick(contacts),{id:randomUUID(),expectedRevision:1}],memberId)).status,404);
  assert.equal((await assign('contacts',pick(contacts),memberId,other)).status,404,'a member cannot reach the owner workspace without a scope');
  assert.equal((await assign('contacts',pick(contacts),'not-a-member')).status,409);
  assert.deepEqual(await revisions('contacts',contacts),before);

  const assigned=await assign('contacts',pick(contacts),memberId);
  assert.equal(assigned.status,200,await assigned.clone().text());
  assert.deepEqual(await assigned.json(),{changed:3});
  for(const contact of contacts){
    const current=await read('contacts',contact.id);
    assert.deepEqual([current.revision,current.data.recordOwner?.userId,current.data.name],[contact.revision+1,memberId,contact.data.name]);
    const [event]=await sql`SELECT actor_id,previous->'recordOwner' AS previous FROM contact_events
      WHERE workspace_id=${workspaceId} AND contact_id=${contact.id} AND revision=${current.revision}`;
    assert.deepEqual({...event},{actor_id:ownerId,previous:null});
  }
  // A lost-response retry carries the old revisions and is refused without a second change.
  assert.equal((await assign('contacts',pick(contacts),memberId)).status,409);
  const fresh=await Promise.all(contacts.map(contact=>read('contacts',contact.id)));
  assert.deepEqual(await (await assign('contacts',pick(fresh),memberId)).json(),{changed:0});
  assert.deepEqual(await revisions('contacts',contacts),fresh.map(row=>row.revision));
  const cleared=await assign('contacts',pick(fresh),null);
  assert.deepEqual(await cleared.json(),{changed:3});
  assert.equal((await read('contacts',contacts[0].id)).data.recordOwner,undefined);
  assert.deepEqual((await json(crm+'?'+new URLSearchParams({kind:'contacts',owner:'unassigned',search:marker}))).records.length,3);

  // Companies; an archived row in the selection is unavailable.
  assert.deepEqual(await (await assign('companies',pick(companies),ownerId)).json(),{changed:2});
  const updatedCompanies=await Promise.all(companies.map(company=>read('companies',company.id)));
  assert.ok(updatedCompanies.every(company=>company.data.recordOwner?.userId===ownerId));
  const archived=await send('/api/recycle-bin',{kind:'companies',action:'archive',id:companies[1].id,
    expectedRevision:updatedCompanies[1].revision,requestId:randomUUID()});
  assert.equal(archived.status,200,await archived.clone().text());
  assert.equal((await assign('companies',pick(updatedCompanies),memberId)).status,404);
  assert.equal((await read('companies',companies[0].id)).data.recordOwner.userId,ownerId);

  // Shared editors assign through their grant, attributed to them.
  const scoped=crm+'?'+new URLSearchParams({workspaceId,grantId:sharing.grantId});
  assert.equal((await assign('deals',pick(deals),memberId,other,crm+'?'+new URLSearchParams({workspaceId,grantId:randomUUID()}))).status,403);
  const shared=await assign('deals',pick(deals),memberId,other,scoped);
  assert.equal(shared.status,200,await shared.clone().text());
  assert.deepEqual(await shared.json(),{changed:2});
  for(const deal of deals){
    const current=await read('deals',deal.id);
    assert.deepEqual([current.data.recordOwner?.userId,current.data.name,current.data.stage],[memberId,deal.data.name,deal.data.stage]);
    const [event]=await sql`SELECT actor_id FROM deal_events WHERE workspace_id=${workspaceId} AND deal_id=${deal.id} AND revision=${current.revision}`;
    assert.equal(event.actor_id,memberId);
  }
  await reset();
}
