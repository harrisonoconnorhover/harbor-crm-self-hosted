import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const viewEndpoint='/api/crm/views';
const configuredColumns={
  contacts:['name','phone','email'],
  companies:['name','website','domain'],
  deals:['name','stageName','amount'],
};
const configuredHeaders={
  contacts:['Name','Phone','Email'],
  companies:['Name','Website','Domain'],
  deals:['Name','Deal stage','Amount'],
};
function assertViewColumns(html,kind){
  const header=html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/)?.[1];
  assert.ok(header,'The saved view has a records table.');
  // Editors also get a leading row-selection control column; it is not part of the saved layout.
  assert.deepEqual(Array.from(header.matchAll(/<th(?:\s[^>]*)?>([^<]*)<\/th>/g),match=>match[1]).filter(text=>text!=='Select'),configuredHeaders[kind]);
  const href=kind==='contacts'?'contact=[0-9a-f-]{36}':'record=[0-9a-f-]{36}&amp;kind='+kind;
  assert.match(html,new RegExp('<th[^>]*scope="row"[^>]*><a[^>]*href="/\\?'+href+'(?:&amp;[^"]*)?"[^>]*>[^<]+</a></th>'));
}
function csvPath(kind,savedView,extra={}){
  return '/api/crm?'+new URLSearchParams({export:'csv',kind,savedView,...extra});
}
async function viewCsv(request,view,headers){
  const response=await request(csvPath(view.kind,view.id),{headers});
  assert.equal(response.status,200,await response.clone().text());
  assert.match(response.headers.get('content-type')??'',/^text\/csv/);
  const rows=(await response.text()).split('\r\n');
  assert.equal(rows[0],['Record ID',...configuredHeaders[view.kind]].map(label=>'"'+label+'"').join(','));
  return rows.slice(1,-1);
}
const resetViewBudgets=sql=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
  (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
function viewPath(kind,id,workspaceId){
  const params=new URLSearchParams({kind,savedView:id});
  if(workspaceId)params.set('workspaceId',workspaceId);
  return '/?'+params;
}

export async function verifyPortableSavedViews({request,origin,headers,other,sql,sharing}){
  const {workspaceId}=sharing;
  await resetViewBudgets(sql);
  const write=(payload,auth=headers,site=origin)=>request(viewEndpoint,{
    method:'POST',headers:{...auth,origin:site,'content-type':'application/json'},body:JSON.stringify(payload),
  });
  const list=(kind,auth=headers)=>request(viewEndpoint+'?kind='+kind,{headers:auth});
  const open=(kind,id,auth=headers)=>request(viewPath(kind,id),{headers:auth});
  async function create(kind,name,filters,auth=headers,columns){
    const result=await write({action:'create',kind,name,filters,columns},auth);
    assert.equal(result.status,201,await result.clone().text());
    return (await result.json()).view;
  }

  assert.equal((await list('contacts',{})).status,401);
  assert.equal((await request(viewEndpoint+'?kind=contacts&kind=deals',{headers})).status,400);
  assert.equal((await request(viewEndpoint+'?kind=contacts&workspaceId=invalid',{headers})).status,400);
  const input={action:'create',kind:'contacts',name:'Follow-up contacts',filters:{search:'Owner edit'}};
  assert.equal((await write(input,headers,'https://outside.example.test')).status,403);
  assert.equal((await write({...input,filters:{stage:'Closed won'}})).status,400);
  assert.equal((await write({...input,filters:{companyId:randomUUID()}})).status,400);
  for(const columns of [[],['email','name'],['name','phone','phone'],['name','stageName']]){
    assert.equal((await write({...input,columns})).status,400);
  }
  const contact=await create('contacts',' Follow-up contacts ',{search:' Owner edit '},headers,configuredColumns.contacts);
  assert.deepEqual(contact,{id:contact.id,kind:'contacts',name:'Follow-up contacts',filters:{search:'Owner edit'},
    columns:configuredColumns.contacts,revision:1,shared:false});
  assert.equal((await write({...input,name:'FOLLOW-UP CONTACTS'})).status,409);
  const foreign=await create('contacts',contact.name,{search:'Other only'},other);
  assert.notEqual(contact.id,foreign.id);
  assert.equal('columns' in foreign,false);
  assert.deepEqual(await (await list('contacts',other)).json(),{views:[foreign]});
  assert.equal((await open('contacts',contact.id,other)).status,404);
  assert.equal((await open('companies',contact.id)).status,404);
  assert.equal((await request(viewPath('contacts',contact.id)+'&search=override',{headers})).status,404);
  assert.equal((await write({action:'delete',kind:'contacts',id:contact.id,expectedRevision:1},other)).status,404);
  const ownView=await open('contacts',contact.id);
  assert.equal(ownView.status,200);
  const ownHtml=await ownView.text();
  assert.match(ownHtml,/aria-label="Saved views"/);
  assertViewColumns(ownHtml,'contacts');
  assert.match(ownHtml,/Follow-up contacts/);
  assert.match(ownHtml,/Owner edit [AB]/);
  assert.doesNotMatch(ownHtml,/Other only|Owner second/);
  assert.equal((await open('contacts',contact.id,{})).status,307);

  const save={action:'update',kind:'contacts',id:contact.id,expectedRevision:1,filters:{search:'Owner edit'}};
  const concurrent=await Promise.all([write({...save,name:'My outreach'}),write({...save,name:'Priority outreach'})]);
  assert.deepEqual(concurrent.map(item=>item.status).sort(),[200,409]);
  const updated=(await concurrent.find(item=>item.ok).json()).view;
  assert.equal(updated.revision,2);
  assert.equal(updated.id,contact.id);
  assert.deepEqual(updated.columns,configuredColumns.contacts,'An older client can update filters without removing configured columns.');
  assert.equal((await write({action:'delete',kind:'contacts',id:contact.id,expectedRevision:1})).status,409);

  const disposable=await create('contacts','Disposable view',{},headers,['name','title']);
  const change={action:'update',kind:'contacts',id:disposable.id,expectedRevision:1,name:disposable.name,filters:{}};
  const reordered=await write({...change,columns:['name','email','title']});
  assert.equal(reordered.status,200,await reordered.clone().text());
  assert.deepEqual((await reordered.json()).view.columns,['name','email','title']);
  const reset=await write({...change,expectedRevision:2,columns:null});
  assert.equal(reset.status,200,await reset.clone().text());
  const {view:defaultView}=await reset.json();
  assert.equal(defaultView.revision,3);
  assert.equal('columns' in defaultView,false);
  assert.match(await (await open('contacts',disposable.id)).text(),/<thead[^>]*><tr[^>]*>(?:<th[^>]*>Select<\/th>)?<th[^>]*>Name<\/th><th[^>]*>Email<\/th>/);
  assert.equal((await write({action:'delete',kind:'contacts',id:disposable.id,expectedRevision:3})).status,200);
  assert.equal((await open('contacts',disposable.id)).status,404);
  assert.deepEqual(await (await list('contacts')).json(),{views:[updated]});

  const deal=await create('deals','December wins',{search:'Owner Deal',stage:'Closed won',pipelineId:'default',closeMonth:'2026-12'},headers,configuredColumns.deals);
  const dealPage=await open('deals',deal.id);
  assert.equal(dealPage.status,200);
  const dealHtml=await dealPage.text();
  assert.match(dealHtml,/Owner Deal/);
  assertViewColumns(dealHtml,'deals');
  assert.match(dealHtml,/Close month 2026-12/);
  assert.doesNotMatch(dealHtml,/Owner Second Deal|Other Deal/);

  const ids=Array.from({length:26},()=>randomUUID()).sort();
  await sql`INSERT INTO companies(workspace_id,id,revision,data,created_at,updated_at)
    SELECT ${workspaceId}, id, 1, jsonb_build_object('name','Saved view pager '||position),now(),now()
    FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS rows(id,position)`;
  const company=await create('companies','Pager companies',{search:'Saved view pager'},headers,configuredColumns.companies);
  const first=await open('companies',company.id);
  assert.equal(first.status,200);
  const firstHtml=await first.text();
  assert.match(firstHtml,/Saved view pager 25</);
  assertViewColumns(firstHtml,'companies');
  assert.doesNotMatch(firstHtml,/Saved view pager 26</);
  const nextLink=firstHtml.match(/href="([^"]+)"[^>]*>Next page<\/a>/)?.[1]?.replaceAll('&amp;','&');
  assert.equal(nextLink,viewPath('companies',company.id)+'&after='+ids[24]);
  const second=await request(nextLink,{headers});
  assert.equal(second.status,200);
  const secondHtml=await second.text();
  assert.match(secondHtml,/Saved view pager 26</);
  assertViewColumns(secondHtml,'companies');
  assert.doesNotMatch(secondHtml,/Saved view pager 25<|Owner Company/);
  assert.equal((await request(viewPath('companies',company.id)+'&workspaceId='+workspaceId,{headers})).status,404);

  const contactsCsv=await viewCsv(request,updated,headers);
  assert.equal(contactsCsv.length,1);
  assert.match(contactsCsv[0],/Owner edit [AB]/);
  const dealsCsv=await viewCsv(request,deal,headers);
  assert.equal(dealsCsv.length,1);
  assert.match(dealsCsv[0],/"Owner Deal","Closed won"/);
  const companiesCsv=await viewCsv(request,company,headers);
  assert.equal(companiesCsv.length,26,'Saved-view CSV exports every match beyond the visible page.');
  assert.match(companiesCsv[25],/Saved view pager 26/);
  assert.equal((await request(csvPath('contacts',updated.id,{search:'override'}),{headers})).status,400);
  assert.equal((await request(csvPath('companies',updated.id),{headers})).status,404);
  assert.equal((await request(csvPath('contacts',randomUUID()),{headers})).status,404);
  assert.equal((await request(csvPath('contacts',foreign.id),{headers})).status,404);
  const shared=await verifySharedSavedViewAccess({request,origin,headers,other,sql,sharing,savedViews:{updated,foreign,company,deal}});
  await verifyOutreachDateColumn({request,origin,headers,other,sql,sharing});
  await verifyOptionalSavedViewColumns({request,origin,headers,other,sql,workspaceId});
  await verifyOwnerSavedViewFilters({request,origin,headers,other,sql,workspaceId});
  return shared;
}

