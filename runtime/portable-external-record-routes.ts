import {changePortableAssociation} from '../db/postgres/portable-association-store';
import {portableAssociationLabelInput,type PortableAssociationAction} from '../lib/portable-associations';
import {readExternalAssociationPages,readExternalAssociations} from '../db/postgres/external-association-store';
import {portableRecordKind,type PortableRecordKind} from '../lib/portable-records';
import {ApiError} from '../lib/api-error';
import {lockRecordWorkspace} from '../db/postgres/private-workspace-store';
import {mutateExternalCore} from '../db/postgres/portable-api-core-mutation';
import {mutateExternalService} from '../db/postgres/portable-api-service-mutation';
import {recordIntegrationAccess} from '../db/postgres/record-access-store';
import {z} from 'zod';
import {currentPortableApiToken} from '../db/postgres/portable-api-token-store';
import {matchExternalIdentifiers,lockExternalRecord,readExternalArchives,readExternalDeletions,readExternalProperties,readExternalUpdatedRecords,readExternalContactDates,readExternalPrivateRecords,readExternalRecordBatch} from '../db/postgres/portable-external-record-store';
import {portableRecordReaders} from '../db/postgres/portable-record-readers';
import {digest} from '../lib/api-access';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableAssociationBatch,portableApiPrimaryLinks,type PortableApiPrimaryLinks,portableExternalRecordBatch,portableExternalRecordKind,portableExternalRecordPage,portableArchivedRecordPage,portableDeletedRecordPage,portableUpdatedRecordPage,portableResponseProperties,validPortableBatchProperties,type PortableExternalRecordKind} from '../lib/portable-api-tokens';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {portableRateLimit} from './portable-rate-limit';

const json=(body:unknown,status=200,headers?:Record<string,string>)=>Response.json(body,{
  status,headers:{'cache-control':'private, no-store',...headers},
});
const unauthorized=(error:string)=>json({error},401,{'www-authenticate':'Bearer'});
const missing=()=>json({error:'Record not found.'},404);

async function requestTokenHash(request:Request){
  const matched=/^Bearer (harbor_[a-f0-9]{64})$/i.exec(request.headers.get('authorization')??'');
  return matched?digest(matched[1]):null;
}

async function authorizeRecordRequest(db:ReturnType<typeof portableDb>,hash:string,kind:PortableExternalRecordKind,scopes:string[],lock=false){
  const token=await currentPortableApiToken(db,hash,lock);
  if(!token)return unauthorized('Access token is invalid, expired, or revoked.');
  if(portableWorkspaceGuest(token.email.toLowerCase()))return json({error:"This token's workspace access is unavailable."},403);
  // Existing archive keys can also read lifecycle receipts. The reverse would grant a destructive permission.
  return scopes.every(scope=>token.scopes.includes(kind+':'+scope)||
    scope==='archive_history'&&token.scopes.includes(kind+':archive'))?token:
    json({error:'This token does not allow that operation on this object.'},403);
}

async function serialize(object:PortableExternalRecordKind,row:{id:string;revision:number;data:object;createdAt:string;updatedAt:string},
  dates?:{lastContacted:string|null;lastActivity:string|null}){
  const properties={...row.data} as Record<string,unknown>;
  delete properties.recordOwner;
  return {
    id:row.id,object,properties,createdAt:row.createdAt,updatedAt:row.updatedAt,
    ...dates,etag:'"'+await digest(JSON.stringify([row.id,row.revision,row.updatedAt,properties]))+'"',
  };
}

async function serializeRows(db:ReturnType<typeof portableDb>,workspaceId:string,kind:PortableExternalRecordKind,
  rows:Parameters<typeof serialize>[1][],fields?:string[]){
  const dates=kind==='contacts'?await readExternalContactDates(db,workspaceId,rows.map(row=>row.id)):undefined;
  const records=await Promise.all(rows.map(row=>serialize(kind,row,dates?.get(row.id))));
  return fields===undefined?records:records.map(record=>({...record,properties:projectProperties(record.properties,fields)}));
}

