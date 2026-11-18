import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifySharedDashboard} from './portable-shared-dashboards-fixture.mjs';

const api='/api/reporting';
const listPath=api+'?view=dashboards';
const detailPath=id=>api+'?view=dashboard&id='+id;
const screen=id=>'/?view=dashboards'+(id?'&dashboardId='+id:'');
const post=(request,headers,origin,body,path=api)=>request(path,{method:'POST',
  headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});

async function verifyDashboardCatalog({request,origin,headers,other,sql,workspaceId,reportId}){
  const ids=Array.from({length:28},()=>randomUUID()).sort();
  const title='Fictional ÉLAN %_ dashboard';
  const foreignSave=await post(request,other,origin,{action:'dashboard',definition:{name:title,cards:[]}});
  assert.equal(foreignSave.status,201);
  const {item:foreign}=await foreignSave.json();
  const search=new URLSearchParams({search:'élan %_'}).toString();
  const read=(path,auth=headers)=>request(path,{headers:auth});
  try{
    const rows=ids.map((id,index)=>({id,workspace_id:workspaceId,revision:1,updated_at:new Date().toISOString(),
      definition:sql.json({name:['Unrelated dashboard','Fictional ÉLAN XA dashboard'][index]??`${title} ${index}`,
        cards:id===ids.at(-1)?[{reportId,wide:false}]:[]})}));
    await sql`INSERT INTO portable_dashboards ${sql(rows)}`;
    const first=await read(listPath+'&'+search);
    assert.equal(first.status,200);
    const {items,next}=await first.json();
    assert.deepEqual(items.map(item=>item.id),ids.slice(2,-1));
    assert.equal(next,ids.at(-2));
    const last=await (await read(listPath+'&after='+next+'&'+search)).json();
    assert.deepEqual(last.items.map(item=>item.id),ids.slice(-1));
    assert.equal(last.next,null);
    assert.deepEqual(await (await read(listPath+'&'+search,other)).json(),{items:[foreign],next:null});
    assert.deepEqual(await (await read(listPath+'&limit=1&search=+++')).json(),await (await read(listPath+'&limit=1')).json());
    for(const query of ['search=%00','search='+('a'.repeat(121)),search+'&search=twice']){
      assert.equal((await read(listPath+'&'+query)).status,400);
    }
    assert.equal((await read(detailPath(ids.at(-1))+'&'+search)).status,400);
    const nextPage=screen()+'&after='+next+'&'+search;
    const listHtml=(await (await read(screen()+'&'+search)).text()).replaceAll('&amp;','&');
    assert.match(listHtml,/name="search"[^>]*value="élan %_"/);
    assert.ok(listHtml.includes(`href="${nextPage}">Next dashboards`));
    const bookmark=screen(ids.at(-1))+'&after='+next+'&'+search;
    const nextHtml=(await (await read(nextPage)).text()).replaceAll('&amp;','&');
    assert.ok(nextHtml.includes(`href="${screen()}&${search}">First dashboards`));
    assert.ok(nextHtml.includes(`href="${bookmark}"`));
    const page=await read(bookmark);
    assert.equal(page.status,200);
    assert.ok((await page.text()).replaceAll('&amp;','&').includes(`href="${nextPage}" aria-current="page">Dashboards`));
    const redirect=await request(bookmark,{headers:{},redirect:'manual'});
    assert.equal(redirect.status,307);
    assert.equal(new URL(redirect.headers.get('location'),origin).searchParams.get('return_to'),bookmark);
    const unmatched=await read(screen(ids.at(-1))+'&search=unmatched');
    assert.equal(unmatched.status,200);
    const unmatchedHtml=await unmatched.text();
    assert.match(unmatchedHtml,/No matching dashboards on this page\./);
    assert.ok(unmatchedHtml.includes('reportId='+reportId));
  }finally{
    await sql`DELETE FROM portable_dashboards WHERE id IN ${sql([...ids,foreign.id])}`;
  }
}