async function verifyOutreachDateColumn({request,origin,headers,other,sql,sharing}){
  await resetViewBudgets(sql);
  const {workspaceId}=sharing;
  const {post,open,list,change}=sharedFixture({request,origin,headers,other,workspaceId});
  let grant=(await (await request('/api/workspaces',{headers})).json()).viewers.find(row=>row.email==='other@example.test');
  const originalOutreach=grant.contactOutreach;
  async function setOutreach(enabled){
    grant=await change({action:'contact_outreach',id:grant.id,enabled});
    sharing.grantId=grant.id;
  }
  const workspaces=await sql`SELECT w.id,w.owner_id,i.email FROM private_workspaces w
    JOIN login_identities i ON i.id=w.owner_id WHERE i.email IN ('owner@example.test','other@example.test')`;
  const own=workspaces.find(row=>row.id===workspaceId);
  const foreign=workspaces.find(row=>row.email==='other@example.test');
  const ids=Array.from({length:26},()=>randomUUID()).sort();
  const time=Date.now()-86_400_000;
  const search='Outreach date fixture '+randomUUID();
  const column='lastContacted';
  let view;
  try{
    await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      SELECT ${workspaceId},id,1,jsonb_build_object('name',${search}::text||' '||position),now(),now()
      FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS rows(id,position)`;
    await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      VALUES (${foreign.id},${ids[0]},1,'{"name":"Same ID in a separate workspace"}',now(),now())`;
    for(const [workspace,id,kind,occurredAt] of [
      [own,ids[0],'Call',time],[own,ids[0],'Note',time+1000],[own,ids[25],'Meeting',time+2000],
      [foreign,ids[0],'Call',time+3000],
    ]){
      await sql`INSERT INTO portable_contact_activities(workspace_id,id,contact_id,actor_id,kind,occurred_at,recorded_at,summary)
        VALUES (${workspace.id},gen_random_uuid(),${id},${workspace.owner_id},${kind},${occurredAt},${time+5000},'Fictional outreach')`;
    }
    const response=await post(viewEndpoint,{action:'create',kind:'contacts',name:search,filters:{search},columns:['name',column]});
    assert.equal(response.status,201,await response.clone().text());
    ({view}=await response.json());
    const ownPath=viewPath('contacts',view.id);
    const first=await (await request(ownPath,{headers})).text();
    const iso=at=>new Date(at).toISOString();
    assert.match(first,/<th>Last contacted<\/th>/);
    assert.ok(first.includes('<td>'+iso(time)+'</td>'));
    assert.ok(!first.includes(iso(time+1000))&&!first.includes(iso(time+2000))&&!first.includes(iso(time+3000)));
    const second=await (await request(ownPath+'&after='+ids[24],{headers})).text();
    assert.ok(second.includes('<td>'+iso(time+2000)+'</td>')&&!second.includes(iso(time)));
    const csv=await request(csvPath('contacts',view.id),{headers});
    assert.equal(csv.status,200);
    const rows=(await csv.text()).trimEnd().split('\r\n');
    assert.equal(rows.length,27);
    assert.equal(rows[0],'"Record ID","Name","Last contacted"');
    assert.equal(rows[1],`"${ids[0]}","${search} 1","${iso(time)}"`);
    assert.equal(rows[2],`"${ids[1]}","${search} 2",""`);
    assert.equal(rows[26],`"${ids[25]}","${search} 26","${iso(time+2000)}"`);
    const published=await post(viewEndpoint,{action:'setSharing',kind:'contacts',id:view.id,expectedRevision:view.revision,shared:true});
    assert.equal(published.status,200);
    ({view}=await published.json());
    const sharedColumns=async ()=>(await (await list('contacts')).json()).views.find(row=>row.id===view.id)?.columns;
    const detail=()=>request('/api/logged-activities?'+new URLSearchParams({contactId:ids[0],workspaceId}),{headers:other});
    if(grant.contactOutreach)await setOutreach(false);
    const hidden=await (await open(view)).text();
    assert.ok(hidden.includes(search+' 1'));
    assert.ok(!hidden.includes('Last contacted')&&!hidden.includes(iso(time)));
    assert.deepEqual(await sharedColumns(),['name']);
    assert.equal((await detail()).status,404);

    await setOutreach(true);
    const shared=await (await open(view)).text();
    assert.match(shared,/<th>Last contacted<\/th>/);
    assert.ok(shared.includes('<td>'+iso(time)+'</td>'));
    assert.ok(!shared.includes(iso(time+1000))&&!shared.includes(iso(time+2000))&&!shared.includes(iso(time+3000)));
    assert.deepEqual(await sharedColumns(),['name',column]);
    assert.equal((await (await detail()).json()).lastContacted,time);
    const sharedNext=await request(viewPath('contacts',view.id,workspaceId)+'&after='+ids[24],{headers:other});
    const sharedSecond=await sharedNext.text();
    assert.ok(sharedSecond.includes('<td>'+iso(time+2000)+'</td>')&&!sharedSecond.includes(iso(time)));
    assert.equal((await request(csvPath('contacts',view.id),{headers:other})).status,404);

    await setOutreach(false);
    const revoked=await (await open(view)).text();
    assert.ok(revoked.includes(search+' 1')&&!revoked.includes('Last contacted')&&!revoked.includes(iso(time)));
    assert.deepEqual(await sharedColumns(),['name']);
    assert.equal((await detail()).status,404);
    assert.deepEqual(view.columns,['name',column]);

    // Sorting uses occurred time and the ID tie-break before pagination. Keep the
    // original view checks above to cover older saved definitions without a sort.
    await sql`INSERT INTO portable_contact_activities(workspace_id,id,contact_id,actor_id,kind,occurred_at,recorded_at,summary)
      VALUES (${workspaceId},gen_random_uuid(),${ids[1]},${own.owner_id},'Email',${time},${time+6000},'Fictional tie')`;
    const sortRead=(sort,extra={},auth=headers)=>request('/api/crm?'+new URLSearchParams({kind:'contacts',search,sort,limit:1,...extra}),{headers:auth});
    const newest=await (await sortRead('outreach-newest')).json();
    assert.deepEqual(newest.records.map(row=>row.id),[ids[25]]);
    assert.ok(!('outreachAt' in newest.records[0]));
    const next=await (await sortRead('outreach-newest',{after:newest.next})).json();
    assert.deepEqual(next.records.map(row=>row.id),[ids[0]]);
    const tie=await (await sortRead('outreach-newest',{after:next.next})).json();
    assert.deepEqual(tie.records.map(row=>row.id),[ids[1]]);
    const blanks=await (await sortRead('outreach-newest',{after:tie.next})).json();
    assert.deepEqual(blanks.records.map(row=>row.id),[ids[2]]);
    const oldest=await (await sortRead('outreach-oldest')).json();
    assert.deepEqual(oldest.records.map(row=>row.id),[ids[0]]);
    assert.equal((await sortRead('outreach-newest',{after:ids[0]})).status,400);
    assert.equal((await sortRead('outreach-newest',{kind:'companies'})).status,400);
    assert.equal((await sortRead('outreach-newest',{after:ids[0]+':9007199254740992'})).status,400);

    const saved=await post(viewEndpoint,{action:'update',kind:'contacts',id:view.id,expectedRevision:view.revision,name:search,
      filters:{search,sort:'outreach-newest'},columns:['name',column]});
    assert.equal(saved.status,200,await saved.clone().text());
    ({view}=await saved.json());
    await setOutreach(true);
    const sortedPage=await (await open(view)).text();
    assert.match(sortedPage,/<th aria-sort="descending">Last contacted<\/th>/);
    const cell=position=>`>${search} ${position}</a></th>`;
    assert.ok(sortedPage.indexOf(cell(26))>=0&&sortedPage.indexOf(cell(26))<sortedPage.indexOf(cell(1)));
    const pageLink=sortedPage.match(/href="([^"]+)"[^>]*>Next page<\/a>/)?.[1].replaceAll('&amp;','&');
    assert.ok(pageLink,'sorted saved view has a second page');
    const tail=await (await request(pageLink,{headers:other})).text();
    assert.ok(tail.includes(cell(25))&&!tail.includes(cell(26)));
    const exported=(await (await request(csvPath('contacts',view.id),{headers})).text()).trimEnd().split('\r\n');
    assert.ok(exported[1].startsWith(`"${ids[25]}"`)&&exported[2].startsWith(`"${ids[0]}"`));
    await setOutreach(false);
    const noGrant=await (await open(view)).text();
    assert.ok(noGrant.includes(cell(1))&&!noGrant.includes(cell(26))&&!noGrant.includes('Last contacted'));
    const downgraded=await (await sortRead('outreach-newest',{workspaceId,after:newest.next},other)).json();
    assert.deepEqual(downgraded.records.map(row=>row.id),[ids[0]]);
    assert.equal(downgraded.next,ids[0]+':none');
  }finally{
    if(grant.contactOutreach!==originalOutreach)await setOutreach(originalOutreach);
    if(view)assert.equal((await post(viewEndpoint,{action:'delete',kind:'contacts',id:view.id,expectedRevision:view.revision})).status,200);
    await sql`DELETE FROM portable_contact_activities WHERE workspace_id IN (${workspaceId},${foreign.id}) AND contact_id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM contacts WHERE workspace_id IN (${workspaceId},${foreign.id}) AND id=ANY(${ids}::uuid[])`;
    await resetViewBudgets(sql);
  }
}

