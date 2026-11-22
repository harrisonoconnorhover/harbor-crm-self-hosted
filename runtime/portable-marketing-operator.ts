import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as wait} from 'node:timers/promises';
import {drizzle} from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {z} from 'zod';
import {configuredMarketingWorkspace} from '../db/postgres/marketing-workspace-store';
import {marketingAudienceStatus,syncConfiguredMarketingAudience} from '../db/postgres/marketing-audience-store';
import {importLegacySuppressions} from '../db/postgres/marketing-suppression-import';
import {exportSalesforceOptOuts} from '../db/postgres/marketing-suppression-export';
import {listMarketingCampaigns,marketingDeliveryIssues,runMarketingCampaignPass} from '../db/postgres/marketing-campaign-store';
import {configureMarketingForm,listMarketingFormDeliveries,resolveMarketingFormDelivery,runMarketingFormPass} from '../db/postgres/marketing-form-store';
import {resendCooldownUntil} from '../db/postgres/marketing-mail-cooldown';
import {sendMarketingEmail} from '../lib/marketing-mail-transport.mjs';
import {runMarketingDrain} from './portable-marketing-drain.mjs';
import {portableMaintenanceLock} from './portable-config.mjs';
import {portableMigrationHistory,readPortableMigrations} from './portable-migrations.mjs';

