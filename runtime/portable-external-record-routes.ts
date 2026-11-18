import {z} from 'zod';
import {currentPortableApiToken} from '../db/postgres/portable-api-token-store';
import {readExternalContactDates,readExternalPrivateRecords,readExternalRecordBatch} from '../db/postgres/portable-external-record-store';
import {portableRecordReaders} from '../db/postgres/portable-record-readers';
import {digest} from '../lib/api-access';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableExternalRecordBatch,portableExternalRecordKind,portableExternalRecordPage,validPortableBatchProperties,type PortableExternalRecordKind} from '../lib/portable-api-tokens';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {portableRateLimit} from './portable-rate-limit';

const json=(body:unknown,status=200,headers?:Record<string,string>)=>Response.json(body,{
  status,headers:{'cache-control':'private, no-store',...headers},
});
const unauthorized=(error:string)=>json({error},401,{'www-authenticate':'Bearer'});
const missing=()=>json({error:'Record not found.'},404);

async function serialize(object:PortableExternalRecordKind,row:{id:string;data:object;createdAt:string;updatedAt:string},
  dates?:{lastContacted:string|null;lastActivity:string|null}){
  const properties={...row.data} as Record<string,unknown>;
  delete properties.recordOwner;
  return {
    id:row.id,object,properties,createdAt:row.createdAt,updatedAt:row.updatedAt,
    ...dates,etag:'"'+await digest(JSON.stringify([row.id,row.updatedAt,properties]))+'"',
  };
}

async function serializeRows(db:ReturnType<typeof portableDb>,workspaceId:string,kind:PortableExternalRecordKind,
  rows:Parameters<typeof serialize>[1][]){
  const dates=kind==='contacts'?await readExternalContactDates(db,workspaceId,rows.map(row=>row.id)):undefined;
  return Promise.all(rows.map(row=>serialize(kind,row,dates?.get(row.id))));
}

async function read(request:Request,rawKind:string,{id,batch=false}:{id?:string;batch?:boolean}={}){
  try{
    const kind=portableExternalRecordKind.safeParse(rawKind);
    if(!kind.success)return missing();
    const match=/^Bearer (harbor_[a-f0-9]{64})$/i.exec(request.headers.get('authorization')??'');
    if(!match)return unauthorized('Send a Harbor access token in Authorization: Bearer <token>.');
    const hash=await digest(match[1]),db=portableDb();
    const authorize=async ()=>{
      const token=await currentPortableApiToken(db,hash);
      if(!token)return unauthorized('Access token is invalid, expired, or revoked.');
      if(portableWorkspaceGuest(token.email.toLowerCase()))return json({error:"This token's workspace access is unavailable."},403);
      if(!token.scopes.includes(kind.data+':read'))return json({error:'This token does not allow that operation on this object.'},403);
      return token;
    };
    const token=await authorize();
    if(token instanceof Response)return token;
    const limit=await portableRateLimit('api_read','token:'+token.ownerId);
    if(limit)return limit;
    const params=new URL(request.url).searchParams;
    if(batch){
      if(params.size&&(params.size!==1||params.get('archived')!=='false'))return json({error:'Invalid batch record query.'},400);
      const text=await readBoundedRequestText(request,8192);
      if(text===null)return json({error:'Batch body must not exceed 8 KiB.'},413);
      let raw:unknown;
      try{raw=JSON.parse(text);}catch{return json({error:'Invalid record batch.'},400);}
      const input=portableExternalRecordBatch.safeParse(raw);
      if(!input.success)return json({error:'Send 1–50 distinct record UUIDs and optionally up to 100 property names.'},400);
      const {properties}=input.data;
      if(!validPortableBatchProperties(kind.data,properties))return json({error:'Unknown or unavailable response property.'},400);
      const ids=input.data.inputs.map(item=>item.id.toLowerCase());
      const rows=await readExternalRecordBatch(db,token.workspaceId,kind.data,ids);
      const records=await serializeRows(db,token.workspaceId,kind.data,rows);
      const found=new Map(records.map(record=>[record.id,record]));
      const results=input.data.inputs.map(({id:identifier},index)=>{
        const record=found.get(ids[index]);
        if(!record)return {index,identifier,status:'error',error:{status:404,code:'not_found',message:'Record not found.'}};
        const selected=properties===undefined?record.properties:
          Object.fromEntries(properties.filter(field=>Object.hasOwn(record.properties,field))
            .map(field=>[field,record.properties[field]]));
        return {index,identifier,status:'found',...record,properties:selected};
      });
      const current=await authorize();
      if(current instanceof Response)return current;
      return json({results},results.some(item=>item.status==='error')?207:200);
    }
    if(params.size!==new Set(params.keys()).size||id&&params.size)return json({error:'Invalid record query.'},400);
    const input=portableExternalRecordPage.safeParse(Object.fromEntries(params));
    if(!input.success)return json({error:'Invalid record query.'},400);
    if(id&&!z.string().guid("Invalid uuid").safeParse(id).success)return missing();

    // Keep the read in the issuing owner's private workspace even if the owner is also a guest elsewhere.
    const query={...input.data,id};
    const record=kind.data==='tasks'||kind.data==='leads'||kind.data==='tickets'
      ?await readExternalPrivateRecords(db,token.workspaceId,kind.data,query)
      :await portableRecordReaders[kind.data](db,token.ownerId,query);
    const page=record&&'records' in record?record:null;
    const rows=page?page.records:record&&'data' in record?[record]:[];
    const results=await serializeRows(db,token.workspaceId,kind.data,rows);
    const current=await authorize();
    if(current instanceof Response)return current;
    if(page)return json({results,next:page.next?{after:page.next}:null});
    const [result]=results;
    return result?json(result,200,{etag:result.etag}):missing();
  }catch{
    return json({error:'Could not finish this record request.'},503);
  }
}

export async function externalRecords(request:Request,context:{params:Promise<{kind:string}>}){
  return read(request,(await context.params).kind);
}

export async function externalRecord(request:Request,context:{params:Promise<{kind:string;id:string}>}){
  const {kind,id}=await context.params;
  return read(request,kind,{id});
}

export async function externalRecordBatch(request:Request,context:{params:Promise<{kind:string}>}){
  return read(request,(await context.params).kind,{batch:true});
}