function projectProperties(values:Record<string,unknown>,fields:string[]){
  const selected=Object.fromEntries(fields.filter(field=>Object.hasOwn(values,field)).map(field=>[field,values[field]]));
  if(fields.includes('custom')||!values.custom||typeof values.custom!=='object')return selected;
  const custom=values.custom as Record<string,unknown>;
  const matches=Object.fromEntries(fields.filter(field=>field.startsWith('custom:')).map(field=>field.slice(7).toLowerCase())
    .filter(key=>Object.hasOwn(custom,key)).map(key=>[key,custom[key]]));
  return Object.keys(matches).length?{...selected,custom:matches}:selected;
}

async function checkCustomSelection(db:ReturnType<typeof portableDb>,workspaceId:string,kind:PortableExternalRecordKind,fields?:string[]){
  const customIds=fields?.filter(field=>field.startsWith('custom:')).map(field=>field.slice(7).toLowerCase());
  if(!customIds?.length)return;
  const catalog=await readExternalProperties(db,workspaceId,kind);
  const visible=new Set(catalog.customProperties.map(property=>property.id));
  if(customIds.some(id=>!visible.has(id)))throw new ApiError(400,'Unknown or unavailable response property.');
}

async function read(request:Request,rawKind:string,{id,batch=false,catalog=false}:{id?:string;batch?:boolean;catalog?:boolean}={}){
  try{
    const kind=portableExternalRecordKind.safeParse(rawKind);
    if(!kind.success)return missing();
    const hash=await requestTokenHash(request);
    if(!hash)return unauthorized('Send a Harbor access token in Authorization: Bearer <token>.');
    const params=new URL(request.url).searchParams;
    const archived=!catalog&&params.get('archived')==='true';
    const deleted=['deletedSince','deletedBefore','afterDeletedAt'].some(key=>params.has(key));
    const scopes=archived||deleted?['read','archive_history']:['read'];
    const db=portableDb(),authorize=()=>authorizeRecordRequest(db,hash,kind.data,scopes);
    const token=await authorize();
    if(token instanceof Response)return token;
    const audit=async (recordIds:string[])=>{
      if(request.method!=='HEAD'){
        await recordIntegrationAccess(db,token,kind.data,'read',recordIds);
      }
    };
    const limit=await portableRateLimit('api_read','token:'+token.ownerId);
    if(limit)return limit;
    if(deleted){
      const window=portableDeletedRecordPage.safeParse(Object.fromEntries(params));
      if(id||batch||catalog||params.size!==new Set(params.keys()).size||!window.success)return json({error:'Invalid deletion window.'},400);
      const page=await readExternalDeletions(db,token.workspaceId,kind.data,window.data);
      const current=await authorize();
      if(current instanceof Response)return current;
      await audit(page.results.map(row=>row.id));
      return json(page);
    }
    if(catalog){
      if(params.size)return json({error:'Property discovery takes no query parameters.'},400);
      const schema=await db.transaction(tx=>readExternalProperties(tx,token.workspaceId,kind.data),{isolationLevel:'repeatable read',accessMode:'read only'});
      const current=await authorize();
      return current instanceof Response?current:json(schema);
    }
    if(batch){
      if(params.size&&(params.size!==1||(!archived&&params.get('archived')!=='false')))return json({error:'Invalid batch record query.'},400);
      const text=await readBoundedRequestText(request,8192);
      if(text===null)return json({error:'Batch body must not exceed 8 KiB.'},413);
      let raw:unknown;
      try{raw=JSON.parse(text);}catch{return json({error:'Invalid record batch.'},400);}
      const input=portableExternalRecordBatch.safeParse(raw);
      if(!input.success)return json({error:'Send 1–50 distinct identifiers. Use record UUIDs, contact email, company domain or a readable custom text field.'},400);
      const {properties,idProperty}=input.data;
      if(idProperty&&archived)return json({error:'Archived lookup requires record UUIDs.'},400);
      if(idProperty==='email'&&kind.data!=='contacts'||idProperty==='domain'&&kind.data!=='companies')
        return json({error:'Email lookup is for contacts and domain lookup is for companies.'},400);
      if(!validPortableBatchProperties(kind.data,properties))return json({error:'Unknown or unavailable response property.'},400);
      const ids=input.data.inputs.map(item=>idProperty?item.id:item.id.toLowerCase());
      if(archived){
        if(properties!==undefined)return json({error:'Archived reads return IDs and archive times only. Omit properties.'},400);
        const page=await readExternalArchives(db,token.workspaceId,kind.data,{ids,limit:ids.length});
        const found=new Map(page.results.map(row=>[row.id,row]));
        const results=input.data.inputs.map(({id:identifier},index)=>{
          const record=found.get(ids[index]);
          return record?{index,identifier,status:'found',...record}:
            {index,identifier,status:'error',error:{status:404,code:'not_found',message:'Record not found.'}};
        });
        const current=await authorize();
        if(current instanceof Response)return current;
        await audit(ids.filter(id=>found.has(id)));
        return json({results},found.size<ids.length?207:200);
      }
      const {matches,records}=await db.transaction(async tx=>{
        await checkCustomSelection(tx,token.workspaceId,kind.data,properties);
        const matches=idProperty?await matchExternalIdentifiers(tx,token.workspaceId,kind.data,idProperty,ids):new Map(ids.map(id=>[id,id]));
        const recordIds=Array.from(matches.values()).filter((value):value is string=>value!==null);
        const rows=recordIds.length?await readExternalRecordBatch(tx,token.workspaceId,kind.data,recordIds):[];
        return {matches,records:await serializeRows(tx,token.workspaceId,kind.data,rows,properties)};
      },{isolationLevel:'repeatable read',accessMode:'read only'});
      const found=new Map(records.map(record=>[record.id,record]));
      const results=input.data.inputs.map(({id:identifier},index)=>{
        const match=matches.get(ids[index]);
        if(match===null)return {index,identifier,status:'error',error:{status:409,code:'ambiguous',message:'Multiple active records match this identifier.'}};
        const record=match?found.get(match):undefined;
        if(!record)return {index,identifier,status:'error',error:{status:404,code:'not_found',message:'Record not found.'}};
        return {index,identifier,status:'found',...record};
      });
      const current=await authorize();
      if(current instanceof Response)return current;
      await audit(results.flatMap(item=>'id' in item?[item.id]:[]));
      return json({results},results.some(item=>item.status==='error')?207:200);
    }
    if(params.size!==new Set(params.keys()).size)return json({error:'Invalid record query.'},400);
    if(params.get('archived')==='false'||archived)params.delete('archived');
    const selection=params.get('properties');
    let properties:string[]|undefined;
    if(selection!==null){
      if(archived)return json({error:'Archived reads return IDs and archive times only. Omit properties.'},400);
      const fields=portableResponseProperties.safeParse(selection===''?[]:selection.split(',',101));
      if(!fields.success||!validPortableBatchProperties(kind.data,fields.data))return json({error:'Unknown or unavailable response property.'},400);
      properties=fields.data;
      params.delete('properties');
    }
    if(id&&params.size)return json({error:'Invalid record query.'},400);
    const windowed=[...params.keys()].some(key=>key!=='limit'&&key!=='after');
    const fields=Object.fromEntries(params);
    const window=windowed?(archived?portableArchivedRecordPage:portableUpdatedRecordPage).safeParse(fields):undefined;
    const input=window??portableExternalRecordPage.safeParse(fields);
    if(!input.success)return json({error:'Invalid record query.'},400);
    if(id&&!z.string().guid("Invalid uuid").safeParse(id).success)return missing();

    // Keep the read in the issuing owner's private workspace even if the owner is also a guest elsewhere.
    const query={...input.data,id};
    if(archived){
      const page=await readExternalArchives(db,token.workspaceId,kind.data,{...query,window:window?.data});
      const current=await authorize();
      if(current instanceof Response)return current;
      await audit(page.results.map(row=>row.id));
      if(!id)return json(page);
      return page.results.length?json(page.results[0]):missing();
    }
    const {page,results}=await db.transaction(async tx=>{
      await checkCustomSelection(tx,token.workspaceId,kind.data,properties);
      const record=window?.success?await readExternalUpdatedRecords(tx,token.workspaceId,kind.data,window.data)
        :kind.data==='tasks'||kind.data==='leads'||kind.data==='tickets'
        ?await readExternalPrivateRecords(tx,token.workspaceId,kind.data,query)
        :await portableRecordReaders[kind.data](tx,token.ownerId,query,true);
      const page=record&&'records' in record?record:null;
      const rows=page?page.records:record&&'data' in record?[record]:[];
      return {page,results:await serializeRows(tx,token.workspaceId,kind.data,rows,properties)};
    },{isolationLevel:'repeatable read',accessMode:'read only'});
    const current=await authorize();
    if(current instanceof Response)return current;
    await audit(results.map(row=>row.id));
    if(page)return json({results,next:typeof page.next==='string'?{after:page.next}:page.next});
    const [result]=results;
    return result?json(result,200,{etag:result.etag}):missing();
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Could not finish this record request.'},503);
  }
}

