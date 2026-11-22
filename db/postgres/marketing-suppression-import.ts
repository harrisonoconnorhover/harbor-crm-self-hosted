import {createHash} from 'node:crypto';
import {open,type FileHandle} from 'node:fs/promises';
import {eq,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {emailSuppressions} from './email-suppression-schema';
import {privateWorkspaces} from './workspace-schema';
import {parseCSV} from '../../lib/csv-import';
import {suppressedAddress} from '../../lib/email/suppression';

const maxBytes=64*1024*1024,maxRecordChars=32*1024,maxRows=250_000;

// Frame whole quoted records across file chunks. Harbor's normal CSV parser then
// validates their quoting, field widths, headers and values in bounded batches.
async function* records(file:FileHandle,hash:ReturnType<typeof createHash>){
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let record='',quoted=false,bytes=0;
  function* consume(chunk:string){
    let start=0;
    for(const found of chunk.matchAll(/["\r\n]/g)){
      const position=found.index;
      record+=chunk.slice(start,position);
      if(record.length>maxRecordChars)throw new Error('A suppression CSV record exceeds 32,768 characters.');
      if(found[0]==='"')quoted=!quoted;
      if(found[0]==='"'||quoted)record+=found[0];
      else{
        if(record.trim())yield record;
        record='';
      }
      if(record.length>maxRecordChars)throw new Error('A suppression CSV record exceeds 32,768 characters.');
      start=position+1;
    }
    record+=chunk.slice(start);
    if(record.length>maxRecordChars)throw new Error('A suppression CSV record exceeds 32,768 characters.');
  }
  for await(const bytesChunk of file.createReadStream({autoClose:false,highWaterMark:64*1024})){
    bytes+=bytesChunk.length;
    if(bytes>maxBytes)throw new Error('Use a suppression CSV of at most 64 MiB.');
    hash.update(bytesChunk);
    yield* consume(decoder.decode(bytesChunk,{stream:true}));
  }
  yield* consume(decoder.decode());
  if(record.trim())yield record;
}

export async function importLegacySuppressions(db:PostgresJsDatabase,workspaceId:string,filePath:string,expectedSha256?:string){
  if(expectedSha256!==undefined&&!/^[a-fA-F0-9]{64}$/.test(expectedSha256)){
    throw new Error('Supply the 64-character SHA-256 printed by suppression-preview.');
  }
  const file=await open(filePath,'r');
  try{
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>maxBytes)throw new Error('Choose a regular suppression CSV file of at most 64 MiB.');
    return await db.transaction(async tx=>{
      const scope=tx.select({id:privateWorkspaces.id}).from(privateWorkspaces).where(eq(privateWorkspaces.id,workspaceId));
      // Imports serialize with this workspace's delivery admission and unsubscribe operations.
      const [workspace]=expectedSha256?await scope.for('no key update'):await scope;
      if(!workspace)throw new Error('Configured marketing workspace does not exist.');
      await tx.execute(sql`CREATE TEMP TABLE harbor_import_optouts(email text PRIMARY KEY) ON COMMIT DROP`);
      let header:string|undefined,rows=0,batchChars=0;
      const batch:string[]=[],hash=createHash('sha256');
      async function stage(){
        if(header===undefined||!batch.length)return;
        const result=parseCSV([header,...batch].join('\n'),{maxRows:250,maxBytes:2_000_000});
        if(result.rows.length!==batch.length)throw new Error('Include an email address on every suppression CSV record.');
        const candidates=result.headers.flatMap((label,index)=>['email','email address'].includes(label.toLowerCase())?[index]:[]);
        if(candidates.length!==1)throw new Error('Use exactly one Email or Email address column in the suppression CSV.');
        const addresses=result.rows.map((cells,index)=>{
          const address=suppressedAddress.safeParse(cells[candidates[0]]);
          if(!address.success)throw new Error(`Invalid email address in suppression CSV record ${rows+index+2}.`);
          return address.data;
        });
        rows+=result.rows.length;
        if(rows>maxRows)throw new Error('Use at most 250,000 suppression records per file.');
        await tx.execute(sql`INSERT INTO pg_temp.harbor_import_optouts(email)
          SELECT jsonb_array_elements_text(${JSON.stringify(addresses)}::jsonb) ON CONFLICT DO NOTHING`)
          .catch(()=>{throw new Error('The suppression import could not stage this batch in PostgreSQL.');});
        batch.length=0;batchChars=0;
      }
      for await(const record of records(file,hash)){
        if(header===undefined){header=record;continue;}
        batch.push(record);batchChars+=record.length;
        if(batch.length===250||batchChars>=256*1024)await stage();
      }
      await stage();
      if(!rows)throw new Error('Include an Email header and at least one unsubscribed address.');
      const sha256=hash.digest('hex');
      if(expectedSha256&&sha256!==expectedSha256.toLowerCase())throw new Error('This CSV changed. Preview the file again.');
      const [counts]=await tx.execute<{unique_addresses:number;already_opted_out:number}>(sql`
        SELECT count(*)::int AS unique_addresses,count(b.recipient_opted_out_at)::int AS already_opted_out
        FROM pg_temp.harbor_import_optouts i LEFT JOIN ${emailSuppressions} b
        ON b.workspace_id=${workspaceId}::uuid AND b.email=i.email`);
      if(expectedSha256){
        await tx.execute(sql`INSERT INTO ${emailSuppressions} (workspace_id,id,email,created_at,recipient_opted_out_at)
          SELECT ${workspaceId}::uuid,gen_random_uuid(),email,now(),now() FROM pg_temp.harbor_import_optouts
          ON CONFLICT (workspace_id,email) DO UPDATE SET recipient_opted_out_at=excluded.recipient_opted_out_at
          WHERE ${emailSuppressions.recipientOptedOutAt} IS NULL`);
      }
      return {mode:expectedSha256?'applied':'preview',workspaceId,sha256,rows,uniqueAddresses:counts.unique_addresses,
        alreadyOptedOut:counts.already_opted_out,newOptOuts:counts.unique_addresses-counts.already_opted_out};
    });
  }finally{await file.close();}
}
