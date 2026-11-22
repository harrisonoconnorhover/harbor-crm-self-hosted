import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {seedMemberSessions} from './portable-member-sessions.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CreateBucketCommand} from '@aws-sdk/client-s3';
import postgres from 'postgres';
import {portableDoctor} from './portable-hosting-fixture.mjs';

async function loopbackPort(){
  const socket=createServer().listen(0,'127.0.0.1');
  await once(socket,'listening');
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  return port;
}

export async function startTestPool({sql,database,directory}){
  const upstream=new URL(database),name=upstream.pathname.slice(1);
  assert.equal(upstream.hostname,'127.0.0.1');
  assert.equal(name,'harbor_identity_test');
  const password=randomBytes(24).toString('hex'),statsPassword=randomBytes(24).toString('hex');
  await sql.unsafe("CREATE ROLE pool_web LOGIN PASSWORD '"+password+"'");
  await sql`GRANT USAGE ON SCHEMA public, drizzle TO pool_web`;
  await sql`GRANT SELECT ON drizzle.__drizzle_migrations TO pool_web`;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pool_web`;
  const port=await loopbackPort();
  const auth=join(directory,'pool-users.txt'),config=join(directory,'pgbouncer.ini');
  await writeFile(auth,'"pool_web" "'+password+'"\n"pool_stats" "'+statsPassword+'"\n',{mode:0o600});
  await writeFile(config,`[databases]
${name} = host=127.0.0.1 port=${upstream.port} dbname=${name}
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = ${port}
unix_socket_dir =
auth_type = scram-sha-256
auth_file = ${auth}
stats_users = pool_stats
pool_mode = transaction
default_pool_size = 4
max_db_connections = 4
max_client_conn = 120
max_prepared_statements = 200
client_tls_sslmode = require
client_tls_key_file = ${process.env.HARBOR_TEST_TLS_KEY}
client_tls_cert_file = ${process.env.PGSSLROOTCERT}
server_tls_sslmode = verify-full
server_tls_ca_file = ${process.env.PGSSLROOTCERT}
`,{mode:0o600});
  let child,ended,log='';
  async function start(){
    child=spawn(process.env.HARBOR_TEST_PGBOUNCER,[config],{stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',chunk=>{log=(log+chunk).slice(-3000);});
    await once(child,'spawn');
    ended=once(child,'close');
  }
  async function disconnect(){
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGQUIT');
    await ended;
  }
  await start();
  const url='postgres://pool_web:'+password+'@127.0.0.1:'+port+'/'+name;
  const stats=postgres('postgres://pool_stats:'+statsPassword+'@127.0.0.1:'+port+'/pgbouncer',
    {ssl:{ca:await readFile(process.env.PGSSLROOTCERT)},max:1,connect_timeout:1,fetch_types:false,prepare:false});
  let stopped=false;
  async function stop(){
    if(stopped)return;
    stopped=true;
    await stats.end({timeout:1});
    await disconnect();
  }
  try{
    for(let i=0;i<40;i++){
      if(child.exitCode!==null)throw Error('Disposable PgBouncer exited: '+log);
      if(await stats.unsafe('SHOW VERSION').simple().then(()=>true,()=>false))break;
      await delay(100);
    }
    const [version]=await stats.unsafe('SHOW VERSION').simple();
    return {url,stats,stop,start,disconnect,version:version.version,emails:Array.from({length:98},(_,i)=>'rep'+i+'@example.test')};
  }catch(error){await stop();throw error;}
}

export async function exercisePooledWorkspace({pool,sql,request,origin,headers,other,fixture,env}){
  await fixture.storage.send(new CreateBucketCommand({Bucket:fixture.bucket}));
  assert.equal(portableDoctor(env,'web').checks.database,'ok');
  for(let i=0;i<60&&(await request('/healthz')).status!==200;i++)await delay(100);
  assert.equal((await request('/healthz')).status,200);
  async function json(response){
    const body=await response.json();
    assert.ok(response.ok,JSON.stringify(body));
    return body;
  }
  const post=(path,auth,data)=>request(path,{method:'POST',headers:{...auth,origin,'content-type':'application/json'},body:JSON.stringify(data)});
  const formId=randomUUID(),embedOrigin='https://fictional.example.test';
  await json(await post('/api/lead-forms',headers,{action:'save',id:formId,revision:0,definition:{
    title:'Pool test form',description:'Test inquiry',captureContacts:true,showMessageOnContact:true,embedOrigin,
  }}));
  await json(await post('/api/lead-forms',headers,{action:'setEnabled',id:formId,revision:1,enabled:true}));
  const embed=await request('/forms/'+formId);
  assert.equal(embed.status,200);
  assert.ok(embed.headers.get('content-security-policy').includes('frame-ancestors '+embedOrigin));
  const owners=[headers,other];
  const teams=await Promise.all(owners.map(async(auth,i)=>{
    await json(await post('/api/crm',auth,{action:'save',kind:'contacts',data:{name:'Workspace '+i}}));
    return (await json(await request('/api/workspaces',{headers:auth}))).owned;
  }));
  assert.ok(teams[0]&&teams[1]&&teams[0]!==teams[1]);
  const people=owners.map((headers,team)=>({headers,team,writePath:'/api/crm',readScope:''}));
  for(const {headers,team,grant} of await seedMemberSessions(sql,teams,pool.emails)){
    people.push({headers,team,grant,writePath:'/api/crm?workspaceId='+teams[team]+'&grantId='+grant,readScope:'&workspaceId='+teams[team]});
  }
  for(const [team,workspace] of teams.entries()){
    await sql`INSERT INTO contacts(workspace_id,id,revision,data,created_at,updated_at)
      SELECT ${workspace}::uuid,gen_random_uuid(),1,jsonb_build_object('name',${'Team '+team+' contact '}::text || i),now(),now()
      FROM generate_series(1,100000) i`;
    await sql`CHECKPOINT`;
  }
  await sql`ANALYZE contacts`;
  const replicaPort=await loopbackPort(),replicaOrigin='http://127.0.0.1:'+replicaPort;
  const replica=spawn(process.execPath,['scripts/portable-web.mjs','start'],{
    env:{...env,PORT:String(replicaPort),HARBOR_LOGIN_ORIGIN:replicaOrigin},stdio:'ignore',
  });
  const closed=once(replica,'close');
  try{
    for(let i=0;i<80;i++){
      if(replica.exitCode!==null)throw Error('Second web app exited before becoming ready.');
      if(await fetch(replicaOrigin+'/healthz').then(r=>r.ok,()=>false))break;
      await delay(100);
    }
    assert.ok((await fetch(replicaOrigin+'/healthz')).ok);
    await exerciseTraffic();
  }finally{if(replica.exitCode===null&&replica.signalCode===null)replica.kill();await closed;}

  async function exerciseTraffic(){
    const timings=new Map();
    async function measure(label,run){
      const start=performance.now();
      const result=await run();
      timings.get(label).push(performance.now()-start);
      return result;
    }
    const activities=['visible and restricted searches','contact edit','filtered list','contact detail'];
    for(const label of ['create','detail and isolation','two list pages',...activities])timings.set(label,[]);
    // Two separate businesses keep contacts with the same email.
    const emailFor=i=>'rep'+Math.floor(i/2)+'@example.test';
    const departmentFor=i=>'Fictional division '+Math.floor(i/2)+' confidential';
    const hosts=[origin,replicaOrigin];
    function read(host,path,headers){
      return fetch(host+path,{headers,redirect:'manual',signal:AbortSignal.timeout(15000)}).then(json);
    }
    function save(host,path,headers,data){
      return fetch(host+path,{method:'POST',headers:{...headers,origin:host,'content-type':'application/json'},
        body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
    }
    const records=await Promise.all(people.map(({headers,writePath,team},i)=>measure('create',async()=>{
      const result=await json(await save(hosts[i%2],writePath,headers,{action:'save',kind:'contacts',data:{name:'Team '+team+' rep '+i,email:emailFor(i),department:departmentFor(i)}}));
      return result.record;
    })));
    assert.equal(new Set(records.map(r=>r.id)).size,100);
    await Promise.all(people.map(({headers,readScope,team},i)=>measure('detail and isolation',async()=>{
      const record=await read(hosts[1-i%2],'/api/crm?kind=contacts&id='+records[i].id+readScope,headers);
      assert.equal(record.data.name,'Team '+team+' rep '+i);
      const denied=await request('/api/crm?kind=contacts&id='+records[i^1].id+'&workspaceId='+teams[1-team],{headers});
      assert.equal(denied.status,404);
    })));
    await Promise.all(people.map(({headers,readScope,team},i)=>measure('two list pages',async()=>{
      const path='/api/crm?kind=contacts&limit=20'+readScope;
      const first=await read(hosts[i%2],path,headers);
      assert.ok(first.next);
      const second=await read(hosts[1-i%2],path+'&after='+encodeURIComponent(first.next),headers);
      const both=first.records.concat(second.records);
      assert.equal(both.length,40);
      assert.equal(new Set(both.map(r=>r.id)).size,40);
      assert.ok(both.every(r=>r.data.name.startsWith('Team '+team+' ')||r.data.name==='Workspace '+team));
    })));
    await Promise.all(owners.map((headers,i)=>save(hosts[i],'/api/custom-properties',headers,{action:'standardAccess',
      kind:'contacts',id:'department',audience:'owner',expectedRevision:0}).then(json)));
    function search(host,person,query){
      const path='/api/crm/search'+(person.readScope?'?workspaceId='+teams[person.team]:'');
      return save(host,path,person.headers,{query,kind:'contacts'}).then(json);
    }
    // Each person does all four ordinary operations, starting at different points
    // and alternating replicas. Both workspaces take part in every activity.
    await Promise.all(people.map(async(person,i)=>{
      const {headers,team,readScope,writePath}=person;
      for(let turn=0;turn<activities.length;turn++){
        const activity=activities[(Math.floor(i/2)+turn)%activities.length];
        const host=hosts[(i+turn)%2];
        await measure(activity,async()=>{
          const record=records[i];
          if(activity==='visible and restricted searches'){
            const result=await search(host,person,emailFor(i));
            assert.equal(result.total,1);
            assert.deepEqual(result.results.map(row=>row.id),[record.id]);
            const restricted=await search(host,person,departmentFor(i));
            assert.equal(restricted.total,person.grant?0:1);
            assert.deepEqual(restricted.results.map(row=>row.id),person.grant?[]:[record.id]);
          }else if(activity==='contact edit'){
            const {record:updated}=await json(await save(host,writePath,headers,{action:'save',kind:'contacts',
              id:record.id,expectedRevision:record.revision,data:{name:record.data.name,email:emailFor(i),title:'Territory rep '+i}}));
            assert.equal(updated.revision,record.revision+1);
            records[i]=updated;
          }else if(activity==='filtered list'){
            const prefix='Team '+team+' contact 91';
            const result=await read(host,'/api/crm?kind=contacts&limit=10&search='+encodeURIComponent(prefix)+readScope,headers);
            assert.equal(result.records.length,10);
            assert.ok(result.next);
            assert.ok(result.records.every(row=>row.data.name.startsWith(prefix)));
          }else{
            const current=await read(host,'/api/crm?kind=contacts&id='+record.id+readScope,headers);
            assert.equal(current.revision,record.revision);
            assert.equal(current.data.email,emailFor(i));
            assert.equal(current.data.department,person.grant?undefined:departmentFor(i));
          }
        });
      }
    }));
    const edits=await sql`SELECT count(*)::int AS n FROM contacts WHERE workspace_id IN (${teams[0]},${teams[1]})
      AND revision=2 AND data->>'title' LIKE 'Territory rep %' AND data->>'department' LIKE 'Fictional division % confidential'`;
    assert.equal(edits[0].n,people.length);
    const saved=records[0];
    const concurrent=await Promise.all([people[0],people[2]].map(({headers,writePath},i)=>save(hosts[i],writePath,headers,{
      action:'save',kind:'contacts',id:saved.id,expectedRevision:saved.revision,data:{name:'Edit '+i,email:saved.data.email},
    })));
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
    const [row]=(await pool.stats.unsafe('SHOW POOLS').simple()).filter(x=>x.user==='pool_web'&&x.database==='harbor_identity_test');
    const backends=['sv_active','sv_idle','sv_used','sv_tested','sv_login'].reduce((sum,k)=>sum+Number(row[k]),0);
    assert.ok(backends>0&&backends<=4);
    assert.ok(Number(row.cl_active)>backends,'Web connections must outnumber PostgreSQL backends.');
    console.log(pool.version+'; 100 sessions, two web processes, two workspaces with 100,000 seeded contacts each; '+
      row.cl_active+' web connections, '+backends+' server connections.');
    for(const [phase,times] of timings){
      times.sort((a,b)=>a-b);
      console.log(phase+' p95 '+Math.round(times[Math.ceil(0.95*times.length)-1])+' ms');
    }
    const editors=[people[2],people[4]];
    assert.ok(editors.every(person=>person.team===0));
    const policy={view:'none',edit:'none',create:false,delete:false};
    await json(await save(replicaOrigin,'/api/workspaces',owners[0],{action:'tool_permissions',
      ids:editors.map(person=>person.grant),tool:'contacts',policy}));
    const sharedContact='/api/crm?kind=contacts&id='+saved.id+'&workspaceId='+teams[0];
    async function checkChangedAccess(){
      for(const host of hosts){
        await Promise.all(editors.map(async person=>{
          const hidden=await fetch(host+sharedContact,{headers:person.headers});
          assert.equal(hidden.status,404);await hidden.body?.cancel();
          const result=await search(host,person,emailFor(0));
          assert.equal(result.total,0);assert.deepEqual(result.results,[]);
          const stale=await save(host,person.writePath,person.headers,{action:'save',kind:'contacts',
            id:saved.id,expectedRevision:saved.revision+1,data:{name:'Change from an outdated grant'}});
          assert.equal(stale.status,403);await stale.body?.cancel();
        }));
        const found=await search(host,people[6],emailFor(0));
        assert.deepEqual(found.results.map(row=>row.id),[saved.id]);
        const allowed=await read(host,sharedContact,people[6].headers);
        assert.equal(allowed.revision,saved.revision+1);
        assert.equal(allowed.data.name,'Edit '+concurrent.findIndex(r=>r.ok));
      }
    }
    await checkChangedAccess();
    await pool.disconnect();
    await delay(1200);
    const unavailable=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(9000)});
    assert.equal(unavailable.status,503);
    await pool.start();
    for(const host of hosts){
      let ready=false;
      for(let i=0;i<25&&!ready;i++){
        ready=await fetch(host+'/healthz',{signal:AbortSignal.timeout(7000)}).then(r=>r.ok);
        if(!ready)await delay(200);
      }
      assert.ok(ready,'Web app should reconnect after the pool restarts.');
      const record=await read(host,'/api/crm?kind=contacts&id='+saved.id,people[0].headers);
      assert.equal(record.revision,saved.revision+1);
      assert.equal(record.data.name,'Edit '+concurrent.findIndex(r=>r.ok));
    }
    await checkChangedAccess();
  }
}
