import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyTeamRollups} from './portable-team-rollup-fixture.mjs';

// Exercise the built server in a phone-sized viewer session and a desktop owner session.
export async function verifyRecordReporting({request,origin,headers,other,sql}){
  const post=async(path,body,account=headers)=>{
    const res=await request(path,{method:'POST',headers:{...account,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.ok(res.ok,await res.clone().text());return res.json();
  };
  const crm=(kind,data,links={})=>post('/api/crm',{kind,action:'save',data,...links}).then(response=>response.record);
  const company=await crm('companies',{name:'Fictional Faraday Studio',industry:'Design'});
  const contact=await crm('contacts',{name:'Ellis Example',email:'ellis@example.test'},{primaryCompanyId:company.id});
  const deal=await crm('deals',{name:'Faraday renewal',amount:240},{companyId:company.id});
  await crm('deals',{name:'Unlinked prior renewal',amount:80});
  await crm('companies',{...company.data,industry:'Industrial design'},{id:company.id,expectedRevision:company.revision});
  const when='2087-08-03T14:05:00.000Z';
  await sql`UPDATE deals SET created_at=${when} WHERE id=${deal.id}`;
  await sql`UPDATE contacts SET created_at=${when} WHERE id=${contact.id}`;
  const {owned:workspaceId,viewers}=await post('/api/workspaces',{action:'grant',email:'other@example.test'});
  const makeReport=async definition=>(await post('/api/reporting',{action:'report',definition})).item;
  const amounts=await makeReport({name:'Revenue by customer industry',kind:'deals',metric:'sum',measure:'amount',groupBy:'associated:industry'});
  const people=await makeReport({name:'Customers created',kind:'contacts',groupBy:'lifecycle'});
  const prior=await makeReport({name:'Prior year deals',kind:'deals',createdDateRange:{from:'2086-01-01',through:'2086-12-31'}});
  const bound=await makeReport({name:'Sales pipeline deals',kind:'deals',dealPipelineId:'default'});
  const {item:dashboard}=await post('/api/reporting',{action:'dashboard',teamVisible:true,definition:{name:'Quarterly sales',cards:[amounts,people,prior,bound].map(report=>({reportId:report.id,wide:false}))}});
  const args=new URLSearchParams({view:'dashboard',id:dashboard.id,workspaceId,createdFrom:'2087-08-03',createdThrough:'2087-08-03',dashboardPipeline:'default'});
  async function read(params){const res=await request('/api/reporting?'+params,{headers:other});assert.equal(res.status,200,await res.clone().text());return res.json();}
  const {cards}=await read(args);
  assert.deepEqual(cards.map(card=>card.result.count),['1','1','0','1']);
  assert.equal(cards[0].result.total,'240');
  assert.deepEqual(cards[0].result.rows.map(row=>row.label),['Industrial design']);
  const conflict=new URLSearchParams(args);conflict.set('dashboardPipeline',randomUUID());
  assert.deepEqual((await read(conflict)).cards.map(card=>card.result.count),['0','1','0','0']);
  conflict.set('view','dashboardRecords');conflict.set('reportId',bound.id);
  assert.deepEqual((await read(conflict)).records,[]);
  const invalid=new URLSearchParams(args);invalid.set('createdThrough','2086-08-03');
  assert.equal((await request('/api/reporting?'+invalid,{headers:other})).status,400);
  const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT??'playwright');
  const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
  async function open(auth,width,height){
    const ctx=await browser.newContext({viewport:{width,height},isMobile:width<500,hasTouch:width<500});
    const [name,value]=auth.cookie.split('=');await ctx.addCookies([{name,value,url:origin}]);
    const page=await ctx.newPage();page.setDefaultTimeout(7500);return page;
  }
  try{
    const owner=await open(headers,1365,850),member=await open(other,390,844);
    await owner.goto(origin+'/?kind=deals&view=board&search=Faraday+renewal');
    await owner.getByRole('link',{name:'Faraday renewal',exact:true}).click();
    await owner.getByRole('link',{name:'Fictional Faraday Studio',exact:true}).first().click();
    await owner.getByRole('link',{name:'Back to deal',exact:true}).click();
    await owner.getByRole('link',{name:'Back to deal board',exact:true}).click();
    assert.equal(new URL(owner.url()).searchParams.get('search'),'Faraday renewal');
    for(const [page,kind,id,field] of [[member,'contacts',contact.id,'Email'],[owner,'companies',company.id,'Industry'],[member,'deals',deal.id,'Amount']]){
      const path=new URLSearchParams(kind==='contacts'?{contact:id}:{kind,record:id});
      if(page===member)path.set('workspaceId',workspaceId);
      await page.goto(origin+'/?'+path);
      await page.getByRole('button',{name:'View all properties',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'All properties'});
      await dialog.getByRole('searchbox').fill(field);
      await dialog.getByText(field,{exact:true}).first().waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
    }
    await owner.goto(origin+'/?kind=companies&record='+company.id);
    const disclosure=owner.locator('#portable-property-history');
    await disclosure.locator('summary').click();
    await disclosure.getByRole('searchbox').fill('Industrial design');
    await disclosure.getByRole('button',{name:'Search',exact:true}).click();
    await disclosure.getByRole('button',{name:'View Industry history',exact:true}).first().click();
    await disclosure.getByRole('listitem').filter({hasText:'Design → Industrial design'}).first().waitFor();
    const dash='/?view=dashboards&dashboardId='+dashboard.id+'&workspaceId='+workspaceId;
    await member.goto(origin+dash);
    const form=member.getByRole('form',{name:'Dashboard filters'});
    await form.getByLabel('Created from (UTC)').fill('2087-08-03');
    await form.getByLabel('Created through (UTC)').fill('2087-08-03');
    await form.getByLabel('Deal pipeline').selectOption('default');
    await form.getByRole('button',{name:'Apply filters'}).click();
    await member.waitForURL(url=>url.searchParams.get('dashboardPipeline')==='default');
    const article=member.getByRole('article').filter({has:member.getByRole('heading',{name:'Revenue by customer industry results'})});
    await article.getByRole('button',{name:'Bar chart',exact:true}).click();
    await article.getByRole('button',{name:'View records for Industrial design'}).click();
    await article.getByRole('link',{name:'Faraday renewal',exact:true}).click();
    await member.getByRole('link',{name:'Back to dashboard',exact:true}).click();
    assert.equal(new URL(member.url()).searchParams.get('createdThrough'),'2087-08-03');
    assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mobile dashboard should fit its viewport');
    await member.getByRole('link',{name:'Clear dashboard filters'}).click();
    assert.equal(new URL(member.url()).searchParams.has('dashboardPipeline'),false);
    await article.getByRole('button',{name:'Share of total'}).click();
    const shares=article.getByRole('figure',{name:'Revenue by customer industry share of total'});
    await shares.getByText('75%',{exact:true}).waitFor();
    await shares.getByText('25%',{exact:true}).waitFor();
    await shares.getByRole('button',{name:'View records for No value'}).click();
    await article.getByRole('link',{name:'Unlinked prior renewal',exact:true}).waitFor();
    // Older snapshots of the same owner and two people with the same name must remain distinguishable.
    const owners=await sql`SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test') ORDER BY email`;
    for(const kind of ['contacts','companies','deals']){
      const when='2092-05-01T12:00:00Z';
      const rows=[owners[0].id,owners[0].id,owners[1].id,null].map((userId,i)=>({
        workspace_id:workspaceId,id:randomUUID(),revision:1,created_at:when,updated_at:when,
        data:sql.json({name:'Rollup '+kind+' '+i,...(kind==='deals'?{amount:10*(i+1)}:{}),
          ...(userId?{recordOwner:{workspaceId,userId,label:i===0?'Earlier display name':'Taylor Reed'}}:{})}),
      }));
      await sql`INSERT INTO ${sql(kind)} ${sql(rows)}`;
      const definition={name:'By owner '+kind,kind,groupBy:'recordOwner',createdDateRange:{from:'2092-05-01',through:'2092-05-01'},
        ...(kind==='deals'?{metric:'sum',measure:'amount'}:{})};
      const {result}=await post('/api/reporting',{action:'preview',definition});
      assert.equal(result.count,'4');
      assert.deepEqual(Object.fromEntries(result.rows.map(row=>[row.key,row.value])),{
        [owners[0].id]:kind==='deals'?'30':'2',[owners[1].id]:kind==='deals'?'30':'1',null:kind==='deals'?'40':'1'});
      assert.equal(result.rows.find(row=>row.key===null).label,'Unassigned');
      assert.equal(new Set(result.rows.map(row=>row.label)).size,3);
      if(kind==='deals'){
        const saved=await makeReport(definition);
        const exported=await request('/api/reporting',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
          body:JSON.stringify({action:'export',id:saved.id,revision:saved.revision})});
        assert.equal(exported.status,200);
        const csv=await exported.text();
        assert.match(csv,/^"Record owner","Total deal amount","Records"/);
        for(const row of result.rows)assert.ok(csv.includes('"'+row.label+'"'));
        await owner.goto(origin+'/?view=reports&reportId='+saved.id);
        await owner.getByText('Edit report',{exact:true}).click();
        assert.equal(await owner.getByRole('combobox',{name:/^Group by/}).inputValue(),'recordOwner');
        const label=result.rows.find(row=>row.key===owners[0].id).label;
        await owner.getByRole('button',{name:'View records for '+label,exact:true}).click();
        await owner.getByRole('link',{name:'Rollup deals 0',exact:true}).waitFor();
        await owner.getByRole('link',{name:'Rollup deals 1',exact:true}).waitFor();
        assert.equal(await owner.getByRole('link',{name:'Rollup deals 2',exact:true}).count(),0);
      }
    }
    const viewer=owners[0].id,manager=owners[1].id;
    const queueCards=[];
    for(const [kind,data] of [['tickets',{ticketStatus:'New'}],['leads',{leadStage:'New'}],['tasks',{status:'Not started'}]]){
      const when='2093-03-05T12:00:00Z';
      const rows=[viewer,viewer,manager,null].map((id,i)=>({workspace_id:workspaceId,id:randomUUID(),revision:1,
        created_at:when,updated_at:when,data:sql.json({...data,name:'Queue '+kind+' '+i}),
        assignee_id:id,assignee_label:id?(i===0?'Previous label':'Taylor Reed'):null}));
      await sql`INSERT INTO ${sql('portable_'+kind)} ${sql(rows)}`;
      const definition={name:'Queue by assignee '+kind,kind,groupBy:'assignee',createdDateRange:{from:'2093-03-05',through:'2093-03-05'}};
      const {result}=await post('/api/reporting',{action:'preview',definition});
      assert.deepEqual(Object.fromEntries(result.rows.map(r=>[r.key,r.count])),{[viewer]:'2',[manager]:'1',null:'1'});
      assert.equal(result.rows.find(r=>r.key===null).label,'Unassigned');
      assert.equal(new Set(result.rows.map(r=>r.label)).size,3);
      queueCards.push({reportId:(await makeReport(definition)).id,wide:false});
    }
    const {item:queues}=await post('/api/reporting',{action:'dashboard',teamVisible:true,definition:{name:'Assigned work',cards:queueCards}});
    const scopedGrant=await post('/api/workspaces',{action:'record_scope',id:viewers.find(v=>v.email==='other@example.test').id,viewScope:'owned',editScope:'owned'});
    const scoped=new URLSearchParams({view:'dashboard',id:queues.id,workspaceId});
    const summary=await read(scoped);
    for(const card of summary.cards){
      assert.deepEqual(card.result.rows.map(r=>[r.key,r.count]),[[viewer,'2']]);
      const query=new URLSearchParams(scoped);query.set('view','dashboardRecords');query.set('reportId',card.reportId);
      query.set('group',manager);assert.deepEqual((await read(query)).records,[]);
      query.set('group',viewer);assert.equal((await read(query)).records.length,2);
    }
    await verifyTeamRollups({post,read,sql,workspaceId,viewer,grantId:scopedGrant.viewers.find(v=>v.email==='other@example.test').id,owner,origin});
  }finally{await browser.close();}
}
