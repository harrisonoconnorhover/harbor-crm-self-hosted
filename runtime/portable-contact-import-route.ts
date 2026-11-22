import {commitPortablePairedImport,commitPortableRecordImport,previewPortablePairedImport,previewPortableRecordImport} from '../db/postgres/contact-import-store';
import {listPortableCustomProperties} from '../db/postgres/custom-property-store';
import {ApiError} from '../lib/api-error';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {sha256} from '../lib/email/crypto';
import {mapPortableRecordCsv,portableRecordImportRequest} from '../lib/portable-contact-import';
import {mapPortablePairedCsv} from '../lib/portable-paired-import';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

export async function POST(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    if(user.guest||new URL(request.url).search)return json({error:'Import records into your own workspace.'},403);
    let raw:unknown;
    try{
      const text=await readBoundedRequestText(request,2_000_000);
      if(text!==null)raw=JSON.parse(text);
    }catch{}
    const parsed=portableRecordImportRequest.safeParse(raw);
    if(!parsed.success)return json({error:'Choose a CSV of up to 250 KB and preview it before importing.'},400);
    const input=parsed.data;
    const db=portableDb();
    if(input.kind==='paired'){
      if(input.action==='columns'){
        const csv=mapPortablePairedCsv(input.csv);
        return json({columns:csv.headers.map((header,index)=>({header,target:csv.mapping[index]}))});
      }
      if(input.action==='preview')return json(await previewPortablePairedImport(db,user,input.csv,input.mapping));
      const committed=await commitPortablePairedImport(db,user.userId,input);
      return json(committed.result,committed.replayed?200:201);
    }
    if(input.action==='columns'){
      const properties=await listPortableCustomProperties(db,user.userId,input.kind);
      const csv=mapPortableRecordCsv(input.kind,input.csv,undefined,properties,true,input.reviewMatches);
      return json({columns:csv.headers.map((header,index)=>({header,target:csv.mapping[index]}))});
    }
    const sourceHash=await sha256(input.csv);
    if(input.action==='preview')return json(await previewPortableRecordImport(db,user,input.kind,sourceHash,input.csv,input.mapping,input.reviewMatches));
    const committed=await commitPortableRecordImport(db,user.userId,{...input,kind:input.kind},sourceHash);
    return json(committed.result,committed.replayed?200:201);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    console.error('Portable CSV import request failed.');
    return json({error:'Could not confirm this import. Retry the same request.'},503);
  }
}