const usage='Use marketing sync, status, suppression-preview FILE, suppression-import FILE SHA256, suppression-export NEW_FILE, deliver [1–100], drain [--limit N] [--rate N | --rate-slots FIRST-LAST] [--concurrency N --seconds N], form-config FORM_ID JSON, forms-run [1–100] [--rate-slots FIRST-LAST], forms-status, or form-resolve DELIVERY_ID confirmed|retry|skip EVIDENCE.';
// Ordinary senders keep the exclusive lock. Cooperating drains also reserve disjoint rate slots.
const marketingSenderLock=943157313;
function parseRateSlots(value:string|undefined){
  if(value===undefined)return;
  const range=/^([1-9]\d{0,2})-([1-9]\d{0,2})$/.exec(value);
  if(!range||Number(range[1])>Number(range[2])||Number(range[2])>100)
    throw Error('Use an inclusive rate slot range from 1 to 100, such as 1-2.');
  return {first:Number(range[1]),last:Number(range[2])};
}
function formRunOptions(args:string[]){
  const {values,positionals}=parseArgs({args,allowPositionals:true,options:{'rate-slots':{type:'string'}}});
  if(positionals.length>1)throw Error(usage);
  return {slots:parseRateSlots(values['rate-slots']),limit:z.coerce.number().int().min(1).max(100).parse(positionals[0]??10)};
}
function drainOptions(args:string[]){
  const {values}=parseArgs({args,options:{
    limit:{type:'string',default:'100'},rate:{type:'string'},'rate-slots':{type:'string'},
    concurrency:{type:'string',default:'1'},seconds:{type:'string',default:'60'},
  }});
  const bounded=(value:string|undefined,max:number)=>z.coerce.number().int().min(1).max(max).parse(value);
  const slots=parseRateSlots(values['rate-slots']);
  if(slots&&values.rate!==undefined)throw Error('Choose either --rate or --rate-slots.');
  return {limit:bounded(values.limit,100000),slots,rate:slots?slots.last-slots.first+1:bounded(values.rate??'2',100),
    concurrency:bounded(values.concurrency,32),durationMs:bounded(values.seconds,3600)*1000};
}
export async function runMarketingCommand(args:string[],dbUrl:string){
  const [cmd,...rest]=args,ws=configuredMarketingWorkspace();
  if(!ws)throw Error('Set HARBOR_MARKETING_WORKSPACE_ID to the workspace that owns this integration.');
  const options=cmd==='drain'?drainOptions(rest):null;
  const formRun=cmd==='forms-run'?formRunOptions(rest):null;
  const slots=options?.slots??formRun?.slots;
  const delivery=cmd==='deliver'||cmd==='forms-run'||cmd==='drain';
  const stop=new AbortController();
  const interrupt=()=>stop.abort();
  let closing=false;
  // Keep the lock connection for the lifetime of the pass. Stop taking work on connection loss.
  const client=postgres(dbUrl,{max:2,connect_timeout:5,idle_timeout:0,max_lifetime:0,connection:delivery?{statement_timeout:15000}:undefined,
    onnotice:()=>{},onclose:()=>{
      if(!closing&&delivery&&!stop.signal.aborted){
        interrupt();
        console.warn('Marketing worker lost a database connection. Stopping new deliveries.');
      }
    }});
  const gate=await client.reserve();
  try{
    const [lock]=await gate`SELECT pg_try_advisory_lock_shared(${portableMaintenanceLock}) AS ok`;
    if(!lock.ok)throw Error('Harbor is in maintenance. Retry after it finishes.');
    // This command is loaded from the compiled worker package, like the ordinary worker.
    const folder=fileURLToPath(new URL('../../../db/postgres/migrations/',import.meta.url));
    if((await portableMigrationHistory(gate,readPortableMigrations(folder))).status!=='ok')throw Error('Apply the migrations for this Harbor build first.');
    if(delivery){
      const [sender]=slots?await gate`SELECT pg_try_advisory_lock_shared(${marketingSenderLock}) AS ok`:
        await gate`SELECT pg_try_advisory_lock(${marketingSenderLock}) AS ok`;
      let acquired=sender.ok;
      if(acquired&&slots){
        // Two-integer advisory keys are separate from the installation's single-key locks.
        const [reservation]=await gate`SELECT bool_and(pg_try_advisory_lock(${marketingSenderLock}::int,slot)) AS ok
          FROM generate_series(${slots.first}::int,${slots.last}::int) AS slots(slot)`;
        acquired=reservation.ok;
      }
      if(!acquired){
        console.log(JSON.stringify({started:0,stoppedBy:'operator_busy'}));
        return;
      }
      process.on('SIGTERM',interrupt);
      process.on('SIGINT',interrupt);
    }
    const db=drizzle(client);
    let result:unknown;
    if(cmd==='sync'&&!rest.length)result=await syncConfiguredMarketingAudience(db,ws,process.env);
    else if(cmd==='suppression-preview'&&rest.length===1)result=await importLegacySuppressions(db,ws,rest[0]);
    else if(cmd==='suppression-import'&&rest.length===2)result=await importLegacySuppressions(db,ws,rest[0],rest[1]);
    else if(cmd==='suppression-export'&&rest.length===1)result=await exportSalesforceOptOuts(db,ws,rest[0]);
    else if(cmd==='status'&&!rest.length)result={audience:await marketingAudienceStatus(db,ws),
      providerRetryAtMs:await resendCooldownUntil(db),campaigns:(await listMarketingCampaigns(db,ws)).items,issues:(await marketingDeliveryIssues(db,ws)).items};
    else if(options){
      result=await runMarketingDrain({...options,signal:stop.signal,paceDispatch:true,
        pass:(onDispatchStarted:()=>void)=>runMarketingCampaignPass(db,ws,process.env,(message,env)=>{
          onDispatchStarted();
          return sendMarketingEmail(message,env);
        },stop.signal)});
    }else if(formRun||(cmd==='deliver'&&rest.length<=1)){
      const limit=formRun?.limit??z.coerce.number().int().min(1).max(100).parse(rest[0]??10);
      const pauseMs=slots?Math.ceil(1000/(slots.last-slots.first+1)):500;
      const counts:Record<string,number>={};
      for(let i=0;i<limit&&!stop.signal.aborted;i++){
        const state=cmd==='deliver'?await runMarketingCampaignPass(db,ws,process.env,undefined,stop.signal):
          (await runMarketingFormPass(db,ws,process.env,undefined,stop.signal)).status;
        counts[state]=(counts[state]??0)+1;
        if(['stopped','idle','disabled','waiting_for_sync','uncertain','failed','retry','throttled'].includes(state))break;
        if(i+1<limit)await wait(pauseMs);
      }
      result=counts;
    }else if(cmd==='form-config'&&rest.length===2)result=await configureMarketingForm(db,ws,z.uuid().parse(rest[0]),JSON.parse(rest[1]));
    else if(cmd==='forms-status'&&!rest.length)result=await listMarketingFormDeliveries(db,ws);
    else if(cmd==='form-resolve'&&rest.length===3)result=await resolveMarketingFormDelivery(db,ws,z.uuid().parse(rest[0]),
      z.enum(['confirmed','retry','skip']).parse(rest[1]),rest[2]);
    else throw Error(usage);
    console.log(JSON.stringify(result??{ok:true}));
  }finally{
    process.off('SIGTERM',interrupt);
    process.off('SIGINT',interrupt);
    // Closing the pool also releases a partially acquired slot range on the busy path.
    closing=true;gate.release();await client.end({timeout:3});
  }
}