async function verifyOwnerSavedViewFilters({request,origin,headers,other,sql,workspaceId}){
  const scoped=sharedFixture({request,origin,headers,other,workspaceId});
  const identity=await sql`SELECT i.email,i.id,w.id AS workspace FROM login_identities i
    JOIN private_workspaces w ON w.owner_id=i.id WHERE i.email IN ('owner@example.test','other@example.test')`;
  const owner=identity.find(person=>person.email==='owner@example.test');
  const editor=identity.find(person=>person.email==='other@example.test');
  const formerMember=randomUUID();
  const mine='mine',unassigned='unassigned';
  const read=(kind,filters,auth=headers)=>request('/api/crm?'+new URLSearchParams({kind,...filters}),{headers:auth});
  const seeded=[],views=[];
  try{
    for(const kind of ['contacts','companies','deals']){
      const search='Owner filter fixture '+kind;
      const ids=Array.from({length:7},()=>randomUUID()).sort();
      const fixtures=[
        [editor.workspace,ids[0],search+' foreign',owner.id],
        [workspaceId,ids[1],search+' mine A',owner.id],
        [workspaceId,ids[2],search+' unassigned',null],
        [workspaceId,ids[3],search+' editor',editor.id],
        [workspaceId,ids[4],search+' former',formerMember],
        [workspaceId,ids[5],search+' mine B',owner.id],
        [workspaceId,ids[6],'Unrelated '+kind,owner.id],
      ];
      for(const [workspace,id,name,userId] of fixtures){
        const data={name,...(kind==='deals'?{amount:10,stage:'Appointment scheduled'}:{})};
        if(userId)data.recordOwner={userId,workspaceId:workspace,label:'Same synthetic label'};
        await sql`INSERT INTO ${sql(kind)} (workspace_id,id,revision,data,created_at,updated_at)
          VALUES (${workspace},${id},1,${sql.json(data)},now(),now())`;
        seeded.push([kind,workspace,id]);
      }
      const page=async (filters,auth)=>{
        const response=await read(kind,{search,...filters},auth);
        assert.equal(response.status,200,await response.clone().text());
        const {records,next}=await response.json();
        return {ids:records.map(row=>row.id),next};
      };
      assert.deepEqual(await page({owner:mine,limit:'1'}),{ids:[ids[1]],next:ids[1]});
      assert.deepEqual(await page({owner:mine,limit:'1',after:ids[1]}),{ids:[ids[5]],next:null});
      assert.deepEqual(await page({owner:unassigned}),{ids:[ids[2]],next:null});
      assert.deepEqual(await page({owner:mine,workspaceId},other),{ids:[ids[3]],next:null});
      assert.deepEqual(await page({owner:owner.id,limit:'1'}),{ids:[ids[1]],next:ids[1]});
      assert.deepEqual(await page({owner:owner.id,limit:'1',after:ids[1]}),{ids:[ids[5]],next:null});
      assert.deepEqual(await page({owner:editor.id}),{ids:[ids[3]],next:null});
      assert.deepEqual(await page({owner:formerMember}),{ids:[ids[4]],next:null});
      assert.equal((await read(kind,{search,owner:editor.id,workspaceId})).status,404);
      assert.equal((await read(kind,{id:ids[1],owner:mine})).status,400);
      assert.equal((await read(kind,{search,owner:'someone-else'})).status,400);

      const create=await scoped.post(viewEndpoint,{action:'create',kind,name:search,
        filters:{search,owner:mine},columns:['name','owner']});
      assert.equal(create.status,201,await create.clone().text());
      const {view}=await create.json();
      views.push(view.id);
      assert.deepEqual(view.filters,{search,owner:mine});
      const publish=await scoped.post(viewEndpoint,{action:'setSharing',kind,id:view.id,expectedRevision:view.revision,shared:true});
      assert.equal(publish.status,200,await publish.clone().text());

      const ownerPage=await request(viewPath(kind,view.id),{headers});
      const sharedPage=await scoped.open(view);
      assert.equal(ownerPage.status,200);
      assert.equal(sharedPage.status,200);
      const rowNames=async response=>Array.from((await response.text()).matchAll(/<th[^>]*scope="row"[^>]*><a[^>]*href="[^"]+"[^>]*>([^<]*)<\/a>/g),match=>match[1]);
      assert.deepEqual(await rowNames(ownerPage),[search+' mine A',search+' mine B']);
      assert.deepEqual(await rowNames(sharedPage),[search+' editor']);

      const exportResponse=await request(csvPath(kind,view.id),{headers});
      assert.equal(exportResponse.status,200,await exportResponse.clone().text());
      const csv=(await exportResponse.text()).trimEnd().split('\r\n');
      assert.deepEqual(csv,[
        '"Record ID","Name","Record owner"',
        `"${ids[1]}","${search} mine A","Same synthetic label"`,
        `"${ids[5]}","${search} mine B","Same synthetic label"`,
      ]);
      assert.equal((await request(csvPath(kind,view.id,{workspaceId}),{headers:other})).status,403);

      const fixed=await scoped.post(viewEndpoint,{action:'create',kind,name:search+' teammate',
        filters:{search,owner:editor.id},columns:['name','owner']});
      assert.equal(fixed.status,201,await fixed.clone().text());
      const {view:teammate}=await fixed.json();
      views.push(teammate.id);
      assert.deepEqual(teammate.filters,{search,owner:editor.id});
      const sharedFixed=await scoped.post(viewEndpoint,{action:'setSharing',kind,id:teammate.id,
        expectedRevision:teammate.revision,shared:true});
      assert.equal(sharedFixed.status,200,await sharedFixed.clone().text());
      const fixedPage=await request(viewPath(kind,teammate.id),{headers});
      assert.equal(fixedPage.status,200);
      const ownerSelect=(await fixedPage.clone().text()).match(/<select[^>]*name="owner"[^>]*>([\s\S]*?)<\/select>/)?.[1];
      assert.ok(ownerSelect);
      assert.match(ownerSelect,new RegExp('<option(?=[^>]*selected=)(?=[^>]*value="'+editor.id+'")'));
      assert.deepEqual(await rowNames(fixedPage),[search+' editor']);
      const sharedFixedPage=await scoped.open(teammate);
      assert.equal(sharedFixedPage.status,200);
      assert.deepEqual(await rowNames(sharedFixedPage),[search+' editor']);
      const fixedCsv=await request(csvPath(kind,teammate.id),{headers});
      assert.equal(fixedCsv.status,200);
      assert.deepEqual((await fixedCsv.text()).trimEnd().split('\r\n'),[
        '"Record ID","Name","Record owner"',
        `"${ids[3]}","${search} editor","Same synthetic label"`,
      ]);
    }
  }finally{
    await sql`DELETE FROM portable_saved_views WHERE workspace_id=${workspaceId} AND id=ANY(${views}::uuid[])`;
    for(const [kind,workspace,id] of seeded)await sql`DELETE FROM ${sql(kind)} WHERE workspace_id=${workspace} AND id=${id}`;
    await resetViewBudgets(sql);
  }
}

async function verifyOptionalSavedViewColumns({request,origin,headers,other,sql,workspaceId}){
  const scoped=sharedFixture({request,origin,headers,other,workspaceId});
  const propertyEndpoint='/api/custom-properties';
  const [owner]=await sql`SELECT id,full_name AS label FROM login_identities WHERE email='owner@example.test'`;
  assert.ok(owner.label);
  const fixtures={
    contacts:[['text','Missing',undefined,'—',''],['checkbox','Ready',false,'No','No'],
      ['multiselect','Regions',['North','South'],'North; South','North; South']],
    companies:[['text','Expression','=SUM(1,2)','=SUM(1,2)',"'=SUM(1,2)"]],
    deals:[['number','Score',0,'0','0']],
  };
  const definitionIds=[],recordIds={},views=[];
  const column=id=>'custom:'+id;
  async function property(kind,label,type,options,auth=headers){
    const response=await scoped.post(propertyEndpoint,{action:'create',kind,label,type,...(options?{options}:{})},auth);
    assert.equal(response.status,201,await response.clone().text());
    const {property}=await response.json();
    definitionIds.push(property.id);
    return property;
  }
  function table(html){
    const header=html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/)?.[1]??'';
    return {
      labels:Array.from(header.matchAll(/<th(?:\s[^>]*)?>([^<]*)<\/th>/g),match=>match[1]).filter(text=>text!=='Select'),
      cells:Array.from(html.matchAll(/<td(?:\s[^>]*)?>([^<]*)<\/td>/g),match=>match[1]),
    };
  }
  try{
    const company=await property('companies','Fixture company expression','text');
    const foreign=await property('contacts','Fixture foreign custom column','text',undefined,other);
    for(const id of [company.id,foreign.id,randomUUID()]){
      const response=await scoped.post(viewEndpoint,{action:'create',kind:'contacts',
        name:'Invalid custom column fixture',filters:{},columns:['name',column(id)]});
      assert.equal(response.status,400);
    }

    for(const [kind,fields] of Object.entries(fixtures)){
      const name='Fixture custom column '+kind;
      const properties=[];
      for(const [type,label,value] of fields){
        properties.push(kind==='companies'?company:await property(kind,'Fixture '+label,type,
          type==='multiselect'?value:undefined));
      }
      const values=Object.fromEntries(fields.flatMap((field,index)=>field[2]===undefined?[]:[[properties[index].id,field[2]]]));
      const assigned=kind!=='companies';
      const recordResponse=await scoped.post('/api/crm',{action:'save',kind,data:{name,custom:values},
        ...(assigned?{assigneeId:owner.id}:{})});
      assert.equal(recordResponse.status,201,await recordResponse.clone().text());
      const {record}=await recordResponse.json();
      recordIds[kind]=record.id;
      const columns=['name','owner',...properties.map(property=>column(property.id))];
      const filters={search:name};
      const create=await scoped.post(viewEndpoint,{action:'create',kind,name,filters,columns});
      assert.equal(create.status,201,await create.clone().text());
      const {view}=await create.json();
      views.push(view.id);
      assert.deepEqual(view.columns,columns);

      const renamed='Renamed '+properties[0].label;
      const rename=await scoped.post(propertyEndpoint,{action:'rename',kind,id:properties[0].id,
        label:renamed,expectedRevision:properties[0].revision});
      assert.equal(rename.status,200,await rename.clone().text());
      const update=await scoped.post(viewEndpoint,{action:'update',kind,id:view.id,name,filters,expectedRevision:view.revision});
      assert.equal(update.status,200,await update.clone().text());
      const {view:updated}=await update.json();
      assert.deepEqual(updated.columns,columns,'An omitted update keeps custom columns.');
      const labels=['Name','Record owner',renamed,...properties.slice(1).map(property=>property.label)];
      const expectedTable={labels,cells:[assigned?owner.label:'—',...fields.map(field=>field[3])]};
      const ownerPage=await request(viewPath(kind,view.id),{headers});
      assert.equal(ownerPage.status,200);
      assert.deepEqual(table(await ownerPage.text()),expectedTable);
      const share=await scoped.post(viewEndpoint,{action:'setSharing',kind,id:view.id,expectedRevision:updated.revision,shared:true});
      assert.equal(share.status,200,await share.clone().text());
      const sharedPage=await scoped.open(view);
      assert.equal(sharedPage.status,200);
      assert.deepEqual(table(await sharedPage.text()),expectedTable);
      assert.equal((await request(csvPath(kind,view.id),{headers:other})).status,404);
      assert.equal((await request(csvPath(kind,view.id,{workspaceId}),{headers:other})).status,403);

      const exported=await request(csvPath(kind,view.id),{headers});
      assert.equal(exported.status,200);
      const csvLine=values=>values.map(value=>'"'+value+'"').join(',');
      assert.equal(await exported.text(),[csvLine(['Record ID',...labels]),
        csvLine([record.id,name,assigned?owner.label:'',...fields.map(field=>field[4])]),''].join('\r\n'));
      const ordinary=await request('/api/crm?'+new URLSearchParams({kind,search:name,export:'csv'}),{headers});
      assert.equal(ordinary.status,200);
      const ordinaryCsv=await ordinary.text();
      assert.ok(!ordinaryCsv.includes(renamed),'Ordinary export retains its existing standard columns.');
      assert.ok(!ordinaryCsv.split('\r\n')[0].includes('"Record owner"'));
    }
  }finally{
    await sql`DELETE FROM portable_saved_views WHERE workspace_id=${workspaceId} AND id=ANY(${views}::uuid[])`;
    for(const [table,event,field] of [['contacts','contact_events','contact_id'],['companies','company_events','company_id'],['deals','deal_events','deal_id']]){
      if(!recordIds[table])continue;
      await sql`DELETE FROM ${sql(event)} WHERE workspace_id=${workspaceId} AND ${sql(field)}=${recordIds[table]}`;
      await sql`DELETE FROM ${sql(table)} WHERE workspace_id=${workspaceId} AND id=${recordIds[table]}`;
    }
    await sql`DELETE FROM portable_custom_properties WHERE id=ANY(${definitionIds}::uuid[])`;
    await resetViewBudgets(sql);
  }
}