type AssociationContext={params:Promise<{kind:string;id:string;targetKind:string;targetId?:string}>};

async function authorizeAssociationRequest(db:ReturnType<typeof portableDb>,hash:string,source:PortableRecordKind,target:PortableRecordKind,writing=false,lock=false){
  const scopes=writing?['read','write']:['read'];
  const token=await authorizeRecordRequest(db,hash,source,scopes,lock);
  if(token instanceof Response)return token;
  if(!scopes.every(scope=>token.scopes.includes('associations:'+scope)&&token.scopes.includes(target+':'+scope)))
    return json({error:'Choose relationship access and matching access to both record types.'},403);
  return token;
}

async function publicAssociation(row:NonNullable<Awaited<ReturnType<typeof readExternalAssociations>>>['results'][number]){
  const {linkId,...item}=row;
  return linkId?{...item,etag:await linkEtag(row)}:{...item,etag:undefined};
}

export async function externalAssociationBatch(request:Request,context:{params:Promise<{kind:string;targetKind:string}>}){
  try{
    const params=await context.params;
    const source=portableRecordKind.safeParse(params.kind),target=portableRecordKind.safeParse(params.targetKind);
    if(!source.success||!target.success)return missing();
    const db=portableDb(),hash=await requestTokenHash(request);
    if(!hash)return unauthorized('Send a Harbor access token.');
    const authorize=()=>authorizeAssociationRequest(db,hash,source.data,target.data);
    const token=await authorize();
    if(token instanceof Response)return token;
    const limited=await portableRateLimit('api_read','token:'+token.ownerId);
    if(limited)return limited;
    if(new URL(request.url).search)return json({error:'Supply per-record cursors in the request body.'},400);
    const text=await readBoundedRequestText(request,8192);
    if(text===null)return json({error:'Batch body must not exceed 8 KiB.'},413);
    const {inputs,limit}=portableAssociationBatch.parse(JSON.parse(text));
    const pages=await db.transaction(async tx=>{
      const pages=await readExternalAssociationPages(tx,token.workspaceId,source.data,target.data,inputs,limit);
      const accessed=new Map<PortableRecordKind,Set<string>>();
      function note(kind:PortableRecordKind,id:string){
        let ids=accessed.get(kind);
        if(!ids){ids=new Set();accessed.set(kind,ids);}
        ids.add(id);
      }
      pages.forEach((page,i)=>{
        if(!page)return;
        note(source.data,inputs[i].id);
        for(const row of page.results)note(target.data,row.id);
      });
      for(const [kind,seen] of accessed){
        const ids=Array.from(seen);
        for(let i=0;i<ids.length;i+=500)await recordIntegrationAccess(tx,token,kind,'read',ids.slice(i,i+500));
      }
      return pages;
    },{isolationLevel:'repeatable read'});
    const current=await authorize();
    if(current instanceof Response)return current;
    const results=await Promise.all(pages.map(async(page,index)=>{
      const id=inputs[index].id;
      return page?{index,id,status:'found',results:await Promise.all(page.results.map(publicAssociation)),next:page.next}:
        {index,id,status:'error',error:{status:404,code:'not_found',message:'Record not found.'}};
    }));
    return json({results},pages.some(page=>!page)?207:200);
  }catch(error){
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Send 1–50 distinct source IDs, optional per-source cursors and a limit of 1–50.'},400);
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Could not read the requested relationships.'},503);
  }
}

