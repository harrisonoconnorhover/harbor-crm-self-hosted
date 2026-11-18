import assert from 'node:assert/strict';
import {execFile,execFileSync,spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createConnection,createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {applyPortableMigrations,readPortableMigrations} from '../runtime/portable-migrations.mjs';
import {portableMaintenanceLock} from '../runtime/portable-config.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {checkStandalone} from '../scripts/check-standalone.mjs';
import {verifyHostedPortableInbox} from './portable-gmail-inbox-fixture.mjs';
import {verifyPortableRateLimits} from './portable-rate-limit-fixture.mjs';
import {verifyPortableReplicaRevocation} from './portable-sharing-fixture.mjs';

const execute=promisify(execFile);
const command=process.env.HARBOR_TEST_PORTABLE_COMMAND||'scripts/portable-web.mjs';
const cwd=process.env.HARBOR_TEST_PORTABLE_CWD;

export function portableDoctor(env,profile,code=0,providerProbe,probeFlag=providerProbe?'--check-google':undefined,...additionalFlags){
  const args=[...(providerProbe?['--import',providerProbe]:[]),command,'doctor',profile,...(probeFlag?[probeFlag]:[]),...additionalFlags];
  const child=spawnSync(process.execPath,args,{env,cwd,timeout:8000,encoding:'utf8'});
  assert.equal(child.error,undefined);
  assert.equal(child.status,code,child.stderr);
  assert.equal(child.stderr,'');
  const report=JSON.parse(child.stdout);
  assert.equal(report.profile,profile);
  assert.equal(report.result,code?'needs_setup':'ready');
  for(const value of [env.DATABASE_URL,env.HARBOR_LOGIN_GOOGLE_CLIENT_ID,env.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET,
    env.HARBOR_LOGIN_ALLOWED_EMAILS,env.HARBOR_S3_ENDPOINT,env.HARBOR_S3_SECRET_ACCESS_KEY,env.HARBOR_PORTABLE_GMAIL_OWNER,
    env.HARBOR_PORTABLE_GMAIL_CLIENT_ID,env.HARBOR_PORTABLE_GMAIL_CLIENT_SECRET,env.HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN,
    env.HARBOR_PORTABLE_CALENDAR_OWNER,env.HARBOR_PORTABLE_CALENDAR_CLIENT_ID,env.HARBOR_PORTABLE_CALENDAR_CLIENT_SECRET,
    env.HARBOR_PORTABLE_CALENDAR_REFRESH_TOKEN,env.HARBOR_PORTABLE_INBOX_OWNER,env.HARBOR_PORTABLE_INBOX_CLIENT_ID,
    env.HARBOR_PORTABLE_INBOX_CLIENT_SECRET,env.HARBOR_PORTABLE_INBOX_REFRESH_TOKEN,
    env.HARBOR_PORTABLE_PERSONAL_GOOGLE_KEY,env.HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_ID,env.HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_SECRET,
    env.HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_ID,env.HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_SECRET]){
    if(value)assert.ok(!child.stdout.includes(value));
  }
  return report;
}

function gmailDoctorFixture({status=200,token,mailbox,requests,prefix='HARBOR_PORTABLE_GMAIL'}){
  return 'data:text/javascript,'+encodeURIComponent(`
    import assert from 'node:assert/strict';
    const seen=[];
    process.on('exit',()=>assert.deepEqual(seen,${JSON.stringify(requests)}));
    globalThis.fetch=async (url,options)=>{
      seen.push(url);
      assert.equal(options.redirect,'manual');
      assert.ok(options.signal instanceof AbortSignal);
      if(url==='https://oauth2.googleapis.com/token'){
        assert.equal(options.method,'POST');
        assert.equal(options.body.get('grant_type'),'refresh_token');
        const prefix=${JSON.stringify(prefix)};
        assert.equal(options.body.get('refresh_token'),process.env[prefix+'_REFRESH_TOKEN']);
        assert.equal(options.body.get('client_id'),process.env[prefix+'_CLIENT_ID']);
        assert.equal(options.body.get('client_secret'),process.env[prefix+'_CLIENT_SECRET']);
        return Response.json(${JSON.stringify(token ?? null)},{status:${status}});
      }
      assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress');
      assert.equal(options.method,undefined);
      assert.equal(options.headers.authorization,'Bearer fictional-doctor-access');
      return Response.json({emailAddress:${JSON.stringify(mailbox ?? '')}});
    };
  `);
}

const personalGoogleSettings={
  HARBOR_PORTABLE_PERSONAL_GOOGLE_ENABLED:'true',
  HARBOR_PORTABLE_PERSONAL_GOOGLE_KEY:Buffer.alloc(32,54).toString('base64url'),
  HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_ID:'',HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_SECRET:'',
  HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_ID:'',HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_SECRET:'',
};
const personalGmailSettings={HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_ID:'fictional-personal-gmail-doctor-client',
  HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_SECRET:'fictional-personal-gmail-doctor-secret'};
const personalCalendarSettings={HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_ID:'fictional-personal-calendar-doctor-client',
  HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_SECRET:'fictional-personal-calendar-doctor-secret'};

function verifyPersonalGoogleDoctor(env,settings,expected,code=0){
  const report=portableDoctor({...env,...personalGoogleSettings,...settings},'web',code,gmailDoctorFixture({requests:[]}),null);
  const {personalGmail,personalCalendar,personalGoogle}=report.checks;
  assert.deepEqual([personalGmail,personalCalendar,personalGoogle],expected);
  const origin=env.HARBOR_LOGIN_ORIGIN;
  assert.deepEqual(report.personalGoogleCallbackUrls,personalGmail==='origin'?undefined:{
    gmail:origin+'/api/google/gmail/callback',calendar:origin+'/api/google/calendar/callback',
  });
  return report;
}

function googleDoctorFixture(tokenStatus,keysBody){
  return 'data:text/javascript,'+encodeURIComponent(`
    import assert from 'node:assert/strict';
    const original=globalThis.fetch;
    globalThis.fetch=async (url,options)=>{
      if(!['https://oauth2.googleapis.com/token','https://www.googleapis.com/oauth2/v3/certs'].includes(url))
        return original(url,options);
      assert.equal(options.method,'GET');
      assert.equal(options.credentials,'omit');
      assert.equal(options.redirect,'manual');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.body,undefined);
      assert.equal(options.headers,undefined);
      if(url==='https://oauth2.googleapis.com/token')return new Response('private fixture reply',{status:${tokenStatus}});
      return new Response(${JSON.stringify(keysBody)});
    };
  `);
}

export async function verifyPortableMigrations(env,sql,directory){
  const folder=fileURLToPath(new URL('../db/postgres/migrations',import.meta.url));
  const migrations=readPortableMigrations(folder),prefix=migrations.slice(0,-1);
  const cli=()=>execFileSync(process.execPath,[command,'migrate'],{env,cwd,timeout:10000,stdio:'pipe',encoding:'utf8'});
  const ledger=async()=>Array.from(await sql`SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
  assert.equal(portableDoctor(env,'worker',1).checks.database,'migration_required');
  if(process.env.HARBOR_TEST_MONITOR_ROLE==='true'){
    const name='harbor_encoding_probe';
    const url=new URL(env.DATABASE_URL);
    url.pathname='/'+name;
    await sql`CREATE DATABASE ${sql(name)} WITH TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'`;
    const incompatible={...env,DATABASE_URL:url.href};
    const probe=postgres(url.href,{max:1,onnotice:()=>{}});
    try{
      assert.equal(portableDoctor(incompatible,'worker',1).checks.database,'unsupported_database_encoding');
      assert.throws(()=>execFileSync(process.execPath,[command,'migrate'],{env:incompatible,cwd,timeout:10000,stdio:'pipe'}),
        error=>/Use a UTF-8 PostgreSQL database/.test(error.stderr));
      assert.equal((await probe`SELECT to_regclass('drizzle.__drizzle_migrations') AS ledger`)[0].ledger,null);
    }finally{
      await probe.end({timeout:3});
      await sql`DROP DATABASE ${sql(name)}`;
    }
  }
  const prior=join(directory,'prior-migrations');
  await mkdir(join(prior,'meta'),{recursive:true});
  const journal=JSON.parse(await readFile(join(folder,'meta','_journal.json'),'utf8'));
  journal.entries.pop();
  await Promise.all(journal.entries.map(({tag})=>copyFile(join(folder,tag+'.sql'),join(prior,tag+'.sql'))));
  await writeFile(join(prior,'meta','_journal.json'),JSON.stringify(journal));
  const legacy=postgres(env.DATABASE_URL,{max:1,onnotice:()=>{}});
  try{await migrate(drizzle(legacy),{migrationsFolder:prior});}
  finally{await legacy.end({timeout:3});}
  assert.equal(portableDoctor(env,'worker',1).checks.database,'migration_required');
  const before=await ledger();
  assert.equal(before.length,prefix.length);
  await assert.rejects(applyPortableMigrations(sql,[...prefix,{...migrations.at(-1),sql:[
    'CREATE TABLE public.migration_rollback_probe(id integer)','SELECT * FROM public.invalid_migration_probe',
  ]}]),/invalid_migration_probe/);
  assert.equal((await sql`SELECT to_regclass('public.migration_rollback_probe') AS probe`)[0].probe,null);
  assert.deepEqual(await ledger(),before);
  await sql.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(${portableMaintenanceLock})`;
    assert.throws(cli,error=>/worker, migration or restore holds the database lock/.test(error.stderr));
  });
  assert.deepEqual(await ledger(),before);
  assert.match(cli(),/migrations applied/);
  assert.match(cli(),/migrations applied/);
  const complete=await ledger();
  assert.equal(complete.length,migrations.length);
  assert.deepEqual(complete.slice(0,-1),before);
  assert.equal(portableDoctor(env,'worker').checks.database,'ok');
  const worker=postgres(env.DATABASE_URL,{max:1,onnotice:()=>{}});
  try{
    const [{locked}]=await worker`SELECT pg_try_advisory_lock_shared(${portableMaintenanceLock}) AS locked`;
    assert.equal(locked,true);
    assert.match(cli(),/migrations applied/);
    const next=[...migrations,{
      folderMillis:migrations.at(-1).folderMillis+1,hash:'fictional-next-migration',
      sql:['CREATE TABLE public.migration_shared_lock_probe(id integer)'],
    }];
    assert.equal(await applyPortableMigrations(sql,next),'maintenance_in_progress');
    assert.equal((await sql`SELECT to_regclass('public.migration_shared_lock_probe') AS probe`)[0].probe,null);
    assert.deepEqual(await ledger(),complete);
  }finally{await worker.end({timeout:3});}

  const first=complete[0],last=complete.at(-1);
  await sql`UPDATE drizzle.__drizzle_migrations SET hash='fictional-different-migration' WHERE id=${first.id}`;
  try{
    assert.equal(portableDoctor(env,'worker',1).checks.database,'migration_history_mismatch');
    assert.throws(()=>execFileSync(process.execPath,[command,'worker','--once'],{env,cwd,timeout:6000,stdio:'pipe'}),
      error=>/could not start \(migration_history_mismatch\)/.test(error.stderr));
    assert.throws(cli,error=>/migration history differs/.test(error.stderr));
    assert.equal((await ledger()).length,migrations.length);
  }finally{await sql`UPDATE drizzle.__drizzle_migrations SET hash=${first.hash} WHERE id=${first.id}`;}
  await sql`DELETE FROM drizzle.__drizzle_migrations WHERE id=${first.id}`;
  try{
    assert.equal(portableDoctor(env,'worker',1).checks.database,'migration_history_mismatch');
    assert.throws(cli,error=>/migration history differs/.test(error.stderr));
  }finally{
    await sql`INSERT INTO drizzle.__drizzle_migrations(id,hash,created_at) VALUES (${first.id},${first.hash},${first.created_at})`;
  }
  const [{id}]=await sql`INSERT INTO drizzle.__drizzle_migrations(hash,created_at)
    VALUES ('fictional-later-migration',${Number(last.created_at)+1}) RETURNING id`;
  try{assert.throws(cli,error=>/requires a newer Harbor release/.test(error.stderr));}
  finally{await sql`DELETE FROM drizzle.__drizzle_migrations WHERE id=${id}`;}
  assert.deepEqual(await ledger(),complete);
}

async function verifyPrivateFileDoctor(env,virtual=false){
 const key='contact-files/'+Array.from({length:4},()=>randomUUID()).join('/');
 const bucket='fictional-private-bucket',hostname='storage.harbor.test',virtualHost=bucket+'.'+hostname;
 const path=virtual?'/'+key:'/'+bucket+'/'+key,bucketPath=virtual?'/':'/'+bucket+'/',requests=[];
 let unsignedStatus=403,fixtureExists=true;
 const handler=(request,response)=>{
  requests.push({method:request.method,path:request.url,host:request.headers.host,authorization:request.headers.authorization,
   cookie:request.headers.cookie,range:request.headers.range});
  if(request.method==='HEAD'&&request.headers.authorization){
   if(request.url===path&&fixtureExists){response.writeHead(200,{'content-length':'1'}).end();return;}
   if(request.url===bucketPath){response.writeHead(200).end();return;}
   response.writeHead(404).end();return;
  }
  if(unsignedStatus===302)response.setHeader('Location','/unexpected-redirect');
  response.writeHead(unsignedStatus).end('fictional response');
 };
 const server=virtual?createHttpsServer({
  key:await readFile(process.env.HARBOR_TEST_TLS_KEY),cert:await readFile(process.env.NODE_EXTRA_CA_CERTS),
 },handler):createHttpServer(handler);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 try{
  const {port}=server.address(),endpoint=virtual?'https://'+hostname+':'+port:'http://127.0.0.1:'+port;
  const expectedHost=(virtual?virtualHost:'127.0.0.1')+':'+port;
  const settings={...env,HARBOR_S3_ENDPOINT:endpoint,HARBOR_S3_BUCKET:bucket,HARBOR_S3_ADDRESSING:virtual?'virtual-hosted':'path-style',
   HARBOR_S3_ACCESS_KEY_ID:'fictional-privacy-key',HARBOR_S3_SECRET_ACCESS_KEY:'fictional-privacy-secret',
   ...(virtual?{HARBOR_PORTABLE_MODE:'hosted',HARBOR_LOGIN_ORIGIN:'https://harbor.example.test'}:{})};
  const preload=virtual?['--import','data:text/javascript,'+encodeURIComponent(`
   import dns from 'node:dns';
   import {syncBuiltinESMExports} from 'node:module';
   const lookup=dns.lookup;
   dns.lookup=(host,...args)=>lookup(host===${JSON.stringify(virtualHost)}?'127.0.0.1':host,...args);
   syncBuiltinESMExports();
  `)]:[];
  const cases=[[403,'ok'],[206,'public_file_readable'],[302,'file_privacy_unverified'],[404,'file_privacy_unverified'],[0,'file_fixture_unavailable']];
  for(const [status,expected] of virtual?cases.slice(0,2):cases){
   requests.length=0;
   unsignedStatus=status;fixtureExists=status!==0;
   const output=await execute(process.execPath,[...preload,command,'doctor','web','--check-file-privacy',key],
    {env:settings,cwd,timeout:8000}).then(value=>({...value,code:0}),error=>error);
   assert.equal(output.code,expected==='ok'?0:1,output.stderr||output.stdout);
   assert.equal(output.stderr,'');
   const report=JSON.parse(output.stdout);
   assert.equal(report.checks.filePrivacy,expected);
   for(const value of [key,bucket,endpoint,settings.HARBOR_S3_ACCESS_KEY_ID,settings.HARBOR_S3_SECRET_ACCESS_KEY])
    assert.ok(!output.stdout.includes(value));
   assert.deepEqual(requests.map(({method})=>method),status===0?['HEAD','HEAD']:['HEAD','HEAD','GET']);
   assert.ok(requests.every(request=>request.host===expectedHost));
   assert.ok(requests[0].authorization&&requests[1].authorization);
   assert.equal(requests[1].path,path);
   if(status!==0)assert.deepEqual(requests[2],{method:'GET',path,host:expectedHost,authorization:undefined,cookie:undefined,range:'bytes=0-0'});
  }
 }finally{
  const closed=once(server,'close');
  server.close();
  server.closeAllConnections();
  await closed;
 }
}

async function verifyRestrictedNoteWorker(env,sql){
  const [contact]=await sql`SELECT c.workspace_id,c.id,c.revision,w.owner_id,w.last_job_claim_at
    FROM contacts c JOIN private_workspaces w ON c.workspace_id=w.id
      JOIN contact_events e ON (e.workspace_id,e.contact_id,e.revision)=(c.workspace_id,c.id,c.revision)
    WHERE c.archived_at IS NULL ORDER BY c.workspace_id,c.id LIMIT 1`;
  assert.ok(contact,'A fictional Contact is available for the restricted worker test.');
  const {workspace_id:workspaceId,id:contactId,revision,owner_id:ownerId,last_job_claim_at:lastClaim}=contact;
  const [plainId,firstId,nextId,workflowId]=Array.from({length:4},()=>randomUUID());
  const ids=[plainId,firstId,nextId];
  const name='Fictional restricted Note workflow';
  const steps=[
    {id:randomUUID(),name:'First Note',body:'Fictional first restricted Note',delayMinutes:0},
    {id:randomUUID(),name:'Follow-up Note',body:'Fictional delayed restricted Note',delayMinutes:1},
  ];
  const plainBody='Fictional plain restricted Note';
  const run=async(id,body)=>{
    const {stdout,stderr}=await execute(process.execPath,[command,'worker','--once','--notes-only'],{env,cwd,timeout:6_000});
    assert.equal(stdout,'');
    assert.equal(stderr,'');
    assert.deepEqual(Array.from(await sql`SELECT j.status,n.body,a.outcome,a.number
      FROM portable_jobs j JOIN portable_notes n ON (n.workspace_id,n.job_id)=(j.workspace_id,j.id)
      JOIN portable_job_attempts a ON (a.workspace_id,a.job_id)=(j.workspace_id,j.id)
      WHERE j.workspace_id=${workspaceId} AND j.id=${id}`),[{status:'succeeded',body,outcome:'succeeded',number:1}]);
  };
  try{
    await sql.begin(async tx=>{
      await tx`INSERT INTO portable_deal_workflows(workspace_id,id,revision,definition)
        VALUES (${workspaceId},${workflowId},1,${sql.json({name,trigger:'manual_contact',actionKind:'note_sequence',steps})})`;
      await tx`INSERT INTO portable_jobs(workspace_id,id,contact_id,actor_id,kind,body,scheduled_for,available_at,created_at)
        VALUES (${workspaceId},${plainId},${contactId},${ownerId},'note',${plainBody},0,0,0),
          (${workspaceId},${firstId},${contactId},${ownerId},'note',${steps[0].body},1,1,1)`;
      await tx`INSERT INTO portable_manual_workflow_runs
        (workspace_id,id,workflow_id,workflow_revision,workflow_name,contact_id,contact_revision,created_at)
        VALUES (${workspaceId},${firstId},${workflowId},1,${name},${contactId},${revision},1)`;
      await tx`INSERT INTO portable_manual_workflow_run_actions
        (workspace_id,run_id,position,action_id,name,body,delay_minutes,planned_job_id,job_id)
        VALUES (${workspaceId},${firstId},0,${steps[0].id},${steps[0].name},${steps[0].body},0,${firstId},${firstId}),
          (${workspaceId},${firstId},1,${steps[1].id},${steps[1].name},${steps[1].body},1,${nextId},NULL)`;
    });
    await run(plainId,plainBody);
    await run(firstId,steps[0].body);
    const [successor]=await sql`SELECT a.job_id,j.status,j.scheduled_for,f.finished_at
      FROM portable_manual_workflow_run_actions a
      JOIN portable_jobs j ON (j.workspace_id,j.id)=(a.workspace_id,a.job_id)
      JOIN portable_jobs f ON (f.workspace_id,f.id)=(a.workspace_id,a.run_id)
      WHERE a.workspace_id=${workspaceId} AND a.run_id=${firstId} AND a.position=1`;
    assert.equal(successor?.job_id,nextId);
    assert.equal(successor.status,'queued');
    assert.equal(Number(successor.scheduled_for)-Number(successor.finished_at),60_000);
    await sql`UPDATE portable_jobs SET available_at=0 WHERE workspace_id=${workspaceId} AND id=${nextId}`;
    await run(nextId,steps[1].body);
  }finally{
    await sql.begin(async tx=>{
      await tx`DELETE FROM portable_manual_workflow_run_actions WHERE workspace_id=${workspaceId} AND run_id=${firstId}`;
      await tx`DELETE FROM portable_manual_workflow_runs WHERE workspace_id=${workspaceId} AND id=${firstId}`;
      await tx`DELETE FROM portable_notes WHERE workspace_id=${workspaceId} AND job_id=ANY(${ids}::uuid[])`;
      await tx`DELETE FROM portable_job_attempts WHERE workspace_id=${workspaceId} AND job_id=ANY(${ids}::uuid[])`;
      await tx`DELETE FROM portable_jobs WHERE workspace_id=${workspaceId} AND id=ANY(${ids}::uuid[])`;
      await tx`DELETE FROM portable_deal_workflows WHERE workspace_id=${workspaceId} AND id=${workflowId}`;
      await tx`UPDATE private_workspaces SET last_job_claim_at=${lastClaim} WHERE id=${workspaceId}`;
    });
  }
}

export async function verifyPortableDoctor(env,sql,hasStorage,calendar){
  const disabled={...env,HARBOR_PORTABLE_MODE:'local',HARBOR_PORTABLE_GMAIL_ENABLED:'false',
    HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED:'false',HARBOR_PORTABLE_PERSONAL_GOOGLE_ENABLED:'false'};
  const enabled={...disabled,HARBOR_PORTABLE_GMAIL_ENABLED:'true',HARBOR_PORTABLE_GMAIL_OWNER:'owner@example.test',
    HARBOR_PORTABLE_GMAIL_CLIENT_ID:'',HARBOR_PORTABLE_GMAIL_CLIENT_SECRET:'',HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN:''};
  const credentials={...enabled,HARBOR_PORTABLE_GMAIL_CLIENT_ID:'fictional-doctor-id',
    HARBOR_PORTABLE_GMAIL_CLIENT_SECRET:'fictional-doctor-secret',HARBOR_PORTABLE_GMAIL_REFRESH_TOKEN:'fictional-doctor-refresh'};
  const refresh='https://oauth2.googleapis.com/token',profile='https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress';
  const readScope='https://www.googleapis.com/auth/gmail.readonly';
  const token={access_token:'fictional-doctor-access',token_type:'Bearer',expires_in:3600,
    scope:readScope+' https://www.googleapis.com/auth/gmail.send'};
  const checkGmail=(settings,code,options,...flags)=>portableDoctor(settings,'worker',code,gmailDoctorFixture(options),'--check-gmail',...flags);
  const calendarProbe=shortDeadline=>'data:text/javascript,'+encodeURIComponent(`
    import assert from 'node:assert/strict';
    import {calendarFetch} from ${JSON.stringify(pathToFileURL(calendar.path).href)};
    if(${shortDeadline}){
      const timeout=AbortSignal.timeout;
      AbortSignal.timeout=milliseconds=>timeout(milliseconds===12_000?500:milliseconds);
    }
    globalThis.fetch=(url,options)=>{
      assert.ok(['https://oauth2.googleapis.com/token','https://www.googleapis.com/oauth2/v2/userinfo',
        'https://www.googleapis.com/calendar/v3/freeBusy'].includes(url));
      assert.equal(options.redirect,'manual');
      assert.ok(options.signal instanceof AbortSignal);
      return calendarFetch(new URL(url),options);
    };
  `);
  const calendarSettings={...disabled,...calendar.env,HARBOR_PORTABLE_CALENDAR_INVITES_ENABLED:'false',
    HARBOR_PORTABLE_CALENDAR_CANCELLATIONS_ENABLED:'false',HARBOR_PORTABLE_CALENDAR_RESCHEDULES_ENABLED:'false'};
  const calendarWrites={HARBOR_PORTABLE_CALENDAR_CANCELLATIONS_ENABLED:'true',HARBOR_PORTABLE_CALENDAR_RESCHEDULES_ENABLED:'true'};
  const invites={...calendarSettings,HARBOR_PORTABLE_CALENDAR_INVITES_ENABLED:'true'};
  const checkCalendar=async(settings,mode,result,calls,code=result==='ok'?0:1)=>{
    await calendar.mode(mode);
    const before=(await calendar.calls()).length;
    const report=portableDoctor(settings,'web',code,calendarProbe(mode==='slow_preflight'),'--check-calendar');
    assert.equal(report.checks.calendarConnection,result);
    assert.deepEqual((await calendar.calls()).slice(before),calls);
    return report;
  };
  const web=portableDoctor(disabled,'web');
  await verifyPrivateFileDoctor(disabled);
  if(process.env.HARBOR_TEST_TLS_KEY)await verifyPrivateFileDoctor(disabled,true);
  assert.deepEqual(web.checks,{webOrigin:'ok',googleSignIn:'ok',gmail:'disabled',database:'ok',
    storage:hasStorage?'ok':'optional_unconfigured'});
  assert.equal(web.personalGoogleCallbackUrls,undefined);
  verifyPersonalGoogleDoctor(disabled,personalGmailSettings,['ok','disabled',undefined]);
  verifyPersonalGoogleDoctor(disabled,personalCalendarSettings,['disabled','ok',undefined]);
  verifyPersonalGoogleDoctor(disabled,{},['disabled','disabled','missing_personal_google_clients'],1);
  verifyPersonalGoogleDoctor(disabled,{...personalGmailSettings,HARBOR_PORTABLE_PERSONAL_GMAIL_CLIENT_ID:env.HARBOR_LOGIN_GOOGLE_CLIENT_ID,
    HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_ID:personalCalendarSettings.HARBOR_PORTABLE_PERSONAL_CALENDAR_CLIENT_ID},
    ['shared_client','credentials',undefined],1);
  verifyPersonalGoogleDoctor(disabled,{...personalGmailSettings,...personalCalendarSettings,HARBOR_PORTABLE_PERSONAL_GOOGLE_KEY:'bad-personal-key-fixture'},
    ['key','key',undefined],1);
  verifyPersonalGoogleDoctor({...disabled,HARBOR_LOGIN_ORIGIN:env.HARBOR_LOGIN_ORIGIN+'/?private=fixture'},
    {...personalGmailSettings,...personalCalendarSettings},['origin','origin',undefined],1);
  const reachable=googleDoctorFixture(404,JSON.stringify({keys:[{kty:'RSA',kid:'fixture',n:'fictional',e:'AQAB'}]}));
  assert.deepEqual(portableDoctor(disabled,'web',0,reachable).checks,
    {...web.checks,googleTokenReachability:'ok',googleSigningKeys:'ok'});
  const notConfigured=portableDoctor({...disabled,HARBOR_LOGIN_GOOGLE_CLIENT_SECRET:''},'web',1,reachable);
  assert.deepEqual(notConfigured.checks,{...web.checks,googleSignIn:'invalid_sign_in_settings',
    googleTokenReachability:'ok',googleSigningKeys:'ok'});
  assert.deepEqual(notConfigured.signInSettingsToCheck,['HARBOR_LOGIN_GOOGLE_CLIENT_SECRET']);
  const missingSettings=portableDoctor({...disabled,HARBOR_LOGIN_GOOGLE_CLIENT_ID:'',HARBOR_LOGIN_ALLOWED_EMAILS:''},'web',1);
  assert.deepEqual(missingSettings.signInSettingsToCheck,['HARBOR_LOGIN_GOOGLE_CLIENT_ID','HARBOR_LOGIN_ALLOWED_EMAILS']);
  const malformedClient=portableDoctor({...disabled,HARBOR_LOGIN_GOOGLE_CLIENT_SECRET:'fixture secret'},'web',1);
  assert.equal(malformedClient.checks.googleSignIn,'invalid_sign_in_settings');
  assert.deepEqual(malformedClient.signInSettingsToCheck,['HARBOR_LOGIN_GOOGLE_CLIENT_SECRET']);
  const badAllowlist=portableDoctor({...disabled,HARBOR_LOGIN_ALLOWED_EMAILS:'fictional-invalid-address'},'web',1);
  assert.deepEqual(badAllowlist.signInSettingsToCheck,['HARBOR_LOGIN_ALLOWED_EMAILS']);
  assert.equal(web.signInSettingsToCheck,undefined);
  const intercepted=googleDoctorFixture(302,'x'.repeat(33_000));
  assert.deepEqual(portableDoctor(disabled,'web',1,intercepted).checks,
    {...web.checks,googleTokenReachability:'unavailable',googleSigningKeys:'unavailable'});
  assert.deepEqual(portableDoctor({...disabled,HARBOR_PORTABLE_MODE:'invalid'},'worker',1).checks,{mode:'invalid_mode'});
  const bad=portableDoctor({...disabled,DATABASE_URL:'unparseable-dsn-fixture',PORT:'invalid',HARBOR_LOGIN_ALLOWED_EMAILS:'not-an-email-address-fixture',
    HARBOR_S3_ENDPOINT:'https://never-contact.example.test',HARBOR_S3_BUCKET:'fictional',HARBOR_S3_ACCESS_KEY_ID:'fictional-key',
    HARBOR_S3_SECRET_ACCESS_KEY:'fictional-secret'},'web',1);
  assert.deepEqual(bad.checks,{webOrigin:'invalid_origin_or_port',googleSignIn:'invalid_sign_in_settings',gmail:'disabled',
    database:'invalid_database_url',storage:'invalid_storage_endpoint'});
  const dbGone=new URL(env.DATABASE_URL);
  dbGone.pathname='/harbor_doctor_missing';
  const disconnected=portableDoctor({...disabled,DATABASE_URL:dbGone.href},'web',1);
  assert.equal(disconnected.checks.database,'unavailable');
  assert.equal(disconnected.checks.storage,web.checks.storage);
  const proxy=await postgresReplyProxy(env.DATABASE_URL,{holdHalfOpen:true});
  let pending;
  try{
    await sql.begin(async tx=>{
      await tx`LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE`;
      pending=execute(process.execPath,[command,'doctor','web'],{
        cwd,env:{...disabled,DATABASE_URL:proxy.url.href},timeout:8_000,
      }).then(output=>({...output,code:0}),error=>error);
      let waiting=false;
      for(let poll=0;poll<45&&!waiting;poll++){
        [{waiting}]=await tx`SELECT EXISTS(SELECT FROM pg_locks WHERE NOT granted
          AND relation='drizzle.__drizzle_migrations'::regclass) AS waiting`;
        if(!waiting)await delay(50);
      }
      assert.ok(waiting,'doctor reached the ledger on an established Postgres session');
      proxy.block();
    });
    const result=await pending;
    assert.equal(result.code,1,result.signal??result.stderr);
    assert.equal(result.stderr,'');
    assert.equal(proxy.stalled.size,1,'the doctor lost the ledger reply');
    assert.equal(proxy.clients.size,1,'the proxy withheld TCP shutdown until fixture cleanup');
    const report=JSON.parse(result.stdout);
    assert.equal(report.result,'needs_setup');
    assert.deepEqual(report.checks,{...web.checks,database:'unavailable'});
    assert.ok(!result.stdout.includes(proxy.url.href));
  }finally{
    await proxy.close();
    await pending;
  }
  assert.equal(portableDoctor(disabled,'web').checks.database,'ok');
  const role='harbor_doctor_'+randomUUID().replaceAll('-','');
  const password=randomUUID();
  // A freshly migrated database can still be connected with the wrong role.
  await sql.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  try{
    await sql`GRANT USAGE ON SCHEMA public, drizzle TO ${sql(role)}`;
    await sql`GRANT SELECT ON drizzle.__drizzle_migrations TO ${sql(role)}`;
    const limitedUrl=new URL(disabled.DATABASE_URL);
    limitedUrl.username=role;
    limitedUrl.password=password;
    const limited={...disabled,DATABASE_URL:limitedUrl.href};
    for(const profile of ['web','worker']){
      assert.equal(portableDoctor(limited,profile,1).checks.database,'missing_runtime_permissions');
    }
    await sql`GRANT SELECT, INSERT, UPDATE ON public.portable_jobs TO ${sql(role)}`;
    await sql`GRANT INSERT ON public.portable_job_attempts TO ${sql(role)}`;
    assert.equal(portableDoctor(limited,'worker',1).checks.database,'missing_runtime_permissions');
    await sql`GRANT UPDATE ON public.portable_job_attempts TO ${sql(role)}`;
    await sql`GRANT SELECT (workspace_id,job_id,number) ON public.portable_job_attempts TO ${sql(role)}`;
    await sql`GRANT SELECT ON public.private_workspaces TO ${sql(role)}`;
    await sql`GRANT UPDATE (last_job_claim_at) ON public.private_workspaces TO ${sql(role)}`;
    await sql`GRANT SELECT, INSERT, UPDATE ON public.portable_worker_heartbeat TO ${sql(role)}`;
    await sql`GRANT SELECT ON public.contacts TO ${sql(role)}`;
    await sql`GRANT UPDATE ON public.contacts TO ${sql(role)}`;
    assert.equal(portableDoctor(limited,'worker',1).checks.database,'missing_runtime_permissions');
    await sql`GRANT INSERT ON public.portable_notes TO ${sql(role)}`;
    await sql`GRANT SELECT ON public.portable_lead_form_note_sources, public.portable_lead_forms,
      public.portable_lead_form_activations, public.portable_manual_workflow_run_actions TO ${sql(role)}`;
    await sql`GRANT SELECT (workspace_id,contact_id,revision,previous,data) ON public.contact_events TO ${sql(role)}`;
    await sql`GRANT SELECT (workspace_id,form_id,id,contact_id,status) ON public.portable_lead_inquiries TO ${sql(role)}`;
    await sql`GRANT UPDATE (job_id) ON public.portable_manual_workflow_run_actions TO ${sql(role)}`;
    assert.equal(portableDoctor(limited,'worker').checks.database,'ok');
    const noteGrants=[
      'SELECT ON public.portable_lead_form_note_sources',
      'SELECT ON public.portable_manual_workflow_run_actions',
      'INSERT ON public.portable_jobs',
      'UPDATE (job_id) ON public.portable_manual_workflow_run_actions',
      'SELECT (job_id) ON public.portable_job_attempts',
      'SELECT (status) ON public.portable_lead_inquiries',
      'SELECT (data) ON public.contact_events',
    ];
    for(const grant of noteGrants){
      await sql`REVOKE ${sql.unsafe(grant)} FROM ${sql(role)}`;
      assert.equal(portableDoctor(limited,'worker',1).checks.database,'missing_runtime_permissions',grant);
      await sql`GRANT ${sql.unsafe(grant)} TO ${sql(role)}`;
    }
    assert.equal(portableDoctor(limited,'worker').checks.database,'ok');
    await verifyRestrictedNoteWorker(limited,sql);
    await sql`GRANT SELECT ON public.portable_task_jobs TO ${sql(role)}`;
    await sql`GRANT SELECT (id,email,full_name) ON public.login_identities TO ${sql(role)}`;
    const gmailDbCheck=(status,workflow=false)=>{
      const report=checkGmail({...credentials,DATABASE_URL:limited.DATABASE_URL,
        HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED:String(workflow)},status==='ok'?0:1,
        {token,mailbox:'owner@example.test',requests:[refresh,profile]});
      assert.equal(report.checks.gmailConnection,'ok');
      assert.equal(report.checks.database,status);
    };
    await sql`GRANT SELECT, UPDATE (dispatch_started_at) ON public.portable_scheduled_gmail TO ${sql(role)}`;
    await sql`GRANT SELECT (id,workspace_id,email) ON public.portable_email_suppressions TO ${sql(role)}`;
    await sql`GRANT INSERT ON public.portable_email_unsubscribe_tokens TO ${sql(role)}`;
    gmailDbCheck('missing_gmail_worker_permissions');
    await sql`GRANT UPDATE (provider_id) ON public.portable_scheduled_gmail TO ${sql(role)}`;
    gmailDbCheck('ok');
    gmailDbCheck('missing_gmail_worker_permissions',true);
    const taskCheck=(code=0)=>portableDoctor(limited,'worker',code,undefined,'--check-tasks').checks.database;
    assert.equal(taskCheck(1),'missing_task_worker_permissions');
    await sql`GRANT INSERT ON public.portable_tasks TO ${sql(role)}`;
    assert.equal(taskCheck(1),'missing_task_worker_permissions');
    await sql`GRANT INSERT ON public.portable_task_events TO ${sql(role)}`;
    assert.equal(taskCheck(),'ok');
    const segmentCheck=(code=0,...options)=>portableDoctor(limited,'worker',code,undefined,'--check-segments',...options).checks.database;
    assert.equal(segmentCheck(1),'missing_segment_worker_permissions');
    await sql`GRANT SELECT, UPDATE ON public.portable_segment_workflow_scans TO ${sql(role)}`;
    await sql`GRANT SELECT, INSERT, UPDATE ON public.portable_segment_workflow_members TO ${sql(role)}`;
    await sql`GRANT SELECT, INSERT ON public.portable_workflow_runs TO ${sql(role)}`;
    await sql`GRANT SELECT ON public.portable_manual_workflow_runs, public.portable_workflow_activations,
      public.portable_deal_workflows, public.portable_segments TO ${sql(role)}`;
    gmailDbCheck('ok',true);
    assert.equal(segmentCheck(1),'missing_segment_worker_permissions');
    await sql`GRANT DELETE ON public.portable_segment_workflow_members TO ${sql(role)}`;
    assert.equal(segmentCheck(),'ok');
    assert.equal(segmentCheck(1,'--check-tasks'),'missing_segment_worker_permissions');
    await sql`GRANT INSERT ON public.portable_task_jobs TO ${sql(role)}`;
    assert.equal(segmentCheck(0,'--check-tasks'),'ok');
    await sql`REVOKE UPDATE ON public.portable_worker_heartbeat FROM ${sql(role)}`;
    assert.equal(portableDoctor(limited,'worker',1).checks.database,'missing_runtime_permissions');
    await sql`GRANT UPDATE ON public.portable_worker_heartbeat TO ${sql(role)}`;
    assert.equal(portableDoctor(limited,'web',1).checks.database,'missing_runtime_permissions');
    await sql`GRANT INSERT ON public.login_sessions TO ${sql(role)}`;
    assert.equal(portableDoctor(limited,'web',1).checks.database,'missing_runtime_permissions');
    await sql`REVOKE INSERT ON public.login_sessions FROM ${sql(role)}`;
    await sql`GRANT INSERT (token_hash,user_id,created_at,expires_at) ON public.login_sessions TO ${sql(role)}`;
    await sql`GRANT SELECT (token_hash,user_id,expires_at), UPDATE (created_at), DELETE
      ON public.login_sessions TO ${sql(role)}`;
    await sql`GRANT SELECT (google_subject), INSERT (id,google_subject,email,full_name,created_at,updated_at),
      UPDATE (email,full_name,updated_at) ON public.login_identities TO ${sql(role)}`;
    await sql`GRANT SELECT (scope,subject,minute,used), INSERT (scope,subject,minute,used),
      UPDATE (minute,used) ON public.portable_request_budgets TO ${sql(role)}`;
    assert.equal(portableDoctor(limited,'web',1).checks.database,'missing_runtime_permissions');
    await sql`GRANT SELECT (state_hash,expires_minute), INSERT (state_hash,expires_minute),
      UPDATE (expires_minute), DELETE ON public.portable_login_attempt_uses TO ${sql(role)}`;
    assert.equal(portableDoctor(limited,'web').checks.database,'ok');
    const loginGrants=[
      'UPDATE (used) ON public.portable_request_budgets',
      'INSERT (state_hash) ON public.portable_login_attempt_uses',
      'UPDATE (expires_minute) ON public.portable_login_attempt_uses',
      'SELECT (google_subject) ON public.login_identities',
      'UPDATE (created_at) ON public.login_sessions',
      'DELETE ON public.login_sessions',
    ];
    for(const grant of loginGrants){
      await sql`REVOKE ${sql.unsafe(grant)} FROM ${sql(role)}`;
      assert.equal(portableDoctor(limited,'web',1).checks.database,'missing_runtime_permissions',grant);
      await sql`GRANT ${sql.unsafe(grant)} TO ${sql(role)}`;
    }
    assert.equal(portableDoctor(limited,'web').checks.database,'ok');
    const workspaceCheck=(code=0)=>portableDoctor(limited,'web',code,undefined,'--check-workspace-access').checks.database;
    const missingWorkspaceGrants='missing_workspace_access_permissions';
    assert.equal(workspaceCheck(1),missingWorkspaceGrants);
    // Prove column grants are sufficient even though the earlier worker fixture needs table SELECT.
    await sql`REVOKE SELECT ON public.private_workspaces FROM ${sql(role)}`;
    await sql`GRANT SELECT (id,owner_id), INSERT (id,owner_id,last_job_claim_at,last_task_repeat_at,last_form_note_promotion_at)
      ON public.private_workspaces TO ${sql(role)}`;
    await sql`GRANT SELECT (id,workspace_id,email,role,expires_at), INSERT (id,workspace_id,email,role,expires_at),
      UPDATE (id,role), DELETE ON public.portable_workspace_invites TO ${sql(role)}`;
    await sql`GRANT SELECT (workspace_id,viewer_id,id,contact_files,scheduled_notes,contact_outreach,record_activities,role),
      INSERT (workspace_id,viewer_id,id,contact_files,scheduled_notes,contact_outreach,record_activities,role),
      UPDATE (id,role,contact_files,scheduled_notes,contact_outreach,record_activities), DELETE
      ON public.portable_workspace_viewers TO ${sql(role)}`;
    assert.equal(workspaceCheck(),'ok');
    const workspaceGrants=[
      'SELECT (owner_id) ON public.private_workspaces',
      'UPDATE (last_job_claim_at) ON public.private_workspaces',
      'INSERT (last_form_note_promotion_at) ON public.private_workspaces',
      'INSERT (expires_at) ON public.portable_workspace_invites',
      'UPDATE (id) ON public.portable_workspace_invites',
      'DELETE ON public.portable_workspace_invites',
      'INSERT (record_activities) ON public.portable_workspace_viewers',
      'UPDATE (contact_files) ON public.portable_workspace_viewers',
      'DELETE ON public.portable_workspace_viewers',
    ];
    for(const grant of workspaceGrants){
      await sql`REVOKE ${sql.unsafe(grant)} FROM ${sql(role)}`;
      assert.equal(workspaceCheck(1),missingWorkspaceGrants,grant);
      await sql`GRANT ${sql.unsafe(grant)} TO ${sql(role)}`;
    }
    assert.equal(workspaceCheck(),'ok');
    await sql`GRANT SELECT ON public.private_workspaces TO ${sql(role)}`;
    const missingPersonalGrants='missing_personal_google_permissions';
    const personalGmailDbCheck=(expected='ok')=>assert.equal(
      verifyPersonalGoogleDoctor(limited,personalGmailSettings,['ok','disabled',undefined],expected==='ok'?0:1).checks.database,
      expected);
    personalGmailDbCheck(missingPersonalGrants);
    await sql`GRANT SELECT, INSERT, DELETE ON public.portable_google_attempts,public.portable_google_grants TO ${sql(role)}`;
    await sql`GRANT UPDATE (user_id,provider,session_hash,state_hash,verifier,expires_at,claimed)
      ON public.portable_google_attempts TO ${sql(role)}`;
    await sql`GRANT UPDATE (user_id,provider,id,email,needs_reconnect) ON public.portable_google_grants TO ${sql(role)}`;
    assert.equal(verifyPersonalGoogleDoctor(limited,personalCalendarSettings,['disabled','ok',undefined],1).checks.database,
      missingPersonalGrants);
    await sql`GRANT UPDATE (refresh_token) ON public.portable_google_grants TO ${sql(role)}`;
    personalGmailDbCheck();
    await sql`REVOKE DELETE ON public.portable_google_attempts FROM ${sql(role)}`;
    personalGmailDbCheck(missingPersonalGrants);
    assert.equal(portableDoctor(limited,'web').checks.database,'ok');
    await sql`GRANT DELETE ON public.portable_google_attempts TO ${sql(role)}`;
    assert.equal(verifyPersonalGoogleDoctor(limited,personalCalendarSettings,['disabled','ok',undefined]).checks.database,'ok');
    const calendarDbCheck=async(settings,status='ok')=>{
      const report=await checkCalendar({...settings,DATABASE_URL:limited.DATABASE_URL},'free','ok',
        ['token','identity','availability'],status==='ok'?0:1);
      assert.equal(report.checks.database,status);
    };
    await calendarDbCheck(calendarSettings);
    await calendarDbCheck(invites,'missing_calendar_write_permissions');
    await sql`GRANT SELECT, INSERT, UPDATE (status) ON public.portable_calendar_meetings TO ${sql(role)}`;
    await sql`GRANT SELECT ON public.portable_calendar_reschedules TO ${sql(role)}`;
    await calendarDbCheck(invites,'missing_calendar_write_permissions');
    await sql`GRANT UPDATE (event_url) ON public.portable_calendar_meetings TO ${sql(role)}`;
    await calendarDbCheck(invites);
    const cancellable={...invites,HARBOR_PORTABLE_CALENDAR_CANCELLATIONS_ENABLED:'true'};
    await calendarDbCheck(cancellable,'missing_calendar_write_permissions');
    await sql`GRANT UPDATE (cancellation_started_at) ON public.portable_calendar_meetings TO ${sql(role)}`;
    await calendarDbCheck(cancellable);
    const calendarWithWrites={...invites,...calendarWrites};
    await calendarDbCheck(calendarWithWrites,'missing_calendar_write_permissions');
    await sql`GRANT INSERT, UPDATE (status) ON public.portable_calendar_reschedules TO ${sql(role)}`;
    await sql`GRANT UPDATE (start_at,end_at,reschedule_revision,rescheduled_time_zone)
      ON public.portable_calendar_meetings TO ${sql(role)}`;
    await calendarDbCheck(calendarWithWrites);
    await sql`ALTER ROLE ${sql(role)} SET default_transaction_read_only TO on`;
    assert.equal(portableDoctor(limited,'web',1).checks.database,'database_read_only');
    assert.equal(portableDoctor(limited,'worker',1).checks.database,'database_read_only');
  }finally{
    await sql`DROP OWNED BY ${sql(role)}`;
    await sql`DROP ROLE ${sql(role)}`;
  }

  const future=Date.now()+10*365*86400_000;
  const [{id}]=await sql`INSERT INTO drizzle.__drizzle_migrations (hash,created_at) VALUES ('fictional-future',${future}) RETURNING id`;
  try{assert.equal(portableDoctor(disabled,'worker',1).checks.database,'newer_release_required');}
  finally{await sql`DELETE FROM drizzle.__drizzle_migrations WHERE id=${id}`;}

  const worker=portableDoctor({...disabled,...personalGoogleSettings,HARBOR_PORTABLE_MODE:'hosted',HARBOR_PORTABLE_WORKER_ENABLED:'false',
    HARBOR_LOGIN_ORIGIN:'',HARBOR_S3_ENDPOINT:''},'worker');
  assert.equal(worker.workerEnabled,false);
  assert.equal(worker.personalGoogleCallbackUrls,undefined);
  assert.deepEqual(worker.checks,{gmail:'disabled',database:'ok',storage:'not_required'});
  assert.equal(portableDoctor({...enabled,HARBOR_PORTABLE_GMAIL_OWNER:'absent@example.test'},'web',1).checks.gmail,'owner_not_allowed');
  assert.equal(portableDoctor(enabled,'worker',1).checks.gmail,'invalid_worker_gmail_settings');
  assert.equal(portableDoctor({...disabled,HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED:'true'},'worker',1).checks.gmail,'scheduled_gmail_required');
  assert.equal(portableDoctor(credentials,'worker').checks.gmailConnection,undefined);
  assert.equal(checkGmail(disabled,1,{requests:[]}).checks.gmailConnection,'not_configured');
  assert.equal(checkGmail(credentials,0,{token,mailbox:'OWNER@example.test',requests:[refresh,profile]}).checks.gmailConnection,'ok');
  const webOrigin='https://harbor.example.test';
  const withWebOrigin={...credentials,HARBOR_LOGIN_ORIGIN:webOrigin};
  const matchingOrigin=checkGmail(withWebOrigin,0,{token,mailbox:'owner@example.test',requests:[refresh,profile]},
    '--expect-web-origin',webOrigin);
  assert.equal(matchingOrigin.checks.gmailUnsubscribeOrigin,'ok');
  assert.equal(matchingOrigin.checks.gmailConnection,'ok');
  for(const [candidate,status] of [
    ['https://another-harbor.example.test','gmail_unsubscribe_origin_mismatch'],
    [webOrigin+'/email/unsubscribe','invalid_expected_web_origin'],
  ]){
    const badOrigin=checkGmail(withWebOrigin,1,{requests:[]},'--expect-web-origin',candidate);
    assert.equal(badOrigin.checks.gmailUnsubscribeOrigin,status);
    assert.equal(badOrigin.checks.gmailConnection,undefined);
    assert.ok(!JSON.stringify(badOrigin).includes(candidate));
  }
  assert.equal(checkGmail(credentials,1,{token,mailbox:'other@example.test',requests:[refresh,profile]}).checks.gmailConnection,'reauthorization_required');
  assert.equal(checkGmail(credentials,1,{token:{...token,scope:readScope},requests:[refresh]}).checks.gmailConnection,'reauthorization_required');
  assert.equal(checkGmail(credentials,1,{status:400,token:{error:'invalid_grant'},requests:[refresh]}).checks.gmailConnection,'reauthorization_required');
  assert.equal(checkGmail(credentials,1,{status:503,requests:[refresh]}).checks.gmailConnection,'unavailable');
  const inboxSettings={...disabled,HARBOR_PORTABLE_INBOX_ENABLED:'true',HARBOR_PORTABLE_INBOX_OWNER:'owner@example.test',
    HARBOR_PORTABLE_INBOX_CLIENT_ID:'fictional-inbox-doctor-id',HARBOR_PORTABLE_INBOX_CLIENT_SECRET:'fictional-inbox-doctor-secret',
    HARBOR_PORTABLE_INBOX_REFRESH_TOKEN:'fictional-inbox-doctor-refresh'};
  const readToken={...token,scope:readScope};
  const checkInbox=(settings,code,options)=>portableDoctor(settings,'web',code,
    gmailDoctorFixture({...options,prefix:'HARBOR_PORTABLE_INBOX'}),'--check-inbox').checks.inboxConnection;
  assert.equal(portableDoctor(inboxSettings,'web').checks.inboxConnection,undefined);
  assert.equal(checkInbox(disabled,1,{requests:[]}),'not_configured');
  assert.equal(checkInbox({...inboxSettings,HARBOR_LOGIN_ALLOWED_EMAILS:'other@example.test'},1,{requests:[]}),'not_configured');
  assert.equal(checkInbox(inboxSettings,0,{token:readToken,mailbox:'OWNER@example.test',requests:[refresh,profile]}),'ok');
  assert.equal(checkInbox(inboxSettings,1,{token:readToken,mailbox:'other@example.test',requests:[refresh,profile]}),'reauthorization_required');
  assert.equal(checkInbox(inboxSettings,1,{token:{...readToken,scope:'https://www.googleapis.com/auth/gmail.send'},requests:[refresh]}),'reauthorization_required');
  assert.equal(checkInbox(inboxSettings,1,{status:400,token:{error:'invalid_grant'},requests:[refresh]}),'reauthorization_required');
  assert.equal(checkInbox(inboxSettings,1,{status:503,requests:[refresh]}),'unavailable');
  const writesWithoutInvites=portableDoctor({...calendarSettings,...calendarWrites},'web',1).checks;
  assert.equal(writesWithoutInvites.calendarCancellations,'calendar_invitations_required');
  assert.equal(writesWithoutInvites.calendarReschedules,'calendar_invitations_required');
  assert.equal(portableDoctor({...invites,HARBOR_PORTABLE_CALENDAR_ENABLED:'false'},'web',1).checks.calendarInvitations,
    'calendar_connection_required');
  assert.equal(portableDoctor({...invites,HARBOR_LOGIN_ALLOWED_EMAILS:'other@example.test'},'web',1).checks.calendarInvitations,
    'calendar_connection_required');
  const configuredWrites=portableDoctor({...invites,...calendarWrites},'web').checks;
  for(const key of ['calendarInvitations','calendarCancellations','calendarReschedules'])assert.equal(configuredWrites[key],'ok');
  try{
    assert.equal(portableDoctor(calendarSettings,'web').checks.calendarConnection,undefined);
    await checkCalendar({...calendarSettings,HARBOR_PORTABLE_CALENDAR_ENABLED:'false'},'free','not_configured',[]);
    await checkCalendar({...calendarSettings,HARBOR_LOGIN_ALLOWED_EMAILS:'other@example.test'},'free','not_configured',[]);
    await checkCalendar(calendarSettings,'busy','ok',['token','identity','availability']);
    await checkCalendar(calendarSettings,'wrong_owner','reauthorization_required',['token','identity']);
    await checkCalendar({...calendarSettings,HARBOR_PORTABLE_CALENDAR_INVITES_ENABLED:'true'},
      'availability_only','reauthorization_required',['token']);
    await checkCalendar(calendarSettings,'reauth','reauthorization_required',['token']);
    await checkCalendar(calendarSettings,'partial','unavailable',['token','identity','availability']);
    await checkCalendar(calendarSettings,'slow_preflight','unavailable',['token','preflight_cancelled']);
    await checkCalendar(calendarSettings,'free','ok',['token','identity','availability']);
  }finally{await calendar.mode('free');}
}

export async function postgresReplyProxy(database,{holdHalfOpen=false,blockOnQuery,firstConnectionOnly=false}={}){
  const upstreamAddress=new URL(database);
  const clients=new Set(),stalled=new Set();
  let dropping=false,connections=0;
  const server=createServer({allowHalfOpen:holdHalfOpen},client=>{
    connections++;
    clients.add(client);
    const upstream=createConnection({host:upstreamAddress.hostname,port:Number(upstreamAddress.port||5432)});
    if(blockOnQuery&&(!firstConnectionOnly||connections===1)){
      // Match an unencrypted query before forwarding it, even across TCP chunks.
      const marker=Buffer.from(blockOnQuery);
      let tail=Buffer.alloc(0);
      client.on('data',bytes=>{
        if(dropping)return;
        const data=Buffer.concat([tail,bytes]);
        if(data.includes(marker))dropping=true;
        else tail=data.subarray(Math.max(0,data.length-marker.length+1));
      });
    }
    client.pipe(upstream,{end:!holdHalfOpen});
    if(holdHalfOpen)client.on('end',()=>{if(!dropping)upstream.end();});
    upstream.on('data',bytes=>{
      if(dropping)stalled.add(client);
      else client.write(bytes);
    });
    upstream.on('error',()=>client.destroy());
    upstream.on('close',()=>{if(!holdHalfOpen||!dropping)client.destroy();});
    client.on('error',()=>client.destroy());
    client.on('close',()=>{
      clients.delete(client);
      upstream.destroy();
    });
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const url=new URL(database);
  url.hostname='127.0.0.1';
  url.port=String(server.address().port);
  return {
    url,clients,stalled,
    block(){dropping=true;},
    unblock(){dropping=false;},
    close(){
      for(const client of clients)client.destroy();
      return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    },
  };
}

export async function verifyPortableHosting({env,mock,signIn,prepareSignIn,record,otherRecord,request,sourceOwner,other,sql,restartSource,inbox,inboxContactId}){
  const socket=createServer().listen(0,'127.0.0.1');
  await once(socket,'listening');
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  const origin='https://harbor.example.test';
  const s3Endpoint=process.env.HARBOR_TEST_HOSTED_S3_ENDPOINT;
  if(s3Endpoint){
    const parsed=new URL(s3Endpoint);
    assert.equal(parsed.hostname,'127.0.0.1');
    assert.equal(parsed.protocol,'https:');
  }
  const hosted={...env,...inbox.env,HARBOR_PORTABLE_HOSTED_INBOX_ENABLED:'true',HARBOR_PORTABLE_MODE:'hosted',HARBOR_PORTABLE_WORKER_ENABLED:'false',HARBOR_PORTABLE_RESTORE_ENABLED:'false',
    HARBOR_LOGIN_ORIGIN:origin,PORT:String(port),HARBOR_S3_ENDPOINT:s3Endpoint||'https://127.0.0.1:1',
    HARBOR_S3_BUCKET:env.HARBOR_S3_BUCKET||'synthetic-private',HARBOR_S3_ACCESS_KEY_ID:env.HARBOR_S3_ACCESS_KEY_ID||'S3RVER',
    HARBOR_S3_SECRET_ACCESS_KEY:env.HARBOR_S3_SECRET_ACCESS_KEY||'S3RVER',
  };
  const setupEnvironment={...hosted,HARBOR_LOGIN_GOOGLE_CLIENT_ID:'',HARBOR_LOGIN_GOOGLE_CLIENT_SECRET:'',
    HARBOR_LOGIN_ALLOWED_EMAILS:'',HARBOR_PORTABLE_GMAIL_ENABLED:'false',HARBOR_PORTABLE_WORKFLOW_GMAIL_ENABLED:'false',
    HARBOR_PORTABLE_HOSTED_INBOX_ENABLED:'false',HARBOR_PORTABLE_CALENDAR_ENABLED:'false',
    HARBOR_PORTABLE_CALENDAR_INVITES_ENABLED:'false',HARBOR_PORTABLE_CALENDAR_CANCELLATIONS_ENABLED:'false',
    HARBOR_PORTABLE_CALENDAR_RESCHEDULES_ENABLED:'false'};
  const setupDoctor=env=>spawnSync(process.execPath,[command,'doctor','web','--before-google'],
    {env,cwd,timeout:8000,encoding:'utf8'});
  const setupDiagnosis=setupDoctor(setupEnvironment);
  assert.equal(setupDiagnosis.status,s3Endpoint?0:1,setupDiagnosis.stderr||setupDiagnosis.stdout);
  const setupReport=JSON.parse(setupDiagnosis.stdout);
  assert.equal(setupReport.result,s3Endpoint?'ready_for_google_setup':'needs_setup');
  assert.equal(setupReport.checks.googleSignIn,'pending_setup');
  assert.equal(setupReport.googleCallbackUrl,origin+'/auth/google/callback');
  const withAllowlist=setupDoctor({...setupEnvironment,HARBOR_LOGIN_ALLOWED_EMAILS:'pilot@example.test'});
  assert.equal(withAllowlist.status,setupDiagnosis.status,withAllowlist.stderr||withAllowlist.stdout);
  assert.deepEqual(JSON.parse(withAllowlist.stdout),setupReport);
  assert.doesNotMatch(withAllowlist.stdout,/pilot@example\.test/);
  const invalidSetupAllowlist=setupDoctor({...setupEnvironment,HARBOR_LOGIN_ALLOWED_EMAILS:'not-an-email'});
  assert.equal(invalidSetupAllowlist.status,1);
  const invalidSetupReport=JSON.parse(invalidSetupAllowlist.stdout);
  assert.equal(invalidSetupReport.checks.googleSignIn,'invalid_sign_in_settings');
  assert.ok(invalidSetupReport.signInSettingsToCheck.includes('HARBOR_LOGIN_ALLOWED_EMAILS'));
  const invalidOrigin=setupDoctor({...setupEnvironment,HARBOR_LOGIN_ORIGIN:origin+'/?private=fixture'});
  assert.equal(invalidOrigin.status,1);
  const invalidReport=JSON.parse(invalidOrigin.stdout);
  assert.equal(invalidReport.checks.webOrigin,'invalid_origin_or_port');
  assert.equal(invalidReport.googleCallbackUrl,undefined);
  assert.doesNotMatch(invalidOrigin.stdout,/private=fixture/);
  assert.equal(setupReport.checks.database,'ok');
  assert.equal(portableDoctor(setupEnvironment,'web',1).checks.googleSignIn,'invalid_sign_in_settings');
  const partialDiagnosis=setupDoctor({...setupEnvironment,HARBOR_LOGIN_GOOGLE_CLIENT_ID:'fictional-partial-client'});
  assert.equal(partialDiagnosis.status,1);
  assert.equal(JSON.parse(partialDiagnosis.stdout).checks.googleSignIn,'invalid_sign_in_settings');
  assert.doesNotMatch(partialDiagnosis.stdout,/fictional-partial-client/);
  const invalidStorage=setupDoctor({...setupEnvironment,HARBOR_S3_ENDPOINT:'http://127.0.0.1:1'});
  assert.equal(invalidStorage.status,1);
  assert.equal(JSON.parse(invalidStorage.stdout).checks.storage,'invalid_storage_endpoint');
  const diagnosis=portableDoctor(hosted,'web',s3Endpoint?0:1);
  assert.equal(diagnosis.checks.storage,s3Endpoint?'ok':'unavailable');
  if(s3Endpoint)verifyPersonalGoogleDoctor(hosted,{...personalGmailSettings,...personalCalendarSettings},['ok','ok',undefined]);
  assert.equal(diagnosis.checks.googleSignIn,'ok');
  assert.equal(diagnosis.checks.calendar,'ok');
  assert.equal(diagnosis.checks.inbox,'ok');
  assert.equal(portableDoctor({...hosted,HARBOR_PORTABLE_HOSTED_INBOX_ENABLED:'false'},'web',s3Endpoint?0:1).checks.inbox,'disabled');
  assert.equal(portableDoctor({...hosted,HARBOR_PORTABLE_INBOX_OWNER:'outside@example.test'},'web',1).checks.inbox,'inbox_owner_not_allowed');

  assert.equal(portableDoctor({...hosted,HARBOR_PORTABLE_CALENDAR_REFRESH_TOKEN:''},'web',1).checks.calendar,'invalid_calendar_settings');
  assert.equal(portableDoctor({...hosted,HARBOR_PORTABLE_CALENDAR_OWNER:'absent@example.test'},'web',1).checks.calendar,'calendar_owner_not_allowed');
  assert.equal(diagnosis.checks.database,'ok');
  assert.throws(()=>execFileSync(process.execPath,[command,'worker','--once'],{env:hosted,cwd,stdio:'pipe'}),
    error=>/worker activation requires/.test(error.stderr));
  assert.throws(()=>execFileSync(process.execPath,[command,'restore','fixture'],{env:hosted,cwd,stdio:'pipe'}),
    error=>/Hosted restore requires HARBOR_PORTABLE_RESTORE_ENABLED/.test(error.stderr));

  const raw=(path,options={})=>fetch('http://127.0.0.1:'+port+path,{
    redirect:'manual',signal:AbortSignal.timeout(4500),...options,
  });
  const proxy=(path,options={})=>raw(path,{...options,headers:{
    host:'web.internal','x-forwarded-host':'harbor.example.test','x-forwarded-proto':'https',...options.headers,
  }});

  const fingerprint=(await readFile(new URL('../.harbor/portable-build/release.sha256',import.meta.url),'utf8')).trim();
  const migrations=readPortableMigrations(fileURLToPath(new URL('../db/postgres/migrations',import.meta.url)));
  const release=JSON.parse(execFileSync(process.execPath,[command,'release-info'],{
    cwd,env:{...env,DATABASE_URL:'',HARBOR_PORTABLE_MODE:'invalid-fixture-mode'},encoding:'utf8',timeout:5000,
  }));
  assert.deepEqual(release,{event:'harbor_portable_release',buildFingerprint:fingerprint,migrations:{
    count:migrations.length,
    ledgerSha256:createHash('sha256').update(JSON.stringify(migrations.map(entry=>[entry.folderMillis,entry.hash]))).digest('hex'),
  }});
  const setup=spawn(process.execPath,['--import',mock,command,'start'],{
    env:setupEnvironment,
    cwd,stdio:['ignore','pipe','pipe'],
  });
  const setupExited=once(setup,'exit');
  let setupLogs='';
  setup.stdout.on('data',chunk=>{setupLogs+=chunk;});
  setup.stderr.on('data',chunk=>{setupLogs+=chunk;});
  try{
    let response;
    for(let attempt=0;attempt<100&&!response;attempt++){
      assert.equal(setup.exitCode,null,setupLogs);
      response=await proxy('/auth/sign-in').catch(()=>null);
      if(!response)await delay(50);
    }
    assert.equal(response?.status,503,setupLogs);
    assert.ok((await response.text()).includes('<code>'+origin+'/auth/google/callback</code>'));
    const checks=await checkStandalone(origin,(url,options)=>{
      const {pathname,search}=new URL(url);
      return proxy(pathname+search,options);
    },fingerprint,{beforeGoogle:true,portable:true,checkReleaseReadiness:true});
    assert.equal(checks.length,13);
    assert.deepEqual(checks.filter(check=>!check.ok),[]);
    const head=await proxy('/',{method:'HEAD'});
    assert.equal(head.status,307);
    assert.equal(head.headers.get('location'),'/auth/sign-in');
    assert.equal(await head.text(),'');
    const denied=await proxy('/api/crm',{method:'POST',headers:{origin},body:'{}'});
    assert.equal(denied.status,503);
    assert.equal(denied.headers.get('cache-control'),'no-store');
    assert.doesNotMatch(setupLogs,/harbor_portable_readiness/);
  }finally{
    setup.kill();
    await setupExited;
  }

  const unconfigured=spawn(process.execPath,[command,'start'],{env:{...setupEnvironment,
    HARBOR_LOGIN_GOOGLE_CLIENT_ID:'fictional-partial-client',HARBOR_LOGIN_GOOGLE_CLIENT_SECRET:'fictional-configured-secret',
    HARBOR_LOGIN_ALLOWED_EMAILS:'operator@example.test,invalid-fixture-entry',
  },cwd,stdio:'ignore'});
  const unconfiguredExit=once(unconfigured,'exit');
  try{
    let response;
    for(let attempt=0;attempt<100&&!response;attempt++){
      assert.equal(unconfigured.exitCode,null);
      response=await proxy('/auth/sign-in').catch(()=>null);
      if(!response)await delay(50);
    }
    assert.equal(response?.status,503);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('set-cookie'),null);
    const html=(await response.text()).replaceAll('<!-- -->','');
    assert.match(html,/Fix <code>HARBOR_LOGIN_ALLOWED_EMAILS<\/code>/);
    assert.match(html,/with no empty entries/);
    for(const value of ['HARBOR_LOGIN_GOOGLE_CLIENT_ID','HARBOR_LOGIN_GOOGLE_CLIENT_SECRET','fictional-partial-client',
      'fictional-configured-secret','operator@example.test','invalid-fixture-entry','Continue with Google']){
      assert.ok(!html.includes(value),value);
    }
  }finally{
    unconfigured.kill();
    await unconfiguredExit;
  }

  const databaseProxy=await postgresReplyProxy(hosted.DATABASE_URL);
  const child=spawn(process.execPath,['--import',mock,command,'start'],{
    env:{...hosted,DATABASE_URL:databaseProxy.url.href,HARBOR_PORTABLE_READINESS_LOGS:'true'},cwd,stdio:['ignore','pipe','pipe'],
  });
  const exited=once(child,'exit');
  let logs='';
  child.stdout.on('data',chunk=>{logs+=chunk;});
  child.stderr.on('data',chunk=>{logs+=chunk;});
  try{
    let ready;
    for(let attempt=0;attempt<100&&!ready;attempt++){
      assert.equal(child.exitCode,null,logs);
      ready=await proxy('/auth/sign-in').catch(()=>null);
      if(!ready)await delay(50);
    }
    assert.equal(ready?.status,200,logs);
    const health=await raw('/healthz',{headers:{host:'healthcheck.railway.app'}});
    assert.equal(health.status,s3Endpoint?200:503,logs);
    assert.equal(await health.text(),s3Endpoint?'ready':'unavailable');
    assert.equal(health.headers.get('cache-control'),'no-store');
    assert.equal(health.headers.get('x-harbor-build-fingerprint'),fingerprint);
    const head=await proxy('/healthz',{method:'HEAD'});
    assert.equal(head.headers.get('x-harbor-build-fingerprint'),fingerprint);
    assert.equal(await head.text(),'');
    const publicChecks=await checkStandalone(origin,(url,options)=>{
      const {pathname,search}=new URL(url);
      return proxy(pathname+search,options);
    },fingerprint,{portable:true,checkOAuthGuards:true,checkUnsubscribe:true,checkReleaseReadiness:true,checkInstall:true,
      checkPublicDenials:!!s3Endpoint,checkWriteDenials:true,
      expectedGoogleClientId:hosted.HARBOR_LOGIN_GOOGLE_CLIENT_ID,expectedContact:JSON.parse(hosted.HARBOR_PUBLIC_PILOT_CONTACT)});
    assert.deepEqual(publicChecks.filter(check=>!check.ok).map(check=>check.name),
      s3Endpoint?[]:['Portable web app is ready']);
    assert.equal((await proxy('/auth/sign-in',{headers:{'x-forwarded-host':'foreign.example.test'}})).status,421);
    assert.equal((await proxy('/auth/sign-in',{headers:{'x-forwarded-proto':'http'}})).status,421);
    assert.equal((await proxy('/api/crm',{headers:{'oai-authenticated-user-id':'forged-id'}})).status,401);

    const originalConnections=new Set(databaseProxy.clients);
    assert.ok(originalConnections.size>0,'release ledger already answered on an established connection');
    await delay(1100); // Expire the one-second release-check cache.
    databaseProxy.block();
    const outage={signal:AbortSignal.timeout(8000)};
    const [blockedRoute,blockedSecond]=await Promise.all([proxy('/api/crm',outage),proxy('/api/pipeline',outage)]);
    for(const response of [blockedRoute,blockedSecond]){
      assert.equal(response.status,503);
      assert.equal(response.headers.get('retry-after'),'1');
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.match((await response.json()).error,/compatible database/);
    }
    assert.equal(databaseProxy.stalled.size,1,'simultaneous routes shared one stalled release check');
    const [stalledClient]=databaseProxy.stalled;
    assert.ok(originalConnections.has(stalledClient),'the proxy dropped replies on the established connection');
    databaseProxy.unblock();
    await delay(1100); // Honor the existing retry window for the failed check.
    assert.equal((await proxy('/api/crm')).status,401,'normal admission resumes without restarting the web process');
    assert.ok(!databaseProxy.clients.has(stalledClient),'the expired check released the stalled connection');
    assert.ok([...databaseProxy.clients].some(connection=>!originalConnections.has(connection)),
      'admission recovered on a fresh database connection');
    const logEntries=logs.split(/\r?\n/).filter(line=>line.startsWith('{"event":"harbor_portable_readiness"')).map(line=>JSON.parse(line));
    assert.deepEqual(logEntries.filter(entry=>entry.component==='database'),[
      {event:'harbor_portable_readiness',component:'database',status:'timeout'},
      {event:'harbor_portable_readiness',component:'database',status:'ok'},
    ]);
    assert.ok(!logs.includes(databaseProxy.url.href));
    assert.ok(!logs.includes(hosted.HARBOR_LOGIN_GOOGLE_CLIENT_SECRET));


    const headers=await signIn('owner@example.test',proxy,origin);
    assert.match(headers.cookie,/^__Host-harbor-session=/);
    const recordRead=await proxy('/api/crm?id='+record.id,{headers});
    assert.equal(recordRead.status,200);
    assert.equal((await recordRead.json()).revision,2);
    const recipient='hosted-unsubscribe@example.test';
    const suppressions='/api/email/suppressions?'+new URLSearchParams({query:recipient});
    const listSuppressions=async(send,auth)=>{
      const response=await send(suppressions,{headers:auth});
      assert.equal(response.status,200);
      return (await response.json()).results;
    };
    const issued=await proxy('/api/email/suppressions',{method:'POST',
      headers:{...headers,origin,'content-type':'application/json'},
      body:JSON.stringify({action:'unsubscribeLink',email:recipient})});
    assert.equal(issued.status,200);
    const link=new URL((await issued.json()).url);
    assert.equal(link.origin,origin);
    assert.equal(link.pathname,'/email/unsubscribe');
    assert.equal(link.search,'');
    assert.match(link.hash,/^#[A-Za-z0-9_-]{43}$/);
    for(const method of ['GET','HEAD']){
      const page=await proxy(link.pathname,{method});
      assert.equal(page.status,200);
      assert.equal(page.headers.has('set-cookie'),false);
      const html=await page.text();
      if(method==='GET')assert.match(html,/Unsubscribe from email/);
      else assert.equal(html,'');
      assert.ok(!html.includes(recipient)&&!html.includes(link.hash));
    }
    assert.deepEqual(await listSuppressions(proxy,headers),[]);
    for(let attempt=0;attempt<2;attempt++){
      const confirmed=await proxy('/api/email/unsubscribe',{method:'POST',
        headers:{origin,'content-type':'application/json'},body:JSON.stringify({token:link.hash.slice(1)})});
      assert.equal(confirmed.status,200);
      assert.match(confirmed.headers.get('cache-control'),/no-store/);
      assert.equal(confirmed.headers.has('set-cookie'),false);
      assert.deepEqual(await confirmed.json(),{unsubscribed:true});
    }
    const saved=await listSuppressions(proxy,headers);
    assert.equal(saved.length,1);
    assert.equal(saved[0].email,recipient);
    assert.ok(saved[0].recipientOptedOutAt);
    assert.deepEqual(await listSuppressions(request,other),[]);
    await verifyHostedPortableInbox({proxy,origin,headers,signIn,sql,contactId:inboxContactId,inbox});
    // Use the other account's workspace so this check does not remove the main sharing fixture's grant.
    await verifyPortableReplicaRevocation({source:request,replica:proxy,sourceOrigin:env.HARBOR_LOGIN_ORIGIN,
      replicaOrigin:origin,sourceOwner:other,replicaMember:headers,memberEmail:'owner@example.test',recordId:otherRecord.id,
      personalId:record.id,files:!!(s3Endpoint&&env.HARBOR_S3_BUCKET)});
    await verifyPortableRateLimits({source:request,replica:proxy,sourceOrigin:env.HARBOR_LOGIN_ORIGIN,replicaOrigin:origin,
      sourceOwner,replicaOwner:headers,other,record,otherRecord,sql,prepareSignIn,restartSource});
    const logout=site=>proxy('/auth/logout',{method:'POST',headers:{...headers,origin:site},body:new URLSearchParams({scope:'current'})});
    const foreignLogout=await logout('https://foreign.example.test');
    assert.equal(foreignLogout.status,403);
    assert.match(foreignLogout.headers.get('cache-control'),/no-store/);
    assert.equal((await logout(origin)).status,303);
    assert.equal((await proxy('/api/crm',{headers})).status,401);
  }finally{
    child.kill();
    try{await exited;}
    finally{await databaseProxy.close();}
  }
}