export async function verifyRestoredSavedViews({request,origin,owner,other,workspaceId,savedViews,memberView}){
  const {updated,foreign,company,deal}=savedViews;
  for(const [auth,view] of [[owner,updated],[other,foreign],[owner,company],[owner,deal]]){
    const result=await request(viewEndpoint+'?kind='+view.kind,{headers:auth});
    assert.equal(result.status,200);
    const {views}=await result.json();
    const expected=auth===owner&&view.kind===memberView.kind?[view,memberView]:[view];
    assert.deepEqual(views.toSorted((a,b)=>a.id.localeCompare(b.id)),expected.toSorted((a,b)=>a.id.localeCompare(b.id)));
  }
  const page=await request(viewPath('companies',company.id),{headers:owner});
  assert.equal(page.status,200);
  const restoredHtml=await page.text();
  assert.match(restoredHtml,/Saved view pager 25</);
  assertViewColumns(restoredHtml,'companies');
  assert.equal((await viewCsv(request,company,owner)).length,26);
  assert.equal((await request(viewPath('companies',company.id),{headers:other})).status,404);
  const scoped=sharedFixture({request,origin,headers:owner,other,workspaceId});
  assert.deepEqual(await (await scoped.list('companies')).json(),{views:[]});
  assert.equal((await scoped.open(company)).status,404);
  assert.equal((await scoped.open(memberView)).status,404,'the saved view does not restore a membership');
  let grant=await scoped.change({action:'grant',email:'other@example.test'});
  try{
    for(const view of [updated,company,deal]){
      const {views}=await (await scoped.list(view.kind)).json();
      assert.deepEqual(views.find(row=>row.id===view.id),view);
      assert.equal(views.length,view.kind===memberView.kind?2:1);
      const sharedPage=await scoped.open(view);
      assert.equal(sharedPage.status,200);
      assertViewColumns(await sharedPage.text(),view.kind);
    }
    const memberViews=(await (await scoped.list(memberView.kind)).json()).views;
    assert.deepEqual(memberViews.find(view=>view.id===memberView.id),{...memberView,mine:true});
    const edit={action:'update',kind:memberView.kind,id:memberView.id,expectedRevision:memberView.revision,
      name:memberView.name+' restored',filters:memberView.filters,columns:memberView.columns};
    const writePath=grantId=>viewEndpoint+'?'+new URLSearchParams({workspaceId,grantId});
    assert.equal((await scoped.post(writePath(grant.id),edit,other)).status,403,'a fresh viewer grant does not permit editing');
    grant=await scoped.change({action:'role',id:grant.id,role:'editor'});
    const response=await scoped.post(writePath(grant.id),edit,other);
    assert.equal(response.status,200,await response.clone().text());
    assert.equal((await response.json()).view.revision,memberView.revision+1);
  }finally{await scoped.change({action:'revoke',id:grant.id});}
  assert.equal((await scoped.open(company)).status,404);
  assert.equal((await scoped.open(memberView)).status,404);
}

