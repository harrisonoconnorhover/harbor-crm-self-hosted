import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const path='/api/segments';
const fragment='20%_\\';
const ownerEmail='owner@example.test';
const otherEmail='other@example.test';

export async function verifyPortableSegments({request,origin,headers,other,sql,workspaceId}){
  const resetBudgets=()=>sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN (${ownerEmail},${otherEmail}))`;
  await resetBudgets();
  const get=(query='',auth=headers)=>request(path+query,{headers:auth});
  const write=(endpoint,data,auth=headers,source=origin)=>request(endpoint,{method:'POST',
    headers:{...auth,origin:source,'content-type':'application/json'},body:JSON.stringify(data)});
  const save=(segment,auth,endpoint=path,source=origin)=>write(endpoint,{action:'save',segment},auth,source);
  async function contact(data,auth=headers){
    const response=await write('/api/crm',{action:'save',kind:'contacts',...data},auth);
    assert.equal(response.status,data.id?200:201,await response.clone().text());
    return (await response.json()).record;
  }
  const first=await contact({data:{name:'Segment '+fragment+' Alpha',email:'Alpha@Example.Test',lifecycle:'Evangelist'}});
  const second=await contact({data:{name:'Segment '+fragment+' Beta',email:'beta@example.test',lifecycle:'Evangelist'}});
  await contact({data:{name:'Segment 20 anything Beta',email:'wildcard@example.test',lifecycle:'Evangelist'}});
  await contact({data:{name:'Segment '+fragment+' Wrong stage',email:'stage@example.test',lifecycle:'Other'}});
  await contact({data:{name:'Segment '+fragment+' Wrong email',email:'mail@elsewhere.test',lifecycle:'Evangelist'}});
  await contact({data:{name:'Segment '+fragment+' Foreign',email:'foreign@example.test',lifecycle:'Evangelist'}},other);

  const criteria={groups:[[
    {field:'lifecycle',operator:'eq',value:'Evangelist'},
    {field:'name',operator:'contains',value:'  segment '+fragment+' '},
    {field:'email',operator:'contains',value:'@EXAMPLE.TEST'},
  ]]};
  const draft={id:randomUUID(),revision:0,name:'Fictional segment '+fragment,kind:'contacts',mode:'active',criteria};
  assert.equal((await get('',{})).status,401);
  assert.equal((await get('?limit=51')).status,400);
  assert.equal((await get('?kind=deals')).status,400);
  assert.equal((await get('?id='+draft.id+'&id='+randomUUID())).status,400);
  assert.equal((await save(draft,headers,path,'https://elsewhere.example.test')).status,403);
  for(const invalid of [
    {...draft,mode:'unsupported'},
    {...draft,criteria:{groups:[criteria.groups[0],criteria.groups[0]]}},
    {...draft,criteria:{groups:[[{field:'lifecycle',operator:'neq',value:'Lead'}]]}},
  ])assert.equal((await save(invalid)).status,400);
  const created=await save(draft);
  assert.equal(created.status,201,await created.clone().text());
  const {segment}=await created.json();
  assert.equal(segment.revision,1);
  assert.deepEqual(segment.criteria.groups[0][1],{field:'name',operator:'contains',value:'segment '+fragment,valueTo:''});
  assert.equal((await save(draft)).status,409);
  const byId='?id='+segment.id;
  assert.equal((await get(byId,other)).status,404);
  assert.equal((await get(byId+'&workspaceId='+workspaceId,other)).status,400);
  assert.equal((await save({...draft,revision:1},other,path+'?workspaceId='+workspaceId)).status,403);
  assert.deepEqual(await (await get('',other)).json(),{segments:[],next:null});
  const page1=await (await get(byId+'&limit=1')).json();
  const page2=await (await get(byId+'&limit=1&after='+page1.next)).json();
  assert.equal(page1.items.length,1);
  assert.equal(page1.next,page1.items[0].id);
  assert.equal(page2.items.length,1);
  assert.equal(page2.next,null);
  assert.deepEqual([page1.total,page2.total],['2','2']);
  assert.deepEqual(new Set([page1.items[0].id,page2.items[0].id]),new Set([first.id,second.id]));
  const page=await request('/?view=segments&segment='+segment.id,{headers});
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/<h2 id="portable-segment-members">Members · 2<\/h2>/);
  assert.ok(html.includes('/?contact='+first.id));
  assert.equal((await request('/?view=segments&segment='+segment.id,{headers:other})).status,404);
  const detail='/?view=segments&segment='+segment.id+'&q=Fictional';
  const search=detail+'&memberQ=+BETA%40example.test+';
  const searched=await request(search,{headers});
  assert.equal(searched.status,200);
  const matches=await searched.text();
  assert.match(matches,/<h2 id="portable-segment-members">Matching members · 1<\/h2>/);
  assert.match(matches,/Find segment members/);
  assert.ok(matches.includes('/?contact='+second.id));
  assert.ok(!matches.includes('/?contact='+first.id));
  assert.ok(matches.includes(detail.replaceAll('&','&amp;')+'">Clear member search</a>'));
  assert.equal((await request(search,{headers:other})).status,404);
  assert.equal((await request(detail+'&memberQ=%00',{headers})).status,404);
  assert.equal((await request('/?view=segments&memberQ=Beta',{headers})).status,404);
  const pagedSearch=detail+'&'+new URLSearchParams({memberQ:fragment});
  const filteredPage=await request(pagedSearch+'&after='+page1.next,{headers});
  assert.equal(filteredPage.status,200);
  const filteredHtml=await filteredPage.text();
  assert.match(filteredHtml,/<h2 id="portable-segment-members">Matching members · 2<\/h2>/);
  assert.ok(filteredHtml.includes('/?contact='+page2.items[0].id));
  assert.ok(!filteredHtml.includes('/?contact='+page1.items[0].id));
  assert.ok(filteredHtml.includes(pagedSearch.replaceAll('&','&amp;')+'">First members</a>'));

  const edit={...draft,revision:1,name:'Fictional updated '+fragment,description:'A dynamic list for the fixture.'};
  assert.equal((await save(edit,other)).status,404);
  const races=await Promise.all([save(edit),save(edit)]);
  assert.deepEqual(races.map(response=>response.status).sort(),[200,409]);
  const {segment:saved}=await races.find(response=>response.status===200).json();
  assert.equal(saved.revision,2);
  await contact({id:first.id,expectedRevision:first.revision,data:{...first.data,lifecycle:'Other'}});
  const current=await (await get(byId)).json();
  assert.equal(current.segment.revision,2);
  assert.equal(current.total,'1');
  assert.deepEqual(current.items.map(row=>row.id),[second.id]);

  const all=await save({...draft,id:randomUUID(),name:'All fixture contacts',criteria:{groups:[]}});
  assert.equal(all.status,201);
  const {segment:temporary}=await all.json();
  const [expected]=await sql`SELECT count(*)::text AS total,(count(*) FILTER (WHERE archived_at IS NULL))::text AS active
    FROM contacts WHERE workspace_id=${workspaceId}`;
  assert.equal((await (await get('?id='+temporary.id+'&limit=1')).json()).total,expected.active);
  const list1=await (await get('?limit=1')).json();
  assert.equal(list1.next,list1.segments[0].id);
  const list2=await (await get('?limit=1&after='+list1.next)).json();
  assert.equal(list2.next,null);
  assert.notEqual(list1.segments[0].id,list2.segments[0].id);
  const filtered=await (await get('?q='+encodeURIComponent(fragment))).json();
  assert.deepEqual(filtered.segments.map(item=>item.id),[saved.id]);
  const remove={action:'delete',id:temporary.id,revision:1};
  assert.equal((await write(path,{...remove,revision:2})).status,409);
  assert.equal((await write(path,remove)).status,200);
  assert.equal((await get('?id='+temporary.id)).status,404);
  assert.equal((await sql`SELECT count(*)::text AS total FROM contacts WHERE workspace_id=${workspaceId}`)[0].total,expected.total);
  await resetBudgets();
  return current;
}

export async function verifyRestoredPortableSegment({request,owner,other,segment}){
  const url=path+'?id='+segment.segment.id;
  assert.deepEqual(await (await request(url,{headers:owner})).json(),segment);
  assert.equal((await request(url,{headers:other})).status,404);
  const rendered=await request('/?view=segments&segment='+segment.segment.id,{headers:owner});
  assert.equal(rendered.status,200);
  assert.match(await rendered.text(),/<h2 id="portable-segment-members">Members · 1<\/h2>/);
}