export async function verifyPortableDashboards({request,origin,headers,other,reports,sql,workspaceId}){
  const read=(path,auth=headers)=>request(path,{headers:auth});
  const save=(definition,auth=headers,options={})=>post(request,auth,options.origin??origin,
    {action:'dashboard',definition,...(options.update??{})},options.path);
  const card=(reportId,wide=false)=>({reportId,wide});
  const name='Fictional sales dashboard';
  const main=reports.saved.id;
  const due=reports.dueReport.id;
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write') AND subject IN
    (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const addReport=async (label,auth=headers)=>{
    const response=await post(request,auth,origin,{action:'report',definition:{name:label,kind:'contacts'}});
    assert.equal(response.status,201);
    return (await response.json()).item;
  };

  assert.equal((await read(listPath,{})).status,401);
  assert.equal((await read(listPath+'&limit=51')).status,400);
  assert.equal((await read(listPath+'&limit=1&limit=2')).status,400);
  assert.equal((await read(detailPath(main)+'&workspaceId='+workspaceId)).status,404);
  assert.match(await (await read('/')).text(),/href="\/\?view=dashboards"/);
  assert.match(await (await read(screen())).text(),/Build a dashboard/);
  const temporary=await addReport('Fictional removable report');
  const foreign=await addReport('Foreign report title',other);
  for(const unavailable of [foreign.id,randomUUID()]){
    const denied=await save({name,cards:[card(unavailable)]});
    assert.equal(denied.status,404);
    assert.equal((await denied.json()).error,'One or more saved reports are unavailable in this workspace.');
  }
  assert.equal((await save({name,cards:[card(main),card(main.toUpperCase())]})).status,400);
  assert.equal((await save({name,cards:Array.from({length:21},()=>card(randomUUID()))})).status,400);
  assert.equal((await save({name,cards:[card(main)]},headers,{origin:'https://elsewhere.example.test'})).status,403);
  assert.equal((await save({name,cards:[card(main)]},other,{path:api+'?workspaceId='+workspaceId})).status,403);

  const created=await save({name,cards:[card(main),card(temporary.id,true),card(due)]});
  assert.equal(created.status,201);
  assert.equal(created.headers.get('cache-control'),'private, no-store');
  const {item}=await created.json();
  assert.equal(item.revision,1);
  const target=detailPath(item.id);
  const original=await (await read(target)).json();
  assert.deepEqual(original.item,item);
  assert.deepEqual(original.cards.map(({reportId,missing,wide})=>[reportId,missing,wide]),
    [[main,false,false],[temporary.id,false,true],[due,false,false]]);
  assert.deepEqual(original.cards[0].result,reports.savedResult);
  assert.deepEqual(original.cards[0].definition.filter,reports.saved.definition.filter);
  assert.equal(original.cards[0].definition.dealStageId,'Closed won');
  assert.deepEqual(original.cards[2].result,reports.dueResult);
  assert.equal((await read(target,other)).status,404);
  assert.equal((await read(screen(item.id),other)).status,404);
  assert.deepEqual(await (await read(listPath,other)).json(),{items:[],next:null});
  const blockedEdit=await save({name,cards:[]},other,{update:{id:item.id,revision:1}});
  assert.equal(blockedEdit.status,404);

  const revised={cards:[card(temporary.id),card(main,true),card(due)]};
  const concurrent=await Promise.all(['A','B'].map(suffix=>save({...revised,name:name+' '+suffix},headers,{update:{id:item.id,revision:1}})));
  assert.deepEqual(concurrent.map(response=>response.status).sort(),[200,409]);
  const {item:current}=await concurrent.find(response=>response.ok).json();
  assert.equal(current.revision,2);
  assert.deepEqual(current.definition.cards,revised.cards);
  const page=await read(screen(item.id));
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Fictional removable report results[\s\S]+Fictional saved amount results/);
  assert.match(html,/Close date from 2043-01-02 through 2043-01-05/);
  assert.match(html,/Create date from 2042-12-30 through 2042-12-31 \(UTC\)/);
  assert.match(html.replaceAll('<!-- -->',''),/Deal pipeline is Sales pipeline/);
  assert.match(html.replaceAll('<!-- -->',''),/Deal stage is Closed won/);
  assert.match(html,/Due date from 2051-04-10 through 2051-04-12/);
  assert.ok(html.replaceAll('<!-- -->','').includes('Assignee is '+reports.dueAssigneeLabel));

  assert.equal((await post(request,headers,origin,{action:'deleteReport',id:temporary.id,revision:1})).status,200);
  const missing=await (await read(target)).json();
  assert.deepEqual(missing.cards[0],{...revised.cards[0],missing:true});
  assert.deepEqual(missing.cards[1].result,reports.savedResult);
  const unavailablePage=await read(screen(item.id));
  assert.match(await unavailablePage.text(),/Report unavailable/);
  const retained=await save(current.definition,headers,{update:{id:item.id,revision:2}});
  assert.equal(retained.status,200);
  assert.equal((await retained.json()).item.revision,3);
  assert.equal((await save({name,cards:[card(temporary.id)]})).status,404);

  const disposable=await save({name:'Fictional empty dashboard',cards:[]});
  assert.equal(disposable.status,201);
  const {item:unused}=await disposable.json();
  const first=await (await read(listPath+'&limit=1')).json();
  assert.equal(first.items.length,1);
  assert.equal(first.next,first.items[0].id);
  const second=await (await read(listPath+'&limit=1&after='+first.next)).json();
  assert.equal(second.items.length,1);
  assert.equal(second.next,null);
  assert.notEqual(second.items[0].id,first.items[0].id);
  const remove={action:'deleteDashboard',id:unused.id,revision:1};
  assert.equal((await post(request,headers,origin,{...remove,revision:2})).status,409);
  assert.equal((await post(request,other,origin,remove)).status,404);
  assert.equal((await post(request,headers,origin,remove)).status,200);
  assert.equal((await read(detailPath(unused.id))).status,404);
  await verifyDashboardCatalog({request,origin,headers,other,sql,workspaceId,reportId:main});
  await verifySharedDashboard({request,origin,headers,other,sql,workspaceId,unattachedReportId:main});
  return {id:item.id,detail:await (await read(target)).json()};
}

export async function verifyRestoredPortableDashboard({request,owner,other,dashboard}){
  const restored=await request(detailPath(dashboard.id),{headers:owner});
  assert.equal(restored.status,200);
  assert.deepEqual(await restored.json(),dashboard.detail);
  assert.equal((await request(detailPath(dashboard.id),{headers:other})).status,404);
  const page=await request(screen(dashboard.id),{headers:owner});
  assert.equal(page.status,200);
  const html=(await page.text()).replaceAll('<!-- -->','');
  assert.match(html,/Report unavailable[\s\S]+Fictional saved amount results/);
  assert.match(html,/Deal pipeline is Sales pipeline/);
  assert.match(html,/Deal stage is Closed won/);
  assert.match(html,/Due date from 2051-04-10 through 2051-04-12/);
}