function sharedFixture({request,origin,headers,other,workspaceId}){
  function post(url,data,auth=headers){
    return request(url,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},
      body:JSON.stringify(data)});
  }
  const list=kind=>request(viewEndpoint+'?'+new URLSearchParams({kind,workspaceId}),{headers:other});
  const open=view=>request(viewPath(view.kind,view.id,workspaceId),{headers:other});
  async function change(action){
    const response=await post('/api/workspaces',action);
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).viewers.find(grant=>grant.email==='other@example.test');
  }
  return {post,list,open,change};
}

async function verifySharedSavedViewAccess({request,origin,headers,other,sql,sharing,savedViews}){
  const {workspaceId}=sharing;
  const {post,list,open,change}=sharedFixture({request,origin,headers,other,workspaceId});
  await resetViewBudgets(sql);
  const sharingInput=(view,shared)=>({action:'setSharing',kind:view.kind,id:view.id,expectedRevision:view.revision,shared});
  async function publish(view,shared){
    const response=await post(viewEndpoint,sharingInput(view,shared));
    assert.equal(response.status,200,await response.clone().text());
    const {view:updated}=await response.json();
    assert.deepEqual(updated,{...view,shared,revision:view.revision+1});
    return updated;
  }
  const current=(await (await request('/api/workspaces',{headers})).json()).viewers.find(grant=>grant.email==='other@example.test');
  assert.equal(current.role,'editor');
  const viewer=await change({action:'role',id:current.id,role:'viewer'});
  assert.deepEqual(await (await list('contacts')).json(),{views:[]});
  assert.equal((await open(savedViews.updated)).status,404);

  const contact=await publish(savedViews.updated,true);
  const company=await publish(savedViews.company,true);
  const deal=await publish(savedViews.deal,true);
  assert.equal((await post(viewEndpoint,sharingInput(savedViews.updated,false))).status,409);
  assert.equal((await post(viewEndpoint,sharingInput(contact,false),other)).status,404);
  assert.equal((await post(viewEndpoint+'?workspaceId='+workspaceId,sharingInput(contact,false),other)).status,400);
  assert.equal((await request(viewPath('contacts',contact.id),{headers:other})).status,404);
  assert.equal((await open(savedViews.foreign)).status,404);
  const duplicate=await request(viewEndpoint+'?kind=contacts&workspaceId='+workspaceId+'&workspaceId='+randomUUID(),{headers:other});
  assert.equal(duplicate.status,400);
  for(const view of [contact,company,deal]){
    const response=await list(view.kind);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{views:[view]});
    const page=await open(view);
    assert.equal(page.status,200);
    const html=await page.text();
    assert.match(html,/aria-label="Shared saved views"/);
    assertViewColumns(html,view.kind);
    assert.equal((await request(csvPath(view.kind,view.id),{headers:other})).status,404);
    assert.doesNotMatch(html,/>Manage saved views<|>Share with workspace<|>Make private</);
  }
  const owner=await request(viewPath(contact.kind,contact.id),{headers});
  assert.match(await owner.text(),/>Make private</);

  const first=await (await open(company)).text();
  assert.match(first,/Saved view pager 25</);
  assert.doesNotMatch(first,/Saved view pager 26</);
  const nextPath=first.match(/href="([^"]+)"[^>]*>Next page<\/a>/)?.[1]?.replaceAll('&amp;','&');
  const next=new URL(nextPath,origin);
  assert.equal(next.searchParams.get('workspaceId'),workspaceId);
  assert.equal(next.searchParams.get('savedView'),company.id);
  const second=await request(next.pathname+next.search,{headers:other});
  assert.equal(second.status,200);
  const secondHtml=await second.text();
  assert.match(secondHtml,/Saved view pager 26</);
  assert.doesNotMatch(secondHtml,/Saved view pager 25<|Owner Company/);

  const editor=await change({action:'role',id:viewer.id,role:'editor'});
  const editorPage=await open(contact);
  assert.equal(editorPage.status,200);
  const editorHtml=await editorPage.text();
  assert.match(editorHtml,/Owner edit [AB]/);
  assertViewColumns(editorHtml,'contacts');
  assert.match(editorHtml,/>Add contact</);
  // Editors can save their own shared views, but sharing controls stay with the owner.
  assert.match(editorHtml,/>Manage saved views</);
  assert.doesNotMatch(editorHtml,/Other only|>Share with workspace<|>Make private</);
  assert.equal((await post(viewEndpoint,sharingInput(contact,false),other)).status,404);

  const madePrivate=await publish(contact,false);
  assert.equal((await open(madePrivate)).status,404);
  assert.deepEqual(await (await list('contacts')).json(),{views:[]});
  assert.equal((await request(viewPath(contact.kind,contact.id),{headers})).status,200);
  const updated=await publish(madePrivate,true);
  assert.equal((await open(updated)).status,200);
  await change({action:'revoke',id:editor.id});
  assert.equal((await open(updated)).status,404);
  assert.deepEqual(await (await list('contacts')).json(),{views:[]});

  let regranted=await change({action:'grant',email:'other@example.test'});
  assert.notEqual(regranted.id,editor.id);
  assert.equal((await open(updated)).status,200);
  regranted=await change({action:'role',id:regranted.id,role:current.role});
  for(const [flag,action] of [['contactFiles','contact_files'],['scheduledNotes','scheduled_notes'],['contactOutreach','contact_outreach']]){
    if(current[flag])regranted=await change({action,id:regranted.id,enabled:true});
  }
  sharing.grantId=regranted.id;
  await resetViewBudgets(sql);
  return {updated,foreign:savedViews.foreign,company,deal};
}

