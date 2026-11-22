import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyTeamRollups({post,read,sql,workspaceId,viewer,grantId,owner,origin}){
  // This independent rehearsal shares two fictional accounts with the preceding reporting suite.
  await sql`DELETE FROM portable_request_budgets WHERE scope IN ('api_read','api_write')
    AND subject IN (SELECT id FROM login_identities WHERE email IN ('owner@example.test','other@example.test'))`;
  const east=randomUUID(),west=randomUUID(),pod=randomUUID(),subpod=randomUUID();
  const change=body=>post('/api/workspaces',body);
  const report=body=>post('/api/reporting',body);
  for(const [id,name,parentId] of [[east,'East',null],[west,'West',null],[pod,'Sales',east],[subpod,'Enterprise',pod]]){
    await change({action:'team_create',id,name,parentId});
  }
  await change({action:'role',id:grantId,role:'editor'});
  // Role and scope changes rotate the grant. Read the current one before each edit.
  const currentGrant=async()=>(await sql`SELECT id FROM portable_workspace_viewers WHERE workspace_id=${workspaceId} AND viewer_id=${viewer}`)[0].id;
  await change({action:'team_assign',id:await currentGrant(),teamId:pod,previousTeamId:null});
  await change({action:'record_scope',id:await currentGrant(),viewScope:'team',editScope:'owned'});

  // Every supported record type already has two records for this teammate and two without a team.
  for(const kind of ['contacts','companies','deals','tasks','leads','tickets']){
    const date=['tasks','leads','tickets'].includes(kind)?'2093-03-05':'2092-05-01';
    const {result}=await report({action:'preview',definition:{name:'Work by pod',kind,groupBy:'primaryTeam',
      createdDateRange:{from:date,through:date}}});
    const team=result.rows.find(row=>row.key===pod),without=result.rows.find(row=>row.key===null);
    assert.deepEqual([team.label,team.count,without.label,without.count],['East / Sales','2','No assigned team','2']);
    const {result:branch}=await report({action:'preview',definition:{name:'Work in Sales',kind,teamId:pod,
      createdDateRange:{from:date,through:date}}});
    assert.equal(branch.count,'2',kind+' includes direct assignments and excludes records outside Sales');
  }
  const rep=randomUUID(),deal=randomUUID(),when='2092-05-01T12:00:00Z';
  await sql`INSERT INTO login_identities(id,email,google_subject,created_at,updated_at)
    VALUES (${rep},'team-rollup@example.test',${rep},0,0)`;
  await sql`INSERT INTO portable_workspace_viewers(workspace_id,id,viewer_id,role,team_id)
    VALUES (${workspaceId},${randomUUID()},${rep},'editor',${subpod})`;
  await sql`INSERT INTO deals(workspace_id,id,revision,created_at,updated_at,data)
    VALUES (${workspaceId},${deal},1,${when},${when},${sql.json({name:'Enterprise deal',amount:75,recordOwner:{workspaceId,userId:rep,label:'Enterprise rep'}})})`;
  const definition={kind:'deals',name:'Sales by region',metric:'sum',measure:'amount',groupBy:'topLevelTeam',
    createdDateRange:{from:'2092-05-01',through:'2092-05-01'}};
  const {item:saved}=await report({action:'report',definition});
  await owner.goto(origin+'/?view=reports&reportId='+saved.id);
  await owner.getByText('Edit report',{exact:true}).click();
  assert.equal(await owner.getByRole('combobox',{name:/^Group by/}).inputValue(),'topLevelTeam');
  await owner.getByRole('button',{name:'View records for East',exact:true}).click();
  await owner.getByRole('link',{name:'Enterprise deal',exact:true}).waitFor();

  // Save a filter on the middle team, and reopen the report through the normal editor.
  const {item:branchReport}=await report({action:'report',definition:{...definition,name:'Sales branch revenue'}});
  const branchUrl=origin+'/?view=reports&reportId='+branchReport.id;
  await owner.goto(branchUrl);
  await owner.getByText('Edit report',{exact:true}).click();
  await owner.getByRole('combobox',{name:/^Team filter/}).selectOption({label:'East / Sales'});
  const savedBranch=owner.waitForResponse(r=>new URL(r.url()).pathname==='/api/reporting'&&r.request().method()==='POST');
  await owner.getByRole('button',{name:'Save report',exact:true}).click();
  assert.equal((await (await savedBranch).json()).item.definition.teamId,pod);
  await owner.goto(branchUrl);
  await owner.getByText('East / Sales and subteams',{exact:true}).waitFor();
  await owner.getByRole('button',{name:'View records for East',exact:true}).click();
  await owner.getByRole('link',{name:'Enterprise deal',exact:true}).waitFor();

  const {item:dashboard}=await report({action:'dashboard',teamVisible:true,definition:{name:'Team revenue',cards:[{reportId:saved.id},{reportId:branchReport.id}]}});
  const shared={id:dashboard.id,workspaceId};
  const totals=async()=> (await read(new URLSearchParams({...shared,view:'dashboard'}))).cards[0].result;
  const matches=async group=>(await read(new URLSearchParams({...shared,view:'dashboardRecords',reportId:saved.id,group}))).records;
  let result=await totals();
  assert.deepEqual(result.rows.map(row=>[row.key,row.count,row.value]),[[east,'3','105']]);
  assert.ok((await matches(east)).some(row=>row.id===deal));
  assert.deepEqual(await matches(''),[]);
  await change({action:'team_edit',id:subpod,revision:1,name:'Enterprise',parentId:west});
  result=await totals();
  assert.deepEqual(result.rows.map(row=>[row.key,row.count,row.value]),[[east,'2','30']]);
  assert.equal((await matches(east)).some(row=>row.id===deal),false);
  assert.deepEqual(await matches(west),[]);
  // A manager with wider access still sees only the saved branch on its own card.
  await change({action:'record_scope',id:await currentGrant(),viewScope:'all',editScope:'owned'});
  const {cards:reorganized}=await read(new URLSearchParams({...shared,view:'dashboard'}));
  assert.ok(reorganized[0].result.rows.some(row=>row.key===west));
  assert.deepEqual(reorganized[1].result.rows.map(row=>[row.key,row.count,row.value]),[[east,'2','30']]);
  const branchRows=await read(new URLSearchParams({...shared,view:'dashboardRecords',reportId:branchReport.id}));
  assert.equal(branchRows.records.length,2);
  assert.ok(branchRows.records.every(row=>row.id!==deal));
  await change({action:'record_scope',id:await currentGrant(),viewScope:'team',editScope:'owned'});
  const {result:updated}=await report({action:'preview',definition:{...definition,teamId:pod}});
  assert.deepEqual([updated.count,updated.total],['2','30']);
  const exported=await owner.request.post(origin+'/api/reporting',{headers:{origin},data:{action:'export',
    definition:{name:'Sales contacts',kind:'contacts',teamId:pod}}});
  assert.equal(exported.status(),200);
  assert.match(await exported.text(),/Matching records/);
  const {result:unknown}=await report({action:'preview',definition:{...definition,teamId:randomUUID()}});
  assert.equal(unknown.count,'0','An unavailable team must keep the report empty');
  const {result:all}=await report({action:'preview',definition});
  assert.deepEqual(Object.fromEntries(all.rows.map(row=>[row.key,row.value])),{[east]:'30',[west]:'75',null:'70'});

  const date='2094-03-06',stamp=date+'T12:00:00Z';
  await sql`INSERT INTO deals(workspace_id,id,revision,created_at,updated_at,data)
    SELECT ${workspaceId},gen_random_uuid(),1,${stamp},${stamp},
      jsonb_build_object('name','Team pipeline ' || n,'amount',10,'recordOwner',jsonb_build_object(
        'workspaceId',${workspaceId}::text,'userId',CASE WHEN n%5<3 THEN ${viewer}::text ELSE ${rep}::text END))
    FROM generate_series(1,50000) n`;
  await sql`ANALYZE deals`;
  const large={...definition,name:'Regional pipeline at scale',createdDateRange:{from:date,through:date}};
  const {item:largeReport}=await report({action:'report',definition:large});
  const {item:board}=await report({action:'dashboard',teamVisible:true,definition:{name:'Regional pipeline',cards:[{reportId:largeReport.id}]}});
  const start=performance.now();
  const {result:ownerTotals}=await report({action:'preview',definition:large});
  assert.deepEqual(Object.fromEntries(ownerTotals.rows.map(row=>[row.key,row.value])),{[east]:'300000',[west]:'200000'});
  const split=performance.now();
  const {cards}=await read(new URLSearchParams({view:'dashboard',id:board.id,workspaceId}));
  assert.deepEqual(cards[0].result.rows.map(row=>[row.key,row.count,row.value]),[[east,'30000','300000']]);
  const elapsed=Math.round(performance.now()-split);
  const {result:selected}=await report({action:'preview',definition:{...large,teamId:pod}});
  assert.deepEqual([selected.count,selected.total],['30000','300000']);
  console.log('50,000 fictional deals, two regional teams: owner report',Math.round(split-start),'ms; scoped manager dashboard',elapsed,'ms.');
}
