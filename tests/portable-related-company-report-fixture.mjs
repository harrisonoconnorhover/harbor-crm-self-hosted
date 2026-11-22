import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyRelatedCompanyReports({request,origin,headers,other,sql}){
  const api='/api/reporting';
  const write=(body,auth=headers)=>request(api,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=(query,auth=headers)=>request(api+'?'+new URLSearchParams(query),{headers:auth});
  async function json(response,status=200){
    assert.equal(response.status,status,await response.clone().text());
    return response.json();
  }
  const when='2091-01-06T12:00:00Z';
  const definition={name:'Pipeline by primary company industry',kind:'deals',metric:'sum',measure:'amount',
    dealPipelineId:'default',dealOutcome:'open',groupBy:'associated:industry',sort:'label',
    createdDateRange:{from:'2091-01-06',through:'2091-01-06'}};
  const {item:report}=await json(await write({action:'report',definition}),201);
  const {item:foreignReport}=await json(await write({action:'report',definition},other),201);
  const [owner]=await sql`SELECT workspace_id AS id FROM portable_reports WHERE id=${report.id}`;
  const [foreign]=await sql`SELECT workspace_id AS id FROM portable_reports WHERE id=${foreignReport.id}`;
  const [{id:repId}]=await sql`SELECT id FROM login_identities WHERE email='other@example.test'`;
  const [prior]=await sql`SELECT view_scope,edit_scope,backup_admin FROM portable_workspace_viewers
    WHERE workspace_id=${owner.id} AND viewer_id=${repId}`;
  const visible={workspaceId:owner.id,userId:repId};
  const companies=Array.from({length:3},()=>randomUUID());
  const ids=Array.from({length:8},()=>randomUUID());
  const base=(id,workspace_id)=>({id,workspace_id,revision:1,created_at:when,updated_at:when});
  const company=(id,industry,recordOwner,archived_at=null,workspace=owner.id)=>({...base(id,workspace),archived_at,
    data:sql.json({name:industry,industry,city:'Fictional City',lifecycle:'Customer',recordOwner})});
  const deal=(i,amount,company_id,recordOwner=visible,stage='Appointment scheduled',workspace=owner.id)=>({
    ...base(ids[i],workspace),company_id,data:sql.json({name:'Related report Deal '+i,amount,recordOwner,stage})});
  let dashboard;
  const drill={view:'reportRecords',id:report.id,revision:String(report.revision)};
  async function matching(query,auth){
    const page=await json(await read(query,auth));
    assert.equal(page.kind,'deals');
    return page.records.map(row=>row.id).sort();
  }
  try{
    await sql`INSERT INTO portable_workspace_viewers (workspace_id,viewer_id,id,view_scope,edit_scope)
      VALUES (${owner.id},${repId},${randomUUID()},'owned','owned') ON CONFLICT(workspace_id,viewer_id)
      DO UPDATE SET view_scope='owned',edit_scope='owned',backup_admin=false`;
    await sql`INSERT INTO companies ${sql([company(companies[0],'Manufacturing',visible),company(companies[1],'Restricted industry',null),
      company(companies[2],'Archived industry',visible,when),company(companies[0],'Other workspace industry',null,null,foreign.id)])}`;
    await sql`INSERT INTO deals ${sql([deal(0,100,companies[0]),deal(1,125,companies[0]),deal(2,50,companies[1]),
      deal(3,25,companies[2]),deal(4,5,null),deal(5,1000,companies[0],null),deal(6,900,companies[0],visible,'Closed lost'),
      deal(7,2222,companies[0],null,'Appointment scheduled',foreign.id)])}`;
    const {result}=await json(await write({action:'preview',definition}));
    const byLabel=rows=>Object.fromEntries(rows.map(row=>[row.label,[row.count,row.value]]));
    assert.deepEqual([result.count,result.total],['6','1305']);
    assert.deepEqual(byLabel(result.rows),{Manufacturing:['3','1225'],'Restricted industry':['1','50'],'No value':['2','30']});
    assert.deepEqual(await matching({...drill,group:'Manufacturing'}),[ids[0],ids[1],ids[5]].sort());
    assert.deepEqual(await matching({...drill,group:''}),[ids[3],ids[4]].sort());
    assert.equal((await read({...drill,revision:'2'})).status,409);
    assert.equal((await read(drill,other)).status,404);
    const csv=await write({action:'export',id:report.id,revision:report.revision});
    assert.equal(csv.status,200);
    assert.match(await csv.text(),/^"Company industry","Total deal amount","Records"/);
    const saved=await request('/?view=reports&reportId='+report.id,{headers});
    assert.equal(saved.status,200);
    const html=await saved.text();
    assert.match(html,/Company industry/);
    assert.match(html,/View records for Manufacturing/);
    for(const [field,expected] of [['city','Fictional City'],['lifecycle','Customer']]){
      const {result}=await json(await write({action:'preview',definition:{...definition,groupBy:'associated:'+field}}));
      assert.deepEqual(byLabel(result.rows)[expected],['4','1275']);
    }
    for(const changes of [{groupBy:'associated:recordOwner'},{kind:'companies',metric:'count',measure:'',dealPipelineId:undefined,dealOutcome:undefined}]){
      assert.equal((await write({action:'preview',definition:{...definition,...changes}})).status,400);
    }
    ({item:dashboard}=await json(await write({action:'dashboard',definition:{name:'Related pipeline',cards:[{reportId:report.id}]},teamVisible:true}),201));
    const shared={id:dashboard.id,workspaceId:owner.id};
    const {cards}=await json(await read({view:'dashboard',...shared},other));
    assert.deepEqual([cards[0].result.count,cards[0].result.total],['5','305']);
    assert.deepEqual(byLabel(cards[0].result.rows),{Manufacturing:['2','225'],'No value':['3','80']});
    const groups={view:'dashboardRecords',...shared,reportId:report.id};
    assert.deepEqual(await matching({...groups,group:'Manufacturing'},other),[ids[0],ids[1]].sort());
    assert.deepEqual(await matching({...groups,group:''},other),[ids[2],ids[3],ids[4]].sort());
    assert.deepEqual(await matching({...groups,group:'Restricted industry'},other),[]);
    if(process.env.HARBOR_TEST_PLAYWRIGHT){
      const {chromium}=await import(process.env.HARBOR_TEST_PLAYWRIGHT);
      const browser=await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME,headless:true});
      try{
        const page=await browser.newPage();
        const [name,value]=headers.cookie.split('=');
        await page.context().addCookies([{name,value,url:origin}]);
        page.setDefaultTimeout(7000);
        const response=await page.goto(origin+'/?view=reports&reportId='+report.id);
        assert.equal(response.status(),200);
        assert.equal(new URL(page.url()).searchParams.get('reportId'),report.id);
        await page.getByText('Edit report',{exact:true}).click();
        assert.equal(await page.getByRole('combobox',{name:/^Group by/}).inputValue(),'associated:industry');
        await page.getByRole('button',{name:'View records for Manufacturing',exact:true}).click();
        const records=page.getByRole('region',{name:'Matching records for '+definition.name});
        await records.getByRole('link',{name:'Related report Deal 0',exact:true}).waitFor();
        assert.equal(await records.getByRole('link').count(),3);
        await records.getByRole('link',{name:'Related report Deal 0'}).click();
        await page.waitForURL(url=>url.searchParams.get('record')===ids[0]);
        const back=new URL(page.url()).searchParams.get('back');
        assert.equal(back,'/?view=reports&reportId='+report.id);
        await page.goto(origin+back);
        await page.getByText('Edit report',{exact:true}).click();
        await page.getByRole('combobox',{name:/^Group by/}).selectOption('associated:city');
        await page.getByRole('combobox',{name:/^Default display/}).selectOption('bar');
        await page.getByRole('button',{name:'Save report',exact:true}).click();
        await page.getByRole('button',{name:'View records for Fictional City',exact:true}).waitFor();
        const savedReport=await json(await read({id:report.id}));
        assert.equal(savedReport.item.definition.groupBy,'associated:city');
        assert.equal(savedReport.item.definition.chart,'bar');
        assert.equal(await page.getByRole('button',{name:'Bar chart',exact:true}).getAttribute('aria-pressed'),'true');
        assert.equal(savedReport.item.revision,report.revision+1);
      }finally{await browser.close();}
    }
  }finally{
    if(dashboard)await sql`DELETE FROM portable_dashboards WHERE id=${dashboard.id} AND workspace_id=${owner.id}`;
    await sql`DELETE FROM portable_reports WHERE id IN ${sql([report.id,foreignReport.id])}`;
    await sql`DELETE FROM deals WHERE id IN ${sql(ids)}`;
    await sql`DELETE FROM companies WHERE id IN ${sql(companies)}`;
    if(prior)await sql`UPDATE portable_workspace_viewers SET ${sql(prior)} WHERE workspace_id=${owner.id} AND viewer_id=${repId}`;
    else await sql`DELETE FROM portable_workspace_viewers WHERE workspace_id=${owner.id} AND viewer_id=${repId}`;
  }
}
