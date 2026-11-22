// Opt-in, database-backed rehearsal. Run from a Harbor checkout:
// node tests/portable-fixtures/campaign-drain-load.mjs [recipients to process, 100–31000]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import 'tsx/esm';
import {portableMaintenanceLock} from '../../runtime/portable-config.mjs';
import {applyPortableMigrations,readPortableMigrations} from '../../runtime/portable-migrations.mjs';
import {runMarketingDrain} from '../../runtime/portable-marketing-drain.mjs';

const {queueMarketingCampaign,runMarketingCampaignPass}=await import('../../db/postgres/marketing-campaign-store.ts');
const population=31_000,limit=Number(process.argv[2]??300),rate=100,concurrency=16,latencyMs=120;
if(process.argv.length>3||!Number.isInteger(limit)||limit<100||limit>population)throw Error('Choose a sample size from 100 to 31000.');
const halt=new AbortController();
function abort(){halt.abort();}
process.once('SIGINT',abort);
process.once('SIGTERM',abort);
const binary=await import('@embedded-postgres/'+process.platform+'-'+process.arch);
// A short, owner-only socket directory works even on macOS with a deeply nested TMPDIR.
const root=await mkdtemp('/tmp/harbor-campaign-load-'),dataDir=join(root,'data');
const pgOptions={host:root,port:54821,user:'postgres',database:'postgres',max:2,connect_timeout:3,onnotice:()=>{}};
const mail={HARBOR_MARKETING_DELIVERY_ENABLED:'true',HARBOR_MARKETING_FROM:'news@example.test',
  HARBOR_MARKETING_POSTAL_ADDRESS:'1 Fictional Way, Test City',HARBOR_RESEND_API_KEY:'fictional',
  HARBOR_RESEND_WEBHOOK_SECRET:'whsec_'+Buffer.from('local').toString('base64'),HARBOR_LOGIN_ORIGIN:'https://harbor.example.test'};
