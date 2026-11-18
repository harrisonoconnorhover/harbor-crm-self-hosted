import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export async function verifyPortableRateLimits({source,replica,sourceOrigin,replicaOrigin,sourceOwner,replicaOwner,other,record,otherRecord,sql,prepareSignIn,restartSource}){
  const [owner]=await sql`SELECT id FROM login_identities WHERE email='owner@example.test'`;
  const minute=()=>Math.floor(Date.now()/60_000);
  async function seed(scope,subject,used,offset=1){
    await sql`INSERT INTO portable_request_budgets(scope,subject,minute,used) VALUES(${scope},${subject},${minute()+offset},${used})
      ON CONFLICT(scope,subject) DO UPDATE SET minute=excluded.minute,used=excluded.used`;
  }
  async function used(scope,subject){
    const [row]=await sql`SELECT used FROM portable_request_budgets WHERE scope=${scope} AND subject=${subject}`;
    return row?.used;
  }
  function statuses(responses,expected){
    assert.deepEqual(responses.map(response=>response.status).sort(),[...expected].sort());
    for(const response of responses.filter(result=>result.status===429)){
      assert.equal(response.headers.get('retry-after'),'60');
      assert.match(response.headers.get('cache-control'),/no-store/);
    }
  }

  await seed('login_start','',29);
  const start='/auth/google/start';
  const probes=await Promise.all([source(start,{method:'HEAD'}),replica(start,{method:'HEAD'}),source(start,{method:'POST'})]);
  statuses(probes,[405,405,405]);
  for(const probe of probes){
    assert.equal(probe.headers.get('allow'),'GET');
    assert.match(probe.headers.get('cache-control')??'',/no-store/);
    assert.deepEqual(probe.headers.getSetCookie(),[]);
  }
  assert.equal(await used('login_start',''),29);
  const starts=await Promise.all([
    source(start,{headers:{'x-forwarded-for':'198.51.100.3'}}),
    replica(start,{headers:{'x-forwarded-for':'198.51.100.8'}}),
    replica(start,{headers:{'cf-connecting-ip':'198.51.100.10'}}),
  ]);
  statuses(starts,[303,429,429]);
  assert.equal(await used('login_start',''),30);
  await seed('login_start','',0);
  await seed('login_callback','',59);
  const callback='/auth/google/callback?error=access_denied';
  statuses(await Promise.all([source(callback),replica(callback)]),[303,303]);
  assert.equal(await used('login_callback',''),59);
  const attempt=await prepareSignIn('owner@example.test',source,sourceOrigin);
  const headCallback=await source(attempt.path,{method:'HEAD',headers:attempt.headers});
  assert.equal(headCallback.status,405);
  assert.equal(headCallback.headers.get('allow'),'GET');
  assert.deepEqual(headCallback.headers.getSetCookie(),[]);
  assert.equal(await used('login_callback',''),59);
  const wrong='/auth/google/callback?'+new URLSearchParams({code:'fixture-code',state:'A'.repeat(43)});
  const invalid=await Promise.all([source(attempt.path),source(wrong,{headers:attempt.headers}),replica(attempt.path,{headers:attempt.headers})]);
  for(const rejected of invalid){
    assert.equal(rejected.status,303);
    assert.match(rejected.headers.get('location'),/error=sign_in_failed/);
  }
  assert.equal(await used('login_callback',''),59);
  const expired='A'.repeat(43);
  await sql`INSERT INTO portable_login_attempt_uses (state_hash,expires_minute) VALUES (${expired},${minute()-1})`;
  async function logoutNew(send,origin,response){
    assert.equal(response.headers.get('location'),origin+'/');
    const session=response.headers.getSetCookie().find(value=>/^(?:__Host-)?harbor-session=/.test(value));
    assert.ok(session);
    assert.equal((await send('/auth/logout',{method:'POST',headers:{origin,cookie:session.split(';')[0]},
      body:new URLSearchParams({scope:'current'})})).status,303);
  }
  const replay=await Promise.all(Array.from({length:3},()=>source(attempt.path,{headers:attempt.headers})));
  const accepted=replay.filter(response=>response.headers.get('location')===sourceOrigin+'/');
  assert.equal(accepted.length,1);
  assert.equal(replay.filter(response=>response.headers.get('location')?.includes('error=sign_in_failed')).length,2);
  await logoutNew(source,sourceOrigin,accepted[0]);
  assert.equal(await used('login_callback',''),60);
  const receipt=state=>sql`SELECT state_hash FROM portable_login_attempt_uses
    WHERE state_hash=${createHash('sha256').update(state).digest('base64url')}`;
  assert.equal((await receipt(attempt.state)).length,1);
  assert.equal((await sql`SELECT 1 FROM portable_login_attempt_uses WHERE state_hash=${expired}`).length,0);

  const delayed=await prepareSignIn('owner@example.test',replica,replicaOrigin);
  const rejected=await replica(delayed.path,{headers:delayed.headers});
  statuses([rejected],[429]);
  assert.equal(rejected.headers.getSetCookie().length,0);
  assert.equal((await receipt(delayed.state)).length,0);
  await seed('login_callback','',60,-1);
  await logoutNew(replica,replicaOrigin,await replica(delayed.path,{headers:delayed.headers}));
  assert.equal((await receipt(delayed.state)).length,1);

  // Use the same identity in two independent processes with distinct session cookies.
  await seed('api_read',owner.id,119);
  const recordPath='/api/crm?id='+record.id;
  const reads=await Promise.all([
    source(recordPath,{headers:sourceOwner}),
    replica('/api/record-attachments?recordId='+record.id,{headers:replicaOwner}),
    source('/api/background-jobs?recordId='+record.id,{headers:sourceOwner}),
  ]);
  statuses(reads,[200,429,429]);
  assert.equal(await used('api_read',owner.id),120);
  assert.equal((await source('/api/crm?id='+otherRecord.id,{headers:other})).status,200);
  assert.equal((await source(recordPath,{headers:{'oai-authenticated-user-id':owner.id}})).status,401);

  await seed('api_write',owner.id,59);
  const write=(send,headers,origin)=>send('/api/crm',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},
    body:JSON.stringify({action:'save',kind:'contacts',id:record.id,expectedRevision:2,data:{name:'One limited update'}}),
  });
  const foreignWrite=await write(replica,replicaOwner,'https://foreign.example.test');
  assert.equal(foreignWrite.status,403);
  assert.match(foreignWrite.headers.get('cache-control'),/no-store/);
  assert.equal(await used('api_write',owner.id),59);
  statuses(await Promise.all([write(source,sourceOwner,sourceOrigin),write(replica,replicaOwner,replicaOrigin)]),[200,429]);
  assert.equal(await used('api_write',owner.id),60);
  const [updated]=await sql`SELECT revision,data->>'name' AS name FROM contacts WHERE id=${record.id}`;
  assert.deepEqual({...updated},{revision:3,name:'One limited update'});

  await seed('api_read',owner.id,120,-1);
  assert.equal((await replica(recordPath,{headers:replicaOwner})).status,200);
  assert.equal(await used('api_read',owner.id),1);
  await seed('login_start','',30,-1);
  assert.equal((await source(start)).status,303);
  assert.equal(await used('login_start',''),1);

  const duringOutage=await prepareSignIn('owner@example.test',source,sourceOrigin);
  await sql`ALTER TABLE portable_request_budgets RENAME TO fixture_unavailable_budgets`;
  try{
    const failure=await replica(recordPath,{headers:replicaOwner});
    assert.equal(failure.status,503);
    assert.equal(failure.headers.get('retry-after'),'60');
    assert.equal((await source(start)).status,503);
    const blocked=await source(duringOutage.path,{headers:duringOutage.headers});
    assert.equal(blocked.status,503);
    assert.equal(blocked.headers.getSetCookie().length,0);
    assert.equal((await receipt(duringOutage.state)).length,0);
    assert.equal((await source('/healthz')).status,200);
  }finally{
    await sql`ALTER TABLE fixture_unavailable_budgets RENAME TO portable_request_budgets`;
  }
  await logoutNew(source,sourceOrigin,await source(duringOutage.path,{headers:duringOutage.headers}));
  const beforeRestart=await used('login_callback','');
  await restartSource();
  const repeated=await source(duringOutage.path,{headers:duringOutage.headers});
  assert.equal(repeated.status,303);
  assert.match(repeated.headers.get('location'),/error=sign_in_failed/);
  assert.equal(await used('login_callback',''),beforeRestart);
}
