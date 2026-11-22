import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {verifyCustomObjectImport} from './portable-custom-object-import-fixture.mjs';
import {verifyCustomLinks} from './portable-custom-links-fixture.mjs';
import {randomUUID as uuid} from 'node:crypto';

export async function verifyCustomObjects({request,origin,headers,other,sql}){
  const api='/api/custom-objects',team='/api/workspaces',id=uuid(),objectId=uuid();
  const get=(path,auth=headers)=>request(path,{headers:auth});
  const send=(path,data,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  const ok=async promise=>{const r=await promise;assert.ok(r.ok,await r.clone().text());return r.json();};
  const change=data=>ok(send(team,data));
  const field=(label,type,required=false,options=[])=>({id:uuid(),label,type,options,required});
  const [renewal,amount,plan,paid]=[field('Renewal date','date',true),field('Monthly amount','number'),field('Plan','select',false,['Standard','Plus']),field('Paid','checkbox')];
  paid.id=paid.id.toUpperCase(); // Custom field IDs are stored as JSON keys and keep their original case.
  const definition={name:'Subscriptions',fields:[renewal,amount,plan,paid]};
  const define={action:'define',id:objectId,revision:0,definition};
  assert.equal((await send(api,define,{})).status,401);
  await ok(send(api,define));
  assert.equal((await send(api,{...define,id:uuid(),definition:{...definition,name:'subscriptions'}})).status,409);
  const workspace=(await ok(get(team))).owned;
  const [{id:repId}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const save={action:'save',id,objectId,revision:0,schemaRevision:1,name:'Fictional annual contract',assigneeId:repId,
    values:{[renewal.id]:'2027-01-12',[amount.id]:220,[plan.id]:'Plus',[paid.id]:false}};
  const createCore=(kind,name,assigneeId)=>ok(send('/api/crm',{action:'save',kind,data:{name},assigneeId})).then(r=>r.record.id);
  const company=await createCore('companies','Fictional subscriber'),contact=await createCore('contacts','Fictional contact');
  let grant=(await change({action:'grant',email:'other@example.test'})).viewers[0];
  const query=(p,shared=false)=>api+'?'+new URLSearchParams({...p,...(shared?{workspaceId:workspace}:{})});
  const repWrite=data=>send(api+'?'+new URLSearchParams({workspaceId:workspace,grantId:grant.id}),data,other);
  const globalSearch=(input,shared=false)=>send('/api/crm/search'+(shared?'?workspaceId='+workspace:''),input,shared?other:headers);
  const detail={objectId,record:id};
  assert.equal((await repWrite(save)).status,403);
  grant=(await change({action:'role',id:grant.id,role:'editor'})).viewers[0];
  const customPolicy=async edit=>(await change({action:'tool_permissions',ids:[grant.id],tool:'custom-objects',
    policy:{view:'all',edit,create:true,delete:edit!=='none'}})).viewers[0];
  grant=await customPolicy('none');
  const declined=await send(api,save);
  assert.equal(declined.status,400);
  assert.match((await declined.json()).error,/record owner/);
  grant=await customPolicy('all');
  assert.equal((await send(api,{...save,values:{}})).status,400);
  assert.equal((await send(api,{...save,values:{...save.values,[amount.id]:'many'}})).status,400);
  assert.equal((await send(api,{...save,values:{...save.values,[renewal.id]:'2027-02-30'}})).status,400);
  await ok(send(api,save));
  grant=(await change({action:'role',id:grant.id,role:'viewer'})).viewers[0];
  const saved=await ok(get(query(detail)));
  assert.deepEqual(saved.record.data.values,save.values);
  assert.equal((await ok(get(query(detail,true),other))).record.editable,false);
  assert.equal((await get(query(detail),other)).status,404);
  const viewerReads=async()=>Number((await sql`SELECT count(*) AS count FROM portable_record_access_events
    WHERE workspace_id=${workspace} AND actor_id=${repId} AND custom_object_id=${objectId}`)[0].count);
  const viewerBaseline=await viewerReads();
  const editorPath='/?'+new URLSearchParams({view:'custom-objects',workspaceId:workspace,objectId,record:id,mode:'edit'});
  assert.equal((await get(editorPath,other)).status,404);
  assert.equal(await viewerReads(),viewerBaseline);
  const addLink=(kind,target,revision)=>({action:'link',id,objectId,revision,kind,target});
  await ok(send(api,addLink('companies',company,1)));
  await ok(send(api,addLink('contacts',contact,2)));
  const duplicate=await ok(send(api,addLink('companies',company,3)));assert.equal(duplicate.revision,3);
  assert.equal((await send(api,addLink('deals',company,3))).status,404);
  assert.equal((await ok(get(query({kind:'companies',target:company},true),other))).items[0].recordId,id);
  grant=(await change({action:'role',id:grant.id,role:'editor'})).viewers[0];
  grant=(await change({action:'record_scope',id:grant.id,viewScope:'all',editScope:'owned'})).viewers[0];
  const readOnlyLinks=await ok(get(query(detail,true),other));
  assert.equal(readOnlyLinks.record.editable,true);
  assert.equal(readOnlyLinks.items.length,2);
  assert.ok(readOnlyLinks.items.every(row=>row.canUnlink===false));
  assert.equal((await repWrite({...addLink('companies',company,3),action:'unlink'})).status,404);
  const old=grant.id;
  grant=(await change({action:'record_scope',id:grant.id,viewScope:'owned',editScope:'owned'})).viewers[0];
  const mine=await ok(get(query(detail,true),other));
  assert.equal(mine.record.editable,true);assert.deepEqual(mine.items,[]);
  assert.equal((await get(query({kind:'companies',target:company},true),other)).status,404);
  assert.equal((await repWrite(addLink('companies',company,3))).status,404);
  assert.equal((await send(api+'?workspaceId='+workspace+'&grantId='+old,{...save,revision:3},other)).status,403);
  assert.equal((await repWrite(define)).status,403);
  const deal=await createCore('deals','Fictional renewal',repId);
  await ok(repWrite(addLink('deals',deal,3)));
  assert.deepEqual((await ok(get(query(detail,true),other))).items.map(row=>row.target),[deal]);
  const restricted=await ok(send(api,{...save,id:uuid(),name:'Hidden record',assigneeId:null,values:{...save.values,[amount.id]:-10.55}}));
  assert.equal((await get(query({objectId,record:restricted.id},true),other)).status,404);
  assert.deepEqual((await ok(get(query({objectId,search:'annual'},true),other))).items.map(row=>row.id),[id]);
  const report={objectId,summary:'1',by:plan.id};
  const scopedReport=await ok(get(query(report,true),other));
  assert.deepEqual(scopedReport.groups,[{value:'Plus',count:1}]);
  assert.equal(scopedReport.total,1);
  assert.equal((await ok(get(query(report)))).total,2);
  const summed={...report,sum:amount.id};
  const fullSum=await ok(get(query(summed)));
  assert.deepEqual([fullSum.sum,fullSum.groups[0].sum],['209.45','209.45']);
  assert.equal((await ok(get(query(summed,true),other))).sum,'220');
  assert.equal((await get(query({...report,sum:plan.id}))).status,404);
  assert.equal((await get(query({objectId,sum:amount.id}))).status,400);
  assert.deepEqual((await ok(get(query({...report,by:paid.id},true),other))).groups,[{value:'false',count:1}]);
  assert.equal((await get(query({...report,by:amount.id}))).status,404);
  assert.equal((await get(query({...report,value:'Plus'}))).status,400);
  assert.equal((await get(query(report),other)).status,404);
  const reporting='/api/reporting';
  const reportCard={objectId,by:plan.id,wide:true};
  const buildDashboard=cards=>({action:'dashboard',definition:{name:'Subscription overview',cards}});
  assert.equal((await send(reporting,buildDashboard([reportCard,reportCard]))).status,400);
  assert.equal((await send(reporting,buildDashboard([{objectId,by:amount.id}]))).status,404);
  assert.equal((await send(reporting,buildDashboard([reportCard]),other)).status,404);
  assert.equal((await send(reporting,buildDashboard([{objectId,sum:plan.id}]))).status,404);
  const savedReport=(await ok(send(reporting,{action:'report',definition:{kind:'contacts',name:'Contacts count'}}))).item;
  const ordinary={reportId:savedReport.id,wide:false};
  const dashboard=(await ok(send(reporting,buildDashboard([ordinary,reportCard])))).item;
  const boardUrl=reporting+'?view=dashboard&id='+dashboard.id;
  const sharedBoard=boardUrl+'&workspaceId='+workspace;
  assert.equal((await get(sharedBoard,other)).status,404);
  await ok(send(reporting,{...buildDashboard([ordinary,reportCard]),id:dashboard.id,revision:dashboard.revision,teamVisible:true}));
  const ownerBoard=await ok(get(boardUrl));
  assert.equal(ownerBoard.cards[0].definition.name,'Contacts count');
  assert.equal(ownerBoard.cards[1].custom.total,2);
  assert.deepEqual((await ok(get(sharedBoard,other))).cards[1].custom.groups,[{label:'Plus',value:'Plus',count:1}]);
  const searchAsRep=async(search,options={})=>(await ok(get(query({objectId,search,...options},true),other))).items.map(row=>row.id);
  for(const term of ['220','pLuS','2027-01','No','false'])assert.deepEqual(await searchAsRep(term),[id],term);
  for(const term of ['Yes',repId,renewal.id])assert.deepEqual(await searchAsRep(term),[],term);
  const missingGlobal=await ok(globalSearch({query:'Hidden record'},true));
  assert.equal(missingGlobal.total,0);
  assert.equal(missingGlobal.counts['custom-objects'],0);
  const workspacePage='/?view=custom-objects&objectId='+objectId+'&record='+id+'&workspaceId='+workspace;
  const relatedReceipts=()=>sql`SELECT kind,record_ids FROM portable_record_access_events WHERE workspace_id=${workspace}
    AND actor_id=${repId} AND action='related' AND kind IN ('contacts','companies','deals')`;
  const beforePage=await relatedReceipts();
  const html=await(await get(workspacePage,other)).text();
  const afterPage=await relatedReceipts();
  assert.equal(afterPage.length,beforePage.length+1);
  assert.equal(afterPage.filter(row=>row.kind==='deals'&&row.record_ids.length===1&&row.record_ids[0]===deal).length,
    beforePage.filter(row=>row.kind==='deals'&&row.record_ids.length===1&&row.record_ids[0]===deal).length+1);
  assert.ok(html.includes('Fictional annual contract')&&html.includes('Fictional renewal'));assert.ok(!html.includes(company)&&!html.includes(contact));
  await verifyCustomRecordAccess({request,headers,other,sql,workspace,repId,objectId,id,deal,save,define,send,query,ok,get,workspacePage,restrictedId:restricted.id,globalSearch});
  const extra=field('Asset serial','text',true);
  assert.equal((await send(api,{...define,revision:1,definition:{...definition,fields:[...definition.fields,extra]}})).status,409);
  assert.equal((await send(api,{...define,revision:1,definition:{...definition,fields:[amount,paid]}})).status,409);
  await ok(send(api,{...define,revision:1,definition:{name:'Active subscriptions',fields:[{...renewal,label:'Next renewal'},amount,plan,paid,{...extra,required:false}]}}));
  assert.equal((await repWrite({...save,revision:4})).status,409);
  const serial='RéF_%777';
  const edit={...save,schemaRevision:2,revision:4,values:{[extra.id]:serial}};
  const racers=await Promise.all([repWrite(edit),repWrite({...edit,name:'Alternate annual contract'})]);
  assert.deepEqual(racers.map(r=>r.status).sort(),[200,409]);
  const updated=(await ok(get(query(detail)))).record;
  assert.equal(updated.data.values[renewal.id],save.values[renewal.id]);
  assert.deepEqual(await searchAsRep('réf_%777'),[id]);
  const global=await ok(globalSearch({query:'réf_%777'},true));
  assert.deepEqual(global.results,[{id,objectId,kind:'custom-objects',name:updated.name,detail:'Active subscriptions'}]);
  assert.equal(global.counts['custom-objects'],1);
  assert.deepEqual(await searchAsRep('RéFXX777'),[]);
  assert.deepEqual(await searchAsRep('220\nPlus'),[]);
  if(process.env.HARBOR_TEST_PLAYWRIGHT){
    const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
    const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
    try{
      const owner=await browser.newContext({viewport:{width:1280,height:800}});
      const [ownerName,ownerValue]=headers.cookie.split('=');
      await owner.addCookies([{name:ownerName,value:ownerValue,url:origin}]);
      const reportPage=await owner.newPage();
      const linkedCard=page=>page.getByRole('region',{name:'Linked custom records',exact:true});
      for(const path of ['/?contact='+contact,'/?kind=companies&record='+company]){
        await reportPage.goto(origin+path);
        const preview=linkedCard(reportPage);
        const contract=preview.getByRole('link',{name:/annual contract.*Active subscriptions/i});
        await contract.waitFor();
        assert.equal(new URL(await contract.getAttribute('href'),origin).searchParams.get('record'),id);
      }
      await reportPage.goto(origin+'/?view=reports');
      await reportPage.getByRole('link',{name:'Custom object reports'}).click();
      await reportPage.getByRole('link',{name:'Active subscriptions',exact:true}).click();
      await reportPage.getByRole('heading',{name:'Active subscriptions report'}).waitFor();
      await reportPage.getByLabel('Group by').selectOption(paid.id);
      await reportPage.getByRole('button',{name:'Apply'}).click();
      await reportPage.getByRole('table',{name:'Paid breakdown'}).getByRole('link',{name:'No',exact:true}).click();
      await reportPage.getByRole('link',{name:'Hidden record'}).waitFor();
      const downloading=reportPage.waitForEvent('download');
      await reportPage.getByRole('link',{name:'Export CSV',exact:true}).click();
      const download=await downloading;
      assert.equal(download.suggestedFilename(),'harbor-object-'+objectId+'.csv');
      const file=await readFile(await download.path(),'utf8');
      assert.ok(file.includes('Hidden record')&&file.includes(id));
      await reportPage.getByRole('link',{name:'Object report',exact:true}).click();
      await reportPage.getByLabel('Total numeric field').selectOption(amount.id);
      await reportPage.getByRole('button',{name:'Apply'}).click();
      await reportPage.getByText('Total Monthly amount: 209.45',{exact:true}).waitFor();
      const library=reportPage.waitForResponse(r=>r.url().includes('/api/reporting?view=dashboards'));
      await reportPage.getByRole('button',{name:'Add to dashboard',exact:true}).click();
      assert.equal((await library).status(),200);
      await reportPage.getByLabel('Dashboard',{exact:true}).selectOption(dashboard.id);
      await reportPage.getByRole('button',{name:'Save to dashboard'}).click();
      await reportPage.getByRole('heading',{name:'Subscription overview',exact:true}).waitFor();
      await reportPage.getByRole('heading',{name:'Active subscriptions · Paid · Monthly amount',exact:true}).waitFor();
      assert.deepEqual((await ok(get(boardUrl))).item.definition.cards,[ordinary,reportCard,{objectId,by:paid.id,sum:amount.id,wide:false}]);
      await reportPage.getByText('Edit dashboard',{exact:true}).click();
      const paidSettings=reportPage.getByRole('listitem').filter({hasText:'Active subscriptions · Paid'});
      await paidSettings.getByRole('button',{name:'Move up'}).click();
      await paidSettings.getByLabel('Full-width card').check();
      const write=reportPage.waitForResponse(r=>r.url().endsWith('/api/reporting')&&r.request().method()==='POST');
      await reportPage.getByRole('button',{name:'Save dashboard'}).click();
      assert.equal((await write).status(),200);
      assert.deepEqual((await ok(get(boardUrl))).item.definition.cards,[ordinary,{objectId,by:paid.id,sum:amount.id,wide:true},reportCard]);
      await reportPage.goto(origin+'/?'+new URLSearchParams({view:'custom-objects',objectId,summary:'1'}));
      await reportPage.getByRole('button',{name:'Add to dashboard',exact:true}).click();
      await reportPage.getByLabel('Dashboard',{exact:true}).selectOption('new');
      await reportPage.getByLabel('Dashboard name',{exact:true}).fill('Private subscription totals');
      await reportPage.getByRole('button',{name:'Save to dashboard'}).click();
      await reportPage.getByRole('heading',{name:'Private subscription totals',exact:true}).waitFor();
      const created=new URL(reportPage.url()).searchParams.get('dashboardId');
      const privateBoard=reporting+'?view=dashboard&id='+created;
      assert.equal((await ok(get(privateBoard))).cards[0].custom.total,2);
      assert.equal((await get(privateBoard+'&workspaceId='+workspace,other)).status,404);
      await owner.close();
      const context=await browser.newContext({viewport:{width:390,height:844}});
      const [name,value]=other.cookie.split('=');
      await context.addCookies([{name,value,url:origin}]);
      const tab=await context.newPage();
      await ok(send(api,{action:'link',objectId,id:restricted.id,revision:1,kind:'deals',target:deal}));
      await tab.goto(origin+'/?'+new URLSearchParams({kind:'deals',record:deal,workspaceId:workspace}));
      const sharedPreview=linkedCard(tab);
      const sharedContract=sharedPreview.getByRole('link',{name:/annual contract.*Active subscriptions/i});
      await sharedContract.waitFor();
      assert.equal(await sharedPreview.getByText(/Hidden record/).count(),0);
      await sharedContract.click();
      assert.equal(new URL(tab.url()).searchParams.get('workspaceId'),workspace);
      await tab.getByText(serial,{exact:true}).waitFor();
      await ok(send(api,{action:'unlink',objectId,id:restricted.id,revision:2,kind:'deals',target:deal}));
      await tab.goto(origin+'/?'+new URLSearchParams({view:'dashboards',workspaceId:workspace,dashboardId:dashboard.id}));
      await tab.getByRole('button',{name:'Open navigation'}).click();
      const nav=tab.getByRole('navigation',{name:'Main navigation'});
      await nav.getByRole('button',{name:'Reporting',exact:true}).click();
      await nav.getByRole('button',{name:'Pin Reports',exact:true}).click();
      await nav.getByRole('button',{name:'Unpin Reports',exact:true}).waitFor();
      await nav.getByRole('button',{name:'Bookmarks',exact:true}).click();
      await nav.getByRole('link',{name:'Reports',exact:true}).click();
      await tab.getByRole('link',{name:'Custom object reports',exact:true}).click();
      await tab.getByRole('heading',{name:'Custom object reports',exact:true}).waitFor();
      await tab.getByRole('link',{name:'Active subscriptions',exact:true}).click();
      await tab.getByText('1 active record',{exact:true}).waitFor();
      assert.equal(new URL(tab.url()).searchParams.get('workspaceId'),workspace);
      assert.equal(await tab.getByRole('button',{name:'Add to dashboard'}).count(),0);
      await tab.goto(origin+'/?'+new URLSearchParams({view:'dashboards',workspaceId:workspace,dashboardId:dashboard.id}));
      const revenue=tab.getByRole('article').filter({has:tab.getByRole('heading',{name:'Active subscriptions · Paid · Monthly amount'})});
      await revenue.getByText('Total Monthly amount: 220',{exact:true}).waitFor();
      await revenue.getByRole('link',{name:'No',exact:true}).click();
      await tab.getByRole('link',{name:'Object report',exact:true}).click();
      assert.equal(await tab.getByLabel('Total numeric field').inputValue(),amount.id);
      await tab.goto(origin+'/?'+new URLSearchParams({view:'dashboards',workspaceId:workspace,dashboardId:dashboard.id}));
      const planCard=tab.getByRole('table',{name:'Plan breakdown'});
      assert.equal(await planCard.getByRole('cell').textContent(),'1');
      await planCard.getByRole('link',{name:'Plus'}).click();
      assert.equal(await tab.getByRole('link',{name:'Hidden record',exact:true}).count(),0);
      assert.equal(await tab.getByRole('link',{name:'Export CSV',exact:true}).count(),0);
      await tab.getByRole('link',{name:'Object report'}).click();
      await tab.getByLabel('Group by').selectOption(plan.id);
      await tab.getByRole('button',{name:'Apply'}).click();
      const breakdown=tab.getByRole('table',{name:'Plan breakdown'});
      assert.equal(await breakdown.getByRole('cell').textContent(),'1');
      await breakdown.getByRole('link',{name:'Plus'}).click();
      assert.equal(new URL(tab.url()).searchParams.get('workspaceId'),workspace);
      await tab.getByRole('textbox',{name:'Search records',exact:true}).fill(serial);
      await tab.getByRole('button',{name:'Apply'}).click();
      const link=tab.getByRole('link',{name:/annual contract/i});
      await link.click();
      await tab.getByText(serial,{exact:true}).waitFor();
      assert.equal(new URL(tab.url()).searchParams.get('record'),id);
      await tab.goto(origin+'/?'+new URLSearchParams({kind:'deals',workspaceId:workspace}));
      await tab.locator('.portable-global-search summary').click();
      await tab.getByRole('searchbox',{name:'Search CRM records'}).fill(serial);
      await tab.getByLabel('Search object').selectOption('custom-objects');
      await tab.getByRole('link',{name:/annual contract.*Active subscriptions/i}).click();
      const opened=new URL(tab.url());
      assert.deepEqual(['objectId','record','workspaceId'].map(key=>opened.searchParams.get(key)),[objectId,id,workspace]);
      await tab.getByText(serial,{exact:true}).waitFor();
      await tab.goBack();
      await tab.getByRole('link',{name:/annual contract.*Active subscriptions/i}).waitFor();
      assert.equal(await tab.getByLabel('Search object').inputValue(),'custom-objects');
      assert.equal(await tab.getByRole('searchbox',{name:'Search CRM records'}).inputValue(),serial);
    }finally{await browser.close();}
  }
  await ok(repWrite({action:'archive',archived:true,id,objectId,revision:5}));
  assert.equal((await ok(get(query(report,true),other))).total,0);
  assert.equal((await ok(get(query(summed,true),other))).sum,null);
  assert.equal((await ok(get(query(summed)))).sum,'-10.55');
  assert.equal((await ok(globalSearch({query:serial},true))).total,0);
  assert.deepEqual((await ok(get(query({objectId},true),other))).items,[]);
  assert.deepEqual((await ok(get(query({kind:'deals',target:deal},true),other))).items,[]);
  assert.equal((await ok(get(query({objectId,archived:'1'},true),other))).items[0].id,id);
  await ok(repWrite({action:'archive',archived:false,id,objectId,revision:6}));
  await ok(repWrite({...addLink('deals',deal,7),action:'unlink'}));
  assert.deepEqual((await ok(get(query({kind:'deals',target:deal})))).items,[]);
  assert.equal((await ok(get(query(detail)))).items.length,2);
  await verifyCustomLinks({send,get,ok,query,repWrite,workspace,repId,other,origin,sql,setViewScope:async viewScope=>{
    grant=(await change({action:'record_scope',id:grant.id,viewScope,editScope:'owned'})).viewers[0];
  }});
  await change({action:'revoke',id:grant.id});
  assert.equal((await get(query(report,true),other)).status,404);
  assert.equal((await get(sharedBoard,other)).status,404);
  assert.equal((await get(query(detail,true),other)).status,404);
  assert.equal((await repWrite({...edit,revision:8})).status,403);
  assert.equal((await get(query({objectId,search:serial},true),other)).status,404);
  assert.equal((await globalSearch({query:serial},true)).status,404);
  const physical=await sql`SELECT workspace_id FROM portable_object_records WHERE id=${id}`;assert.equal(physical[0].workspace_id,workspace);
  const otherType=await ok(send(api,define,other));assert.equal(otherType.revision,1);
  assert.equal((await ok(send('/api/crm/search',{query:serial},other))).total,0);
  assert.equal((await get(query(detail),other)).status,404);
  await assert.rejects(sql`UPDATE portable_object_records SET data='{}'::jsonb WHERE workspace_id=${workspace} AND id=${id}`,/object_record_valid/);
  for(let n=0;n<26;n++){
    const scanner={...save,id:uuid(),schemaRevision:2,name:'Spare scanner '+n,assigneeId:null,values:{...save.values,[extra.id]:'Scanner batch'}};
    let response=await send(api,scanner);
    if(response.status===429){
      assert.equal(response.headers.get('retry-after'),'60');
      await new Promise(resolve=>setTimeout(resolve,60_000));
      response=await send(api,scanner);
    }
    await ok(response);
  }
  const first=await ok(get(query({objectId,search:'Scanner batch'})));
  const second=await ok(get(query({objectId,search:'Scanner batch',after:first.next})));
  assert.equal(first.items.length,25);assert.equal(second.items.length,1);assert.equal(second.next,null);
  assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,26);
  await sql`INSERT INTO portable_object_links(workspace_id,object_id,record_id,id,deal_id)
    SELECT ${workspace},${objectId},r.id,gen_random_uuid(),${deal}
    FROM portable_object_records r WHERE r.workspace_id=${workspace} AND r.object_id=${objectId}
      AND r.data->'values'->>${extra.id}='Scanner batch' LIMIT 4`;
  const related={kind:'deals',target:deal};
  const preview=await ok(get(query({...related,preview:'1'})));
  assert.equal((await get('/?'+new URLSearchParams({view:'custom-objects',...related,preview:'1'}))).status,404);
  assert.equal(preview.items.length,3);
  assert.equal(preview.next,preview.items[2].id);
  const [previewRead]=await sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${workspace}
    AND custom_object_id=${objectId} AND action='related' AND actor_email='owner@example.test' ORDER BY occurred_at DESC,id DESC LIMIT 1`;
  assert.deepEqual(previewRead.record_ids,preview.items.map(row=>row.recordId));
  assert.equal((await ok(get(query(related)))).items.length,4);
  assert.equal((await get(query({...related,preview:'1'},true),other)).status,404);
  const auditedPages=await sql`SELECT record_ids FROM portable_record_access_events WHERE workspace_id=${workspace}
    AND custom_object_id=${objectId} AND action='search' AND actor_email='owner@example.test' ORDER BY occurred_at DESC,id DESC LIMIT 2`;
  assert.deepEqual(auditedPages.map(row=>row.record_ids),[second.items,first.items].map(items=>items.map(row=>row.id)));
  const all=[];
  for(let page=0;page<4;page++){
    const result=await ok(globalSearch({query:'Scanner batch',kind:'custom-objects',page}));
    assert.equal(result.total,26);
    all.push(...result.results.map(row=>row.id));
  }
  assert.deepEqual(all.sort(),[...first.items,...second.items].map(row=>row.id).sort());
  await sql`INSERT INTO portable_object_records(workspace_id,object_id,id,name,data,revision)
    SELECT ${workspace},${objectId},gen_random_uuid(),'Warehouse unit '||n,
      jsonb_build_object('values',jsonb_build_object(${renewal.id}::text,'2027-01-12',${extra.id}::text,'asset-'||md5(n::text))),1
    FROM generate_series(1,20000) n`;
  await sql`VACUUM (ANALYZE) portable_object_records`;
  const summary=await ok(get(query(report)));
  assert.equal(summary.groups.find(g=>g.value===null).count,20000);
  const noAmounts=await ok(get(query(summed)));
  assert.equal(noAmounts.groups.find(g=>g.value===null).sum,null);
  const emptyBucket={objectId,by:plan.id,value:''};
  const emptyPage=await ok(get(query(emptyBucket)));
  assert.equal(emptyPage.items.length,25);
  const nextEmpty=await ok(get(query({...emptyBucket,after:emptyPage.next})));
  assert.equal(new Set([...emptyPage.items,...nextEmpty.items].map(row=>row.id)).size,50);
  assert.ok([...emptyPage.items,...nextEmpty.items].every(row=>row.name.startsWith('Warehouse unit ')));
  const [needle]=await sql`SELECT 'asset-'||md5('18442') AS serial`;
  const scanCount=async()=>Number((await sql`SELECT idx_scan FROM pg_stat_user_indexes
    WHERE indexrelname='object_record_property_search'`)[0].idx_scan);
  const before=await scanCount();
  const findAsset=async()=>assert.deepEqual((await ok(get(query({objectId,search:needle.serial})))).items.map(row=>row.name),['Warehouse unit 18442']);
  await findAsset();
  for(let retry=0;retry<12&&await scanCount()===before;retry++){
    await new Promise(resolve=>setTimeout(resolve,200));
    await findAsset();
  }
  assert.ok(await scanCount()>before,'The actual custom record lookup used the property search index');
  const globalBefore=await scanCount();
  for(let retry=0;retry<15;retry++){
    const page=await ok(globalSearch({query:needle.serial}));
    assert.deepEqual(page.results.map(row=>[row.name,row.objectId]),[['Warehouse unit 18442',objectId]]);
    if(await scanCount()>globalBefore)break;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.ok(await scanCount()>globalBefore,'Workspace search used the custom property index');
  console.log('Workspace and custom property search used the PostgreSQL index to find one serial among 20,000 warehouse units.');
  const page=await ok(get(query({objectId})));assert.equal(page.type.definition.fields[0].label,'Next renewal');
  const exportPath=filters=>query({objectId,export:'csv',...filters});
  const receipts=()=>sql`SELECT actor_email,record_ids FROM portable_record_access_events
    WHERE workspace_id=${workspace} AND custom_object_id=${objectId} AND action='csv' ORDER BY occurred_at,id`;
  const baseline=(await receipts()).length;
  const batchPath=exportPath({search:'Scanner batch',by:plan.id,value:'Plus'});
  assert.equal((await request(batchPath,{method:'HEAD',headers})).status,200);
  assert.equal((await request(exportPath({}),{method:'HEAD',headers})).status,200);
  assert.equal((await get(exportPath({workspaceId:workspace}),other)).status,400);
  assert.equal((await get(exportPath({record:id}))).status,400);
  assert.equal((await get(exportPath({after:id}))).status,400);
  const empty=await get(exportPath({search:'Missing custom record'}));
  assert.equal(empty.status,200);
  assert.equal((await empty.text()).trimEnd().split('\r\n').length,1);
  const foreign=await get(exportPath({search:'Scanner batch'}),other);
  assert.equal(foreign.status,200); // Same type ID, different owner's empty catalog.
  assert.ok(!(await foreign.text()).includes('Spare scanner'));
  assert.equal((await receipts()).length,baseline);
  const batch=await get(batchPath);
  assert.equal(batch.status,200);
  assert.ok(batch.headers.get('cache-control').includes('no-store'));
  const lines=(await batch.text()).trimEnd().split('\r\n');
  assert.equal(lines.length,27);
  assert.ok(lines[0].includes('"Property: Next renewal"'));
  const expectedIds=[...first.items,...second.items].map(row=>row.id);
  assert.deepEqual(lines.slice(1).map(line=>line.split('"')[1]),expectedIds);
  const [receipt]=(await receipts()).slice(baseline);
  assert.equal(receipt.actor_email,'owner@example.test');
  assert.deepEqual([...receipt.record_ids],expectedIds);
  const warehousePath=exportPath({search:'Warehouse unit',by:plan.id,value:''});
  const inventory=await sql`SELECT id FROM portable_object_records WHERE workspace_id=${workspace} AND object_id=${objectId}
    AND archived_at IS NULL AND name LIKE 'Warehouse unit %' ORDER BY id`;
  assert.equal(inventory.length,20000);
  const beforeWarehouse=(await receipts()).length;
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
  const desktop=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME});
  try{
    const tab=await desktop.newPage();
    const [name,value]=headers.cookie.split('=');
    await tab.context().addCookies([{name,value,url:origin}]);
    await tab.goto(origin+'/?view=custom-objects&'+new URLSearchParams({objectId,search:'Warehouse unit',by:plan.id,value:''}));
    const link=tab.getByRole('link',{name:'Export CSV',exact:true});
    assert.deepEqual(Object.fromEntries(new URL(await link.getAttribute('href'),origin).searchParams),Object.fromEntries(new URL(warehousePath,origin).searchParams));
    const [file]=await Promise.all([tab.waitForEvent('download'),link.click()]);
    assert.equal(file.suggestedFilename(),'harbor-object-'+objectId+'.csv');
    const lines=(await readFile(await file.path(),'utf8')).trimEnd().split('\r\n');
    assert.deepEqual(lines.slice(1).map(line=>line.split('"')[1]),inventory.map(row=>row.id));
    assert.equal(lines[0],(await (await get(exportPath({search:'No such warehouse'}))).text()).trimEnd());
  }finally{await desktop.close();}
  const batches=(await receipts()).slice(beforeWarehouse);
  assert.ok(batches.length>1);
  assert.ok(batches.every(batch=>batch.actor_email==='owner@example.test'&&batch.record_ids.length<=100));
  assert.deepEqual(batches.flatMap(batch=>batch.record_ids),inventory.map(row=>row.id));
  console.log('Chrome downloaded 20,000 filtered custom records; the ordered CSV IDs matched the export receipts.');
  // Losing the audit write mid-download must abort the file instead of ending with a valid partial CSV.
  const partialPath=exportPath({search:'Warehouse unit 100',by:plan.id,value:''});
  const beforePartial=(await receipts()).length;
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_fail_export_tail
    CHECK (kind<>'custom-objects' OR action<>'csv' OR cardinality(record_ids)<>11) NOT VALID`;
  try{
    await assert.rejects(async()=>{
      const response=await request(partialPath,{headers,signal:AbortSignal.timeout(10000)});
      await response.arrayBuffer();
    },TypeError);
    const sent=(await receipts()).slice(beforePartial);
    assert.equal(sent.length,1);assert.equal(sent[0].record_ids.length,100);
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_fail_export_tail`;}
  const special=await ok(send(api,{...save,id:uuid(),schemaRevision:2,assigneeId:null,name:'=Contract, "North"',
    values:{...save.values,[amount.id]:-12.5}}));
  const one=exportPath({search:'Contract, "North"'});
  const escaped=await (await get(one)).text();
  assert.ok(escaped.includes(`"'=Contract, ""North"""`)&&escaped.includes('"-12.5"')&&escaped.includes('"No"'));
  await ok(send(api,{action:'archive',archived:true,id:special.id,objectId,revision:1}));
  assert.ok(!(await (await get(one)).text()).includes(special.id));
  assert.ok((await (await get(one+'&archived=1')).text()).includes(special.id));
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_no_object_csv CHECK (kind<>'custom-objects' OR action<>'csv') NOT VALID`;
  try{assert.equal((await get(batchPath)).status,503);}
  finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_no_object_csv`;}
  grant=(await change({action:'grant',email:'other@example.test'})).viewers[0];
  grant=(await change({action:'role',id:grant.id,role:'editor'})).viewers[0];
  await verifyCustomObjectImport({api,send,ok,origin,headers,other,sql,workspace,grantId:grant.id});
}

async function verifyCustomRecordAccess({request,headers,other,sql,workspace,repId,objectId,id,deal,save,define,send,query,ok,get,workspacePage,restrictedId,globalSearch}){
  const api='/api/custom-objects',asset=uuid();
  await ok(send(api,{...define,id:asset,definition:{...define.definition,name:'Hardware assets'}}));
  // IDs are unique within an object. The same record ID can appear in two object types.
  await ok(send(api,{...save,objectId:asset,name:'Warehouse scanner'}));
  await ok(send(api,{action:'link',id,objectId:asset,revision:1,kind:'deals',target:deal}));
  const receipts=async()=>sql`SELECT id,action,custom_object_id,record_ids FROM portable_record_access_events
    WHERE workspace_id=${workspace} AND actor_id=${repId} AND kind='custom-objects' ORDER BY occurred_at,id`;
  const before=await receipts();
  for(const path of [workspacePage,query({objectId,record:id},true),query({objectId,search:'annual'},true)])
    assert.ok((await request(path,{method:'HEAD',headers:other})).ok,path);
  assert.equal((await get(query({objectId,record:restrictedId},true),other)).status,404);
  await ok(get(query({objectId,search:'absent needle'},true),other));
  assert.equal((await receipts()).length,before.length);
  const listPage='/?'+new URLSearchParams({view:'custom-objects',objectId,workspaceId:workspace});
  assert.ok((await get(listPage,other)).ok);
  assert.ok((await get(listPage+'&search=annual',other)).ok);
  assert.ok((await get(workspacePage+'&mode=edit',other)).ok);
  const linked=await ok(get(query({kind:'deals',target:deal},true),other));
  assert.deepEqual(linked.items.map(row=>row.objectId).sort(),[asset,objectId].sort());
  const added=(await receipts()).slice(before.length);
  assert.deepEqual(added.map(row=>row.action),['list','search','detail','related','related']);
  assert.deepEqual(added.map(row=>row.custom_object_id).slice(0,3),[objectId,objectId,objectId]);
  assert.deepEqual(added.slice(3).map(row=>row.custom_object_id).sort(),[asset,objectId].sort());
  assert.ok(added.every(row=>row.record_ids.length===1&&row.record_ids[0]===id));
  const event=added.find(row=>row.custom_object_id===asset);
  const history='/?view=record-access&kind=custom-objects&event='+event.id;
  const ownerHtml=await(await get(history,headers)).text();
  assert.ok(ownerHtml.includes('Hardware assets')&&ownerHtml.includes('other@example.test'));
  assert.ok(ownerHtml.includes('href="/?view=custom-objects&amp;objectId='+asset+'&amp;record='+id+'"'));
  const otherHtml=await(await get(history,other)).text();
  assert.ok(otherHtml.includes('No matching access events.')&&!otherHtml.includes('Hardware assets'));
  const typeHistory='/?'+new URLSearchParams({view:'record-access',kind:'custom-objects',objectId:asset});
  const recordHistory=typeHistory+'&record='+id;
  const assetPath='/?'+new URLSearchParams({view:'custom-objects',objectId:asset});
  for(const [path,destination] of [[assetPath,typeHistory],[assetPath+'&record='+id,recordHistory]]){
    const page=await get(path);
    assert.ok(page.ok);
    assert.ok((await page.text()).includes('href="'+destination.replaceAll('&','&amp;')+'"'));
    const shared=await get(path+'&workspaceId='+workspace,other);
    assert.ok(shared.ok);
    assert.ok(!(await shared.text()).includes('href="'+destination.replaceAll('&','&amp;')+'"'));
  }
  const filtered=await get(recordHistory+'&action=related');
  assert.ok(filtered.ok);
  const filteredHtml=await filtered.text();
  const table=filteredHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]??'';
  assert.ok(table.includes('Hardware assets')&&!table.includes('Subscriptions'),table||'Missing access history rows');
  const csv='/api/workspaces'+recordHistory.slice(1)+'&export=csv&action=related';
  const exportResponse=await get(csv);
  assert.ok(exportResponse.ok);
  const exported=await exportResponse.text();
  assert.ok(exported.includes(event.id)&&exported.includes(asset)&&!exported.includes(objectId));
  const otherEvent=added.find(row=>row.custom_object_id===objectId);
  for(const selection of ['&event='+otherEvent.id,'&eventIds='+otherEvent.id]){
    const selected=await get(csv+selection);
    assert.ok(selected.ok);
    assert.equal((await selected.text()).trim().split('\r\n').length,1);
  }
  const separate=await get(csv,other);
  assert.ok(separate.ok);
  assert.equal((await separate.text()).trim().split('\r\n').length,1);
  const company=await ok(send('/api/crm',{action:'save',kind:'companies',data:{name:'Warehouse scanner'},assigneeId:repId}));
  const mixed=await ok(globalSearch({query:'Warehouse scanner'},true));
  assert.deepEqual([mixed.total,mixed.counts.companies,mixed.counts['custom-objects']],[2,1,1]);
  assert.deepEqual(mixed.results.map(row=>row.id),[company.record.id,id].sort());
  const onlyCompanies=await ok(globalSearch({query:'Warehouse scanner',kind:'companies'},true));
  assert.deepEqual(onlyCompanies.results.map(row=>row.id),[company.record.id]);
  assert.deepEqual(onlyCompanies.counts,mixed.counts);
  const companySearchEvents=async()=>Number((await sql`SELECT count(*) AS count FROM portable_record_access_events
    WHERE workspace_id=${workspace} AND actor_id=${repId} AND kind='companies' AND action='search'
    AND ${company.record.id}::uuid=ANY(record_ids)`)[0].count);
  const priorCompany=await companySearchEvents();
  const beforeFailure=(await receipts()).length;
  await sql`ALTER TABLE portable_record_access_events ADD CONSTRAINT fixture_custom_access_failure
    CHECK (kind <> 'custom-objects') NOT VALID`;
  try{
    const withheld=await globalSearch({query:'Warehouse scanner'},true);
    assert.equal(withheld.status,503);
    assert.ok(!(await withheld.text()).includes(id));
    for(const path of [query({objectId,record:id},true),query({objectId,search:'annual'},true),query({kind:'deals',target:deal},true)]){
      const response=await get(path,other);
      assert.equal(response.status,503);
      assert.ok(!(await response.text()).includes(id));
    }
  }finally{await sql`ALTER TABLE portable_record_access_events DROP CONSTRAINT fixture_custom_access_failure`;}
  assert.equal((await receipts()).length,beforeFailure);
  assert.equal(await companySearchEvents(),priorCompany);
  const both=await ok(globalSearch({query:'Plus',kind:'custom-objects'},true));
  assert.equal(both.total,2);
  assert.deepEqual(both.results.map(row=>row.objectId).sort(),[asset,objectId].sort());
  assert.ok(both.results.every(row=>row.id===id));
  const audited=(await receipts()).slice(-2);
  assert.ok(audited.every(row=>row.action==='search'&&row.record_ids.length===1&&row.record_ids[0]===id));
  assert.deepEqual(audited.map(row=>row.custom_object_id).sort(),[asset,objectId].sort());
  await ok(send(api,{action:'unlink',id,objectId:asset,revision:2,kind:'deals',target:deal}));
}