const workspace=randomUUID(),owner=randomUUID(),generation=randomUUID(),design=randomUUID(),campaign=randomUUID();
let started=false,client,gate;
try{
  execFileSync(binary.initdb,['-D',dataDir,'--encoding=UTF8','--no-locale','-U','postgres','-A','trust'],{stdio:'pipe'});
  execFileSync(binary.pg_ctl,['-D',dataDir,'-l',join(root,'postgres.log'),'-o',"-k "+root+" -c listen_addresses='' -p 54821",'-w','start'],{stdio:'pipe'});
  started=true;
  client=postgres(pgOptions);
  const migrations=fileURLToPath(new URL('../../db/postgres/migrations/',import.meta.url));
  assert.equal(await applyPortableMigrations(client,readPortableMigrations(migrations)),'ok');
  await client`INSERT INTO login_identities(id,google_subject,email,created_at,updated_at)
    VALUES(${owner},${owner},'owner@example.test',0,0)`;
  await client`INSERT INTO private_workspaces(id,owner_id) VALUES(${workspace},${owner})`;
  await client`INSERT INTO portable_marketing_designs(workspace_id,id,name,subject,project,html,plain_text)
    VALUES(${workspace},${design},'Local load rehearsal','Fictional newsletter','{}','<p>Fictional newsletter</p>','Fictional newsletter')`;
  await client`INSERT INTO portable_marketing_audience_sync(workspace_id,generation,source_key,state,mapping,started_at,progressed_at,completed_at,contact_count)
    VALUES(${workspace},${generation},'fictional','ready','{}',now(),now(),now(),${population})`;
  await client`INSERT INTO portable_marketing_audience_contacts(workspace_id,generation,id,email,eligible)
    SELECT ${workspace},${generation},n::text,'reader-'||n||'@example.test',true FROM generate_series(1,${population}::int)n`;
  gate=await client.reserve();
  const [{locked}]=await gate`SELECT pg_try_advisory_lock_shared(${portableMaintenanceLock}) AS locked`;
  assert.equal(locked,true); // Same pool shape as the CLI: one reserved gate, one working connection.
  const db=drizzle(client),queueStart=performance.now();
  const queued=await queueMarketingCampaign(db,workspace,owner,{action:'queue',id:campaign,name:'Local campaign',designId:design,
    designRevision:1,filter:{},snapshot:generation,expectedTotal:population});
  assert.equal(queued.total,population);
  const queueMs=Math.round(performance.now()-queueStart);
  await client.unsafe('ANALYZE');
  // Simulate a contact unsubscribing after delivery has begun, safely beyond the in-flight window.
  const [{email:optOut}]=await client`SELECT email FROM portable_marketing_recipients WHERE workspace_id=${workspace}
    AND campaign_id=${campaign} ORDER BY due_at,id OFFSET ${Math.floor(limit/2)} LIMIT 1`;
  const ids=new Set(),addresses=new Set(),starts=[];
  let active=0,peak=0,duplicate=false,wrongKey=false;
  async function fictionalTransport(message){
    active++;peak=Math.max(peak,active);
    try{
      starts.push(performance.now());
      if(ids.has(message.tag)||addresses.has(message.to))duplicate=true;
      if(message.idempotencyKey!=='harbor-marketing/'+workspace+'/'+message.tag+'/1')wrongKey=true;
      ids.add(message.tag);addresses.add(message.to);
      if(starts.length===1)await client`INSERT INTO portable_email_suppressions(workspace_id,id,email,created_at)
        VALUES(${workspace},${randomUUID()},${optOut},now())`;
      await delay(latencyMs);
      return {id:'fictional-'+message.tag};
    }finally{active--;}
  }
  const drainStart=performance.now();
  const result=await runMarketingDrain({limit,rate,concurrency,durationMs:900_000,signal:halt.signal,paceDispatch:true,
    pass:onDispatchStarted=>runMarketingCampaignPass(db,workspace,mail,async message=>{
      onDispatchStarted();
      return fictionalTransport(message);
    })});
  const elapsed=performance.now()-drainStart;
  halt.signal.throwIfAborted();
  assert.equal(result.stoppedBy,'limit');assert.equal(result.started,limit);
  assert.deepEqual(result.counts,{accepted:limit-1,skipped:1});
  assert.equal(duplicate,false);assert.equal(wrongKey,false);
  assert.equal(ids.size,limit-1);assert.equal(addresses.size,limit-1);assert.ok(!addresses.has(optOut));
  assert.ok(peak>1&&peak<=concurrency,'expected overlapping simulated sends within the configured bound');
  // Permit timer resolution at the edges of a one-second sliding window.
  let left=0,peakPerSecond=0;
  for(let right=0;right<starts.length;right++){
    while(starts[right]-starts[left]>=1000)left++;
    peakPerSecond=Math.max(peakPerSecond,right-left+1);
  }
  assert.ok(peakPerSecond<=rate+1,'simulated provider observed '+peakPerSecond+' starts in a second');
  assert.ok(elapsed>=(starts.length-1)*(1000/rate)-2);
  await gate`SELECT pg_advisory_unlock_shared(${portableMaintenanceLock})`;
  gate.release();gate=undefined;
  await client.end();client=postgres(pgOptions); // Read durable outcomes through a fresh connection.
  const [receipts]=await client`SELECT count(*)::int AS total,count(*) FILTER (WHERE state='accepted')::int AS accepted,
    count(*) FILTER (WHERE state='queued' AND attempts=0)::int AS queued,
    count(*) FILTER (WHERE state='skipped' AND email=${optOut} AND attempts=0 AND provider_id IS NULL)::int AS skipped,
    count(*) FILTER (WHERE state='accepted' AND attempts=1 AND provider_id='fictional-'||id::text)::int AS confirmed,
    count(DISTINCT provider_id)::int AS distinct_receipts FROM portable_marketing_recipients
    WHERE workspace_id=${workspace} AND campaign_id=${campaign}`;
  assert.deepEqual({...receipts},{total:population,accepted:limit-1,queued:population-limit,skipped:1,confirmed:limit-1,distinct_receipts:limit-1});
  console.log(JSON.stringify({population,limit,rate,concurrency,latencyMs,queueMs,elapsedMs:Math.round(elapsed),
    mockAcceptancesPerSecond:Number((ids.size*1000/elapsed).toFixed(1)),peakInFlight:peak,peakStartsPerSecond:peakPerSecond,receipts,result},null,2));
}finally{
  if(gate)gate.release();
  try{await client?.end({timeout:5});}finally{
    if(started)execFileSync(binary.pg_ctl,['-D',dataDir,'-m','fast','-w','stop'],{stdio:'pipe'});
    await rm(root,{recursive:true,force:true});
    process.off('SIGINT',abort);process.off('SIGTERM',abort);
  }
}