export async function externalAssociations(request:Request,context:AssociationContext){
  try{
    const params=await context.params;
    const source=portableRecordKind.safeParse(params.kind),target=portableRecordKind.safeParse(params.targetKind);
    if(!source.success||!target.success||!recordId.safeParse(params.id).success||
      params.targetId!==undefined&&!recordId.safeParse(params.targetId).success)return missing();
    const id=params.id.toLowerCase(),targetId=params.targetId?.toLowerCase();
    const writing=request.method==='PUT'||request.method==='DELETE';
    const db=portableDb(),hash=await requestTokenHash(request);
    if(!hash)return unauthorized('Send a Harbor access token.');
    const authorize=(connection=db,lock=false)=>authorizeAssociationRequest(connection,hash,source.data,target.data,writing,lock);
    const token=await authorize();
    if(token instanceof Response)return token;
    const limited=await portableRateLimit(writing?'api_write':'api_read','token:'+token.ownerId);
    if(limited)return limited;
    const query=new URL(request.url).searchParams;
    const input=portableExternalRecordPage.safeParse(Object.fromEntries(query));
    if((targetId&&query.size)||query.size!==new Set(query.keys()).size||!input.success)return json({error:'Invalid relationship page.'},400);
    if(writing){
      if(!targetId)return missing();
      if(source.data===target.data&&id===targetId)return json({error:'Choose two different records.'},400);
      const raw=await readBoundedRequestText(request,4096);
      if(raw===null)return json({error:'Relationship body exceeds 4 KiB.'},413);
      const removing=request.method==='DELETE';
      const expected=request.headers.get('if-match');
      if(removing&&!expected)return json({error:'Send the labeled link ETag in If-Match.'},428);
      if(removing&&raw)return json({error:'DELETE takes no body.'},400);
      const from={kind:source.data,id},to={kind:target.data,id:targetId};
      const labels=removing?[]:portableAssociationLabelInput.parse(JSON.parse(raw)).labels;
      return await db.transaction(async tx=>{
        const workspace=await lockRecordWorkspace(tx,token.ownerId,false,undefined,undefined,true);
        if(workspace!==token.workspaceId)return json({error:'Workspace access changed.'},403);
        const active=await authorize(tx,true);
        if(active instanceof Response)return active;
        let action:PortableAssociationAction={action:'link',target:to,labels};
        if(removing||expected!==null){
          const pair=await readExternalAssociations(tx,workspace,from.kind,id,to.kind,{limit:1},targetId);
          const existing=pair?.results[0];
          if(!existing?.linkId||expected!==await linkEtag(existing))return json({error:'Read the current labeled relationship before changing it.'},412);
          action=removing?{action:'unlink',linkId:existing.linkId}:
            {action:'relabel',linkId:existing.linkId,expectedLabels:existing.labels,labels};
        }
        const changed=await changePortableAssociation(tx,active.ownerId,from,action);
        if(changed==='missing')return missing();
        if(changed==='conflict')return json({error:'These records already have a link with different labels.'},409);
        if(changed==='stale')return json({error:'The link changed. Read the pair again.'},412);
        if(changed!=='linked'&&changed!=='relabeled'&&changed!=='removed')throw Error('Association write failed');
        if(!await currentPortableApiToken(tx,hash))throw new ApiError(401,'Access token has expired.');
        await recordIntegrationAccess(tx,active,from.kind,'update',[id]);
        await recordIntegrationAccess(tx,active,to.kind,'update',[targetId]);
        return new Response(null,{status:204,headers:{'cache-control':'private, no-store'}});
      });
    }
    const page=await db.transaction(async tx=>{
      const page=await readExternalAssociations(tx,token.workspaceId,source.data,id,target.data,input.data,targetId);
      if(page&&(!targetId||page.results.length)&&request.method!=='HEAD'){
        const targets=page.results.map(row=>row.id);
        if(source.data===target.data)await recordIntegrationAccess(tx,token,source.data,'read',[id,...targets]);
        else{
          await recordIntegrationAccess(tx,token,source.data,'read',[id]);
          await recordIntegrationAccess(tx,token,target.data,'read',targets);
        }
      }
      return page;
    },{isolationLevel:'repeatable read'});
    const current=await authorize();
    if(current instanceof Response)return current;
    if(!page)return missing();
    const results=await Promise.all(page.results.map(publicAssociation));
    if(!targetId)return json({results,next:page.next});
    const item=results[0];
    return item?json(item,200,item.etag?{etag:item.etag}:undefined):missing();
  }catch(error){
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Send the relationship labels in a JSON array inside the labels property.'},400);
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Relationship request could not be confirmed. Read the pair before retrying.'},503);
  }
}

