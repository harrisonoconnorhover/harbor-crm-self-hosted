import {Worker} from 'node:worker_threads';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {finishPortableCodeJob,readPortableCodePayload} from '../db/postgres/code-job-store';
import type {Claim} from '../db/postgres/job-store';
import {portableCodeOutput,type PortableCodePayload} from '../lib/portable-workflow-code';

const codeDeadlineMs=2_000;

async function evaluateInThread(file:URL,{code,inputFields}:PortableCodePayload){
  const worker=new Worker(file,{workerData:{code,inputFields},env:{},execArgv:[],stdout:true,stderr:true});
  // Keep guest-related diagnostics out of both the worker log and the receipt.
  worker.stdout.resume();
  worker.stderr.resume();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await new Promise<Record<string,unknown>|null>(resolve=>{
      timer=setTimeout(()=>resolve(null),codeDeadlineMs);
      worker.once('message',resolve);
      worker.once('error',()=>resolve(null));
      worker.once('exit',()=>resolve(null));
    });
  }finally{
    clearTimeout(timer);
    void worker.terminate().catch(()=>{});
  }
}

export async function runPortableCodeJob(db:PostgresJsDatabase,claim:Claim,sandboxFile:URL){
  const payload=await readPortableCodePayload(db,claim);
  if(!payload)return finishPortableCodeJob(db,claim,{issue:'authority_changed'});
  const outputs=await evaluateInThread(sandboxFile,payload).catch(()=>null);
  if(!outputs)return finishPortableCodeJob(db,claim,{issue:'code_action_failed'});
  const result=portableCodeOutput(outputs,payload.outputs);
  return finishPortableCodeJob(db,claim,result?{result}:{issue:'code_output_invalid'});
}
