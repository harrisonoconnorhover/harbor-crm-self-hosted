import assert from 'node:assert/strict';

export async function verifySharedToolGates({request,origin,headers,other,sql}){
  const workspaceApi='/api/workspaces',reportApi='/api/reporting';
  const read=path=>request(path,{headers:other});
  const write=(path,body,auth=headers)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  async function json(res,status=200){
    assert.equal(res.status,status,await res.clone().text());
    return res.json();
  }
  const grant=async()=>(await sql`SELECT m.id,m.workspace_id,m.tool_policies FROM portable_workspace_viewers m
    JOIN private_workspaces w ON w.id=m.workspace_id JOIN login_identities member ON member.id=m.viewer_id
    JOIN login_identities owner ON owner.id=w.owner_id WHERE owner.email='owner@example.test' AND member.email='other@example.test'`)[0];
  const initial=await grant();
  assert.ok(initial);
  const workspaceId=initial.workspace_id,scope='&workspaceId='+workspaceId;
  const booking=async()=>workspaceApi+'?team=booking'+scope+'&grantId='+(await grant()).id;
  const screen=view=>'/?view='+view+scope;
  const set=async(tool,view,edit='none')=>json(await write(workspaceApi,{action:'tool_permissions',ids:[(await grant()).id],tool,
    policy:{view,edit,create:false,delete:false}}));
  const report=(await json(await write(reportApi,{action:'report',definition:{name:'Fictional visibility report',kind:'contacts',groupBy:'lifecycle'}}),201)).item;
  const dashboard=(await json(await write(reportApi,{action:'dashboard',teamVisible:true,definition:{name:'Fictional shared board',cards:[{reportId:report.id,wide:false}]}}),201)).item;
  const list=reportApi+'?view=dashboards'+scope,detail=reportApi+'?view=dashboard&id='+dashboard.id+scope;
  const records=reportApi+'?view=dashboardRecords&id='+dashboard.id+'&reportId='+report.id+scope;
  try{
    const ownerHostList=async()=>(await json(await request(workspaceApi+'?team=booking'+scope+'&hostSearch=other%40example.test',{headers}))).hosts;
    const initialSchedule=await json(await read(await booking()));
    const at=new Date(Date.now()+86400000);at.setUTCSeconds(0,0);
    const windows=[{start:at.toISOString(),end:new Date(+at+3600000).toISOString()}];
    await json(await write(await booking(),{action:'offer',windows,revision:initialSchedule.revision},other));
    const [host]=await ownerHostList();
    assert.ok(host);
    assert.equal((await json(await read(detail))).cards[0].definition.name,report.definition.name);
    await set('reports','none');
    assert.equal((await read(screen('reports'))).status,404);
    assert.equal((await read(screen('custom-objects')+'&summary=1')).status,404);
    const empty=await json(await read(detail));
    assert.deepEqual(empty.cards,[]);
    assert.deepEqual(empty.item.definition.cards,[]);
    assert.equal((await read(records)).status,404);

    await set('reports','all');
    await set('dashboards','none');
    for(const path of [list,detail,records,screen('dashboards')])assert.equal((await read(path)).status,404,path);
    const reports=await read(screen('reports'));
    assert.equal(reports.status,200);
    assert.ok(!(await reports.text()).includes(dashboard.definition.name));

    await set('goals','none');
    assert.equal((await read(screen('goals'))).status,404);
    const forecast=await read(screen('forecast'));
    assert.equal(forecast.status,200);
    assert.doesNotMatch((await forecast.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''),/>Revenue goal</);

    await set('goals','all');
    await set('forecast','none');
    assert.equal((await read(screen('forecast'))).status,404);
    const goals=await read(screen('goals'));
    assert.equal(goals.status,200);
    assert.doesNotMatch((await goals.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''),/>Weighted open pipeline</);

    await set('meetings','all','none');
    const schedule=await json(await read(await booking()));
    assert.equal(schedule.canEditAvailability,false);
    assert.deepEqual(schedule.windows,windows);
    assert.equal((await ownerHostList())[0].id,host.id,'An unrelated permission change keeps the existing host and availability.');
    for(const input of [{action:'offer',windows:[]},{action:'weekly',hours:null},{action:'timeOff',operation:'add',
      period:{from:'2031-04-06',through:'2031-04-06',timeZone:'UTC',pauseLeadRouting:false}}]){
      assert.equal((await write(await booking(),{...input,revision:schedule.revision},other)).status,403);
    }
    await set('meetings','none');
    assert.equal((await read(screen('meetings'))).status,404);
    assert.equal((await read(await booking())).status,403);
    assert.deepEqual(await ownerHostList(),[]);
    await set('meetings','all','all');
    const reopened=await json(await read(await booking()));
    assert.equal(reopened.canEditAvailability,true);
    assert.equal((await ownerHostList())[0].id,host.id);
    assert.equal((await write(await booking(),{action:'offer',windows:[],revision:reopened.revision},other)).status,200);
  }finally{
    await sql`UPDATE portable_workspace_viewers SET tool_policies=${sql.json(initial.tool_policies)}
      WHERE workspace_id=${workspaceId} AND viewer_id=(SELECT id FROM login_identities WHERE email='other@example.test')`;
    await json(await write(reportApi,{action:'deleteDashboard',id:dashboard.id,revision:dashboard.revision}));
    await json(await write(reportApi,{action:'deleteReport',id:report.id,revision:report.revision}));
  }
}