// Merges can change labels in place, and an unlink/relink can recreate the same labels.
async function linkEtag(row:{linkId:string|null;labels:string[];primary:boolean;reversePrimary:boolean}){
  return '"'+await digest(JSON.stringify([row.linkId,row.labels,row.primary,row.reversePrimary]))+'"';
}

export async function externalProperties(request:Request,context:RouteContext){
  return read(request,(await context.params).kind,{catalog:true});
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

const recordId=z.string().guid();
const properties=z.record(z.string(),z.unknown());
const createInput=z.object({id:recordId,properties,primary:portableApiPrimaryLinks.optional()}).strict();
const patchInput=createInput.omit({id:true});
type RouteContext={params:Promise<{kind:string;id?:string}>};

type WriteContext={
  db:ReturnType<typeof portableDb>;admitted:NonNullable<Awaited<ReturnType<typeof currentPortableApiToken>>>;
  hash:string;objectKind:PortableExternalRecordKind;scopes:string[];
};
function writeRecord({db,admitted,hash,objectKind,scopes}:WriteContext,action:'create'|'patch'|'archive',id:string,
  fields:Record<string,unknown>,expected:string|null,primary?:PortableApiPrimaryLinks){
  return db.transaction(async tx=>{
    // Match the record editor's lock order. Revocation and ownership transfer cannot split this operation.
    const workspace=await lockRecordWorkspace(tx,admitted.ownerId,false,undefined,undefined,true);
    if(workspace!==admitted.workspaceId)return json({error:'Workspace access changed.'},403);
    const active=await authorizeRecordRequest(tx,hash,objectKind,scopes,true);
    if(active instanceof Response)return active;
    if(active.workspaceId!==workspace)return json({error:'Workspace access changed.'},403);
    if(primary){
      if(objectKind!=='deals'&&(objectKind!=='contacts'||primary.contactId!==undefined))
        return json({error:'Contacts accept a primary company. Deals accept a primary company and contact.'},400);
      const targets=[...(primary.companyId!==undefined?['companies']:[]),...(primary.contactId!==undefined?['contacts']:[])];
      if(!active.scopes.includes('associations:primary')||!targets.every(kind=>active.scopes.includes(kind+':read')&&active.scopes.includes(kind+':write')))
        return json({error:'Choose primary relationship access and edit access to both record types.'},403);
    }
    const locked=await lockExternalRecord(tx,workspace,objectKind,id);
    if(action==='create'&&locked)return json({error:'This record ID already exists. Read it to reconcile the previous request.'},409);
    if(action!=='create'){
      if(!locked)return missing();
      const [row]=await readExternalRecordBatch(tx,workspace,objectKind,[id]);
      if(!row)return missing();
      if((await serialize(objectKind,row)).etag!==expected)return json({error:'This record changed. Read it again before editing.'},412);
    }
    const core=objectKind==='contacts'||objectKind==='companies'||objectKind==='deals';
    if(core){
      await mutateExternalCore(tx,active.ownerId,workspace,objectKind,id,action,fields,locked?.revision,primary);
    }else await mutateExternalService(tx,active.ownerId,workspace,objectKind,id,action,fields,locked?.revision);
    // Roll back if the token expired while the domain writer was waiting on a lock.
    if(!await currentPortableApiToken(tx,hash))throw new ApiError(401,'Access token has expired.');
    await recordIntegrationAccess(tx,active,objectKind,action==='patch'?'update':action,[id]);
    if(action==='archive')return new Response(null,{status:204,headers:{'cache-control':'private, no-store'}});
    const rows=await readExternalRecordBatch(tx,workspace,objectKind,[id]);
    const [result]=await serializeRows(tx,workspace,objectKind,rows);
    if(!result)throw Error('Record readback unavailable');
    return json(result,action==='create'?201:200,{etag:result.etag,...(action==='create'?{location:'/api/v1/records/'+objectKind+'/'+id}:{})});
  });
}

export async function externalMutation(request:Request,context:RouteContext){
  try{
    const params=await context.params,kind=portableExternalRecordKind.safeParse(params.kind);
    if(!kind.success)return missing();
    const objectKind=kind.data;
    const action=request.method==='POST'?'create':request.method==='PATCH'?'patch':'archive';
    if(action==='create'?params.id!==undefined:!recordId.safeParse(params.id).success)return missing();
    const scopes=action==='archive'?['read','write','archive']:['read','write'];
    const db=portableDb(),hash=await requestTokenHash(request);
    if(!hash)return unauthorized('Send a Harbor access token.');
    const admitted=await authorizeRecordRequest(db,hash,objectKind,scopes);
    if(admitted instanceof Response)return admitted;
    const limit=await portableRateLimit('api_write','token:'+admitted.ownerId);
    if(limit)return limit;
    if(new URL(request.url).search)return json({error:'Unexpected record query.'},400);
    const expected=request.headers.get('if-match');
    if(action!=='create'&&!expected)return json({error:'Send the current record ETag in If-Match.'},428);
    if(action==='create'&&expected)return json({error:'Create uses a new record ID.'},400);
    const raw=await readBoundedRequestText(request,64*1024);
    if(raw===null)return json({error:'Record request exceeds 64 KiB.'},413);
    let id=params.id??'',fields:Record<string,unknown>={},primary:PortableApiPrimaryLinks|undefined;
    if(action==='archive'){
      if(raw.length)return json({error:'Archive takes no body.'},400);
    }else if(action==='create'){
      const input=createInput.parse(JSON.parse(raw));id=input.id;fields=input.properties;primary=input.primary;
    }else{
      const input=patchInput.parse(JSON.parse(raw));fields=input.properties;primary=input.primary;
    }
    id=id.toLowerCase();
    return await writeRecord({db,admitted,hash,objectKind,scopes},action,id,fields,expected,primary);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Check the record properties and request format.'},400);
    return json({error:'The write could not be confirmed. Read the record ID before retrying.'},503);
  }
}

const batchRecordId=recordId.transform(id=>id.toLowerCase());
const reviewedRecord=z.object({
  id:batchRecordId,etag:z.string().regex(/^"[0-9a-f]{64}"$/),
}).strict();
const distinctIds=({inputs}:{inputs:{id:string}[]})=>new Set(inputs.map(item=>item.id)).size===inputs.length;
const createBatch=z.object({inputs:z.array(createInput.extend({id:batchRecordId})).min(1).max(50)}).strict().refine(distinctIds);
const archiveBatch=z.object({inputs:z.array(reviewedRecord).min(1).max(50)}).strict().refine(distinctIds);
const updateBatch=z.object({inputs:z.array(reviewedRecord.extend(patchInput.shape)).min(1).max(50)}).strict().refine(distinctIds);

export function externalCreateBatch(request:Request,context:RouteContext){return changeBatch(request,context,'create');}
export function externalArchiveBatch(request:Request,context:RouteContext){return changeBatch(request,context,'archive');}
export function externalUpdateBatch(request:Request,context:RouteContext){return changeBatch(request,context,'patch');}

async function changeBatch(request:Request,context:RouteContext,action:'create'|'patch'|'archive'){
  const kind=portableExternalRecordKind.safeParse((await context.params).kind);
  if(!kind.success)return missing();
  const archiving=action==='archive',db=portableDb(),scopes=archiving?['read','write','archive']:['read','write'];
  const batch={
    create:{schema:createBatch,label:'Create',success:'created',format:'Send 1–50 distinct new record IDs and their properties.'},
    patch:{schema:updateBatch,label:'Update',success:'updated',format:'Send 1–50 distinct record IDs with their current ETags and properties.'},
    archive:{schema:archiveBatch,label:'Archive',success:'archived',format:'Send 1–50 distinct record IDs with their current ETags.'},
  }[action];
  const uncertain=archiving?'Check archived records before retrying.':'Read the affected records before retrying.';
  try{
    const hash=await requestTokenHash(request);
    if(!hash)return unauthorized('Send a Harbor access token.');
    const admitted=await authorizeRecordRequest(db,hash,kind.data,scopes);
    if(admitted instanceof Response)return admitted;
    const budget=()=>portableRateLimit('api_write','token:'+admitted.ownerId);
    const limit=await budget();
    if(limit)return limit;
    if(new URL(request.url).search)return json({error:'Unexpected batch query.'},400);
    const raw=await readBoundedRequestText(request,archiving?8192:65536);
    if(raw===null)return json({error:batch.label+' batch exceeds '+(archiving?'8':'64')+' KiB.'},413);
    const inputs:{id:string;etag?:string;properties?:Record<string,unknown>;primary?:PortableApiPrimaryLinks}[]=batch.schema.parse(JSON.parse(raw)).inputs;
    const results=[];
    let stop=false,retryAfter:string|null=null;
    for(const [index,item] of inputs.entries()){
      const {id,etag}=item;
      if(stop){
        results.push({index,id,status:'not_attempted'});
        continue;
      }
      let response:Response;
      try{
        response=(index?await budget():null)??await writeRecord({db,admitted,hash,objectKind:kind.data,scopes},
          action,id,item.properties??{},etag??null,item.primary);
      }catch(error){
        response=error instanceof ApiError?json({error:error.message},error.status):
          error instanceof z.ZodError?json({error:'Check the supplied record properties.'},400):json({error:uncertain},503);
      }
      if(response.ok)results.push({index,id,status:batch.success,...(archiving?{}:{etag:response.headers.get('etag')})});
      else{
        const {error}=await response.json() as {error:string};
        results.push({index,id,status:'error',error:{status:response.status,message:error}});
        stop=[401,403,429].includes(response.status)||response.status>=500;
        retryAfter=response.headers.get('retry-after');
      }
    }
    return json({results},results.every(row=>row.status===batch.success)?200:207,retryAfter?{'retry-after':retryAfter}:undefined);
  }catch(error){
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:batch.format},400);
    return json({error:uncertain},503);
  }
}
