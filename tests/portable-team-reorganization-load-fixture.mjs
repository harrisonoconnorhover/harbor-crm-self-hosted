import assert from 'node:assert/strict';

// Reuse all 100 signed-in sessions from mixed traffic, including its revoked rep.
export async function verifyTeamReorganization({request,origin,sql,readers,workspaceId}){
  const owner=readers[0], reps=readers.filter(r=>r.scope==='owned');
  const revoked=reps.at(-1), managers=readers.filter(r=>r.scope==='all'&&r.email);
  const west=crypto.randomUUID(), east=crypto.randomUUID(), pod=crypto.randomUUID(), leaf=crypto.randomUUID();
  const directory=await sql`SELECT u.email,u.id AS actor,m.id AS grant FROM portable_workspace_viewers m
    JOIN login_identities u ON u.id=m.viewer_id WHERE m.workspace_id=${workspaceId}`;
  const membership=new Map(directory.map(row=>[row.email,row]));
  assert.equal(membership.has(revoked.email),false);
  async function post(auth,path,body){
    return request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  }
  async function change(body){
    const r=await post(owner.auth,'/api/workspaces',body);
    assert.equal(r.status,200,await r.text());
  }
  for(const [id,name,parentId] of [[west,'West',null],[east,'East',null],[pod,'Field sales',west],[leaf,'Enterprise',pod]]){
    await change({action:'team_create',id,name,parentId});
  }
  const managerTeams=new Map(managers.map((r,i)=>[r,i%2?east:west]));
  for(const team of [west,east]){
    const emails=managers.filter(r=>managerTeams.get(r)===team).map(r=>r.email);
    await sql`UPDATE portable_workspace_viewers m SET team_id=${team},view_scope='team',edit_scope='team'
      FROM login_identities u WHERE m.workspace_id=${workspaceId} AND u.id=m.viewer_id AND u.email=ANY(${emails}::text[])`;
  }
  const deals=[];
  for(const [i,team] of [west,east,leaf].entries()){
    const rep=membership.get(reps[i].email);
    await change({action:'team_assign',id:rep.grant,teamId:team,previousTeamId:null});
    const r=await post(owner.auth,'/api/crm',{action:'save',kind:'deals',assigneeId:rep.actor,data:{name:'Territory rehearsal '+i}});
    assert.equal(r.status,201,await r.clone().text());
    deals.push((await r.json()).record);
  }
  const reparented=deals[2];
  const path=(reader,id)=>'/api/crm?'+new URLSearchParams({kind:'deals',...(reader===owner?{}:{workspaceId}),
    ...(id?{id}:{search:'Territory rehearsal'})});
  async function readWave(parent){
    const timings=await Promise.all(readers.map(async reader=>{
      const start=performance.now();
      const r=await request(path(reader,reader===revoked?reparented.id:null),{headers:reader.auth});
      if(reader===revoked)assert.equal(r.status,404,await r.text());
      else {
        assert.equal(r.status,200,await r.clone().text());
        const team=managerTeams.get(reader);
        const expected=team?deals.filter((_,i)=>[west,east,parent][i]===team)
          :reader.scope==='owned'?deals.filter((_,i)=>reps[i]===reader):deals;
        assert.deepEqual((await r.json()).records.map(d=>d.id).sort(),expected.map(d=>d.id).sort());
      }
      return performance.now()-start;
    }));
    timings.sort((a,b)=>a-b);
    console.log('Nested-team move: '+readers.length+' simultaneous sessions, pod under '+(parent===west?'West':'East')+', p95 '+Math.round(timings[Math.ceil(timings.length*.95)-1])+' ms');
  }
  async function checkGlobalSearch(reader,expected){
    const r=await post(reader.auth,'/api/crm/search?'+new URLSearchParams({workspaceId}),{kind:'deals',query:'Territory rehearsal'});
    assert.equal(r.status,200,await r.clone().text());
    const result=await r.json();
    assert.equal(result.total,expected.length);
    assert.deepEqual(result.results.map(row=>row.id).sort(),expected.map(row=>row.id).sort());
  }
  const prior=managers[0],next=managers[1];
  const opened=await request(path(prior,reparented.id),{headers:prior.auth});
  assert.equal(opened.status,200,await opened.clone().text());
  const record=await opened.json();
  assert.equal(record.id,reparented.id);
  const update={action:'save',kind:'deals',id:record.id,expectedRevision:record.revision,data:{name:'Territory rehearsal transferred'}};
  const writePath=reader=>'/api/crm?'+new URLSearchParams({workspaceId,grantId:membership.get(reader.email).grant});
  await readWave(west);
  await checkGlobalSearch(prior,[deals[0],reparented]);
  await checkGlobalSearch(next,[deals[1]]);
  await change({action:'team_edit',id:pod,name:'Field sales',parentId:east,revision:1});
  await readWave(east);
  await checkGlobalSearch(prior,[deals[0]]);
  await checkGlobalSearch(next,[deals[1],reparented]);
  const oldDetail=await request(path(prior,record.id),{headers:prior.auth});
  assert.equal(oldDetail.status,404,await oldDetail.text());
  const denied=await post(prior.auth,writePath(prior),update);
  assert.ok([403,404].includes(denied.status),await denied.text());
  const accepted=await post(next.auth,writePath(next),update);
  assert.equal(accepted.status,200,await accepted.clone().text());
  assert.equal((await accepted.json()).record.revision,record.revision+1);
  const checked=await request(path(owner,record.id),{headers:owner.auth});
  assert.equal(checked.status,200,await checked.clone().text());
  assert.equal((await checked.json()).data.name,update.data.name);
}
