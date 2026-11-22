import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifySharedLists({request,origin,headers,other,sql}){
  const post=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  async function ok(call){
    const r=await call;
    assert.ok(r.ok,await r.clone().text());
    return r.json();
  }
  const manage=body=>ok(post('/api/workspaces',body));
  let directory=await ok(request('/api/workspaces',{headers}));
  const member=()=>directory.viewers.find(p=>p.email==='other@example.test');
  if(!member())directory=await manage({action:'grant',email:'other@example.test'});
  if(member().role!=='editor')directory=await manage({action:'role',id:member().id,role:'editor'});
  const workspaceId=directory.owned,team=randomUUID();
  directory=await manage({action:'team_create',id:team,name:'List reviewers',parentId:null});
  directory=await manage({action:'team_assign',id:member().id,teamId:team,previousTeamId:member().teamId??null});
  directory=await manage({action:'record_scope',id:member().id,viewScope:'team',editScope:'team'});
  const teammate=randomUUID();
  await sql`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
    VALUES (${teammate},${teammate},'list-partner@example.test',${Date.now()},${Date.now()})`;
  await sql`INSERT INTO portable_workspace_viewers(workspace_id,id,viewer_id,team_id,role)
    VALUES (${workspaceId},${randomUUID()},${teammate},${team},'editor')`;
  const [{owner_id:owner}]=await sql`SELECT owner_id FROM private_workspaces WHERE id=${workspaceId}`;
  const marker='Tamarack list trial';
  async function contact(name,assigneeId){
    return (await ok(post('/api/crm',{action:'save',kind:'contacts',data:{name:marker+' '+name},assigneeId}))).record;
  }
  const permitted=await contact('teammate',teammate);
  await contact('outside',owner);await contact('unassigned',null);
  async function list(mode,name){
    return (await ok(post('/api/segments',{action:'save',segment:{id:randomUUID(),revision:0,kind:'contacts',mode,name,
      criteria:{groups:[[{field:'name',operator:'contains',value:marker}]]},...(mode==='static'?{initialMembers:'snapshot'}:{})}}))).segment;
  }
  const active=await list('active','Team pilot list'),privateList=await list('active','Private pilot list'),fixed=await list('static','Static pilot list');
  const api=id=>'/api/segments?'+new URLSearchParams({id,workspaceId});
  const get=(path,auth=other)=>request(path,{headers:auth});
  const share=(list,shared)=>post('/api/segments',{action:'share',id:list.id,revision:list.revision,shared});
  assert.equal((await get(api(active.id))).status,404);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  const open=async(auth,width)=>{
    const ctx=await browser.newContext({viewport:{width,height:844}});
    const [name,value]=auth.cookie.split('=');await ctx.addCookies([{name,value,url:origin}]);
    const p=await ctx.newPage();p.setDefaultTimeout(8000);return p;
  };
  try{
    const desktop=await open(headers,1440),mobile=await open(other,390);
    await desktop.goto(origin+'/?view=segments&segment='+active.id);
    await desktop.getByRole('heading',{name:'Members · 3'}).waitFor();
    await desktop.getByRole('button',{name:'Share list with workspace'}).click();
    const address=await desktop.getByLabel('Teammate link').inputValue();
    assert.equal(new URL(address).searchParams.get('workspaceId'),workspaceId);
    await mobile.goto(origin+'/?workspaceId='+workspaceId);
    await mobile.getByRole('button',{name:'Open navigation'}).click();
    await mobile.getByRole('button',{name:'CRM',exact:true}).click();
    await mobile.getByRole('link',{name:'Lists',exact:true}).click();
    const library=mobile.getByRole('table',{name:'Saved lists'});
    assert.equal(await library.getByRole('link',{name:privateList.name}).count(),0);
    await library.getByRole('link',{name:active.name}).click();
    await mobile.getByText('Contacts you can view · 1').waitFor();
    assert.equal(await mobile.getByRole('table',{name:'List members'}).getByRole('link').count(),1);
    await mobile.getByRole('link',{name:permitted.data.name}).click();
    assert.equal(new URL(mobile.url()).searchParams.get('workspaceId'),workspaceId);
    await mobile.getByRole('heading',{name:permitted.data.name,exact:true}).first().waitFor();
    await mobile.goto(address);
    await mobile.getByLabel('Search members').fill('outside');
    await mobile.getByRole('button',{name:'Search members'}).click();
    await mobile.getByText('Matching contacts · 0').waitFor();
    const visible=await ok(get(api(active.id)));
    assert.equal(visible.total,'1');assert.deepEqual(visible.items.map(x=>x.id),[permitted.id]);
    assert.equal('criteria' in visible.segment,false);
    assert.equal((await get(api(privateList.id))).status,404);
    assert.equal((await mobile.goto(address.replace(active.id,privateList.id))).status(),404);
    assert.equal((await post('/api/segments?workspaceId='+workspaceId,{action:'share',id:active.id,revision:active.revision,shared:false},other)).status,403);
    await ok(share(fixed,true));
    assert.deepEqual((await ok(get(api(fixed.id)))).items.map(x=>x.id),[permitted.id]);
    assert.equal((await get(api(fixed.id)+'&candidates=true')).status,404);
    await desktop.getByRole('button',{name:'Stop sharing list'}).click();
    await desktop.getByRole('button',{name:'Share list with workspace'}).waitFor();
    assert.equal((await mobile.goto(address)).status(),404);
    const unchanged=await ok(get('/api/segments?id='+active.id,headers));
    assert.equal(unchanged.total,'3');assert.equal(unchanged.segment.revision,active.revision);
    await manage({action:'revoke',id:member().id});
    assert.equal((await get(api(fixed.id))).status,404);
  }finally{await browser.close();}
}