// Shared editors save views in the owner's workspace; they stay shared and attributed.
export async function verifyPortableMemberSavedViews({request,origin,headers,other,sql,sharing}){
  const {workspaceId,grantId}=sharing,endpoint='/api/crm/views';
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const write=(body,auth=headers,scope)=>request(endpoint+(scope?'?'+new URLSearchParams(scope):''),{method:'POST',
    headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const list=async(auth,shared)=>(await (await request(endpoint+'?'+new URLSearchParams({kind:'contacts',...(shared?{workspaceId}:{})}),{headers:auth})).json()).views;
  const marker='Member view '+randomUUID().slice(0,8);
  const scope={workspaceId,grantId};
  assert.equal((await write({action:'create',kind:'contacts',name:marker,filters:{search:marker}},other,{workspaceId,grantId:randomUUID()})).status,403);
  const created=await write({action:'create',kind:'contacts',name:marker,filters:{search:marker}},other,scope);
  assert.equal(created.status,201,await created.clone().text());
  const {view}=await created.json();
  assert.equal(view.shared,true);
  const [{author_id:authorId}]=await sql`SELECT author_id FROM portable_saved_views WHERE id=${view.id}`;
  const [{id:memberId}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  assert.equal(authorId,memberId);

  const ownerView=(await list(headers)).find(row=>row.id===view.id);
  assert.ok(ownerView?.author,'the owner sees who created the view');
  const [{full_name:fullName}]=await sql`SELECT full_name FROM login_identities WHERE id=${memberId}`;
  await sql`UPDATE login_identities SET full_name=' ' WHERE id=${memberId}`;
  try{
    assert.equal((await list(headers)).find(row=>row.id===view.id)?.author,'Workspace member',
      'a missing display name must not expose the author’s sign-in address');
  }finally{await sql`UPDATE login_identities SET full_name=${fullName} WHERE id=${memberId}`;}

  const memberViews=await list(other,true);
  assert.equal(memberViews.find(row=>row.id===view.id)?.mine,true);
  const ownerShared=await write({action:'create',kind:'contacts',name:marker+' owner',filters:{}});
  const owned=(await ownerShared.json()).view;
  await write({action:'setSharing',kind:'contacts',id:owned.id,expectedRevision:owned.revision,shared:true});
  assert.equal((await list(other,true)).find(row=>row.id===owned.id)?.mine,undefined);

  // Editors change only their own views and never sharing; the owner can't make an editor's view private.
  const renamed=await write({action:'update',kind:'contacts',id:view.id,expectedRevision:1,name:marker+' renamed',filters:{search:marker}},other,scope);
  assert.equal(renamed.status,200,await renamed.clone().text());
  assert.equal((await write({action:'update',kind:'contacts',id:owned.id,expectedRevision:2,name:'Taken over',filters:{}},other,scope)).status,403);
  assert.equal((await write({action:'setSharing',kind:'contacts',id:view.id,expectedRevision:2,shared:false},other,scope)).status,403);
  assert.equal((await write({action:'setSharing',kind:'contacts',id:view.id,expectedRevision:2,shared:false})).status,403);
  assert.equal((await write({action:'create',kind:'contacts',name:marker+' renamed',filters:{}},other,scope)).status,409,'names stay unique per workspace');
  const [{contact_outreach:outreach}]=await sql`SELECT contact_outreach FROM portable_workspace_viewers WHERE id=${grantId}`;
  await sql`UPDATE portable_workspace_viewers SET contact_outreach=false WHERE id=${grantId}`;
  try{
    assert.equal((await write({action:'create',kind:'contacts',name:marker+' outreach',filters:{sort:'outreach-newest'}},other,scope)).status,403,
      'ordering by Last contacted needs the outreach permission');
  }finally{await sql`UPDATE portable_workspace_viewers SET contact_outreach=${outreach} WHERE id=${grantId}`;}
  const page=await (await request('/?'+new URLSearchParams({workspaceId}),{headers:other})).text();
  assert.match(page,/Manage saved views/);
  const removable=await write({action:'create',kind:'contacts',name:marker+' delete',filters:{}},other,scope);
  assert.equal(removable.status,201);
  const removed=(await removable.json()).view;
  assert.equal((await write({action:'delete',kind:'contacts',id:removed.id,expectedRevision:1},other,scope)).status,200);
  const retained=(await list(headers)).find(row=>row.id===view.id);
  assert.equal(retained.revision,2);
  assert.equal((await write({action:'delete',kind:'contacts',id:owned.id,expectedRevision:2})).status,200);
  return retained;
}
