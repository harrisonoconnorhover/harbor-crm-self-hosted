import {z} from 'zod';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {accessExportLimit,accessPartNumber,accessHistory,accessQuery} from '../db/postgres/record-access-store';
import {exportCsvCell} from '../lib/shared-record-export';
import {readBoundedRequestText} from '../lib/bounded-request-text';

const ids=z.array(z.guid()).min(1);
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const invalid=()=>new Response('Check the access history filters and try again.',{status:400,headers});

export async function accessHistoryCsv(db:PostgresJsDatabase,ownerId:string,params:URLSearchParams,request:Request){
  const method=request.method;
  const {export:format,eventIds,part,...filters}=Object.fromEntries(params);
  if(format!=='csv'||params.size!==new Set(params.keys()).size||filters.afterAt!==undefined||filters.afterId!==undefined)return invalid();
  const query=accessQuery.safeParse(filters);
  let selection=eventIds;
  if(part!==undefined){
    if(method!=='POST'||!accessPartNumber.safeParse(part).success||eventIds!==undefined||filters.event!==undefined)return invalid();
    if(request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')return invalid();
    const body=await readBoundedRequestText(request,accessExportLimit*40+32);
    if(!body)return invalid();
    const form=new URLSearchParams(body);
    if(form.size!==1||!form.has('eventIds'))return invalid();
    selection=form.get('eventIds')!;
  }else if(method!=='GET'&&method!=='HEAD')return new Response('Use GET to download access history.',{status:405,headers});
  const selected=selection===undefined?undefined:ids.max(part?accessExportLimit:25).safeParse(selection.split(','));
  if(!query.success||(selected&&!selected.success))return invalid();
  const {from,through}=query.data;
  if(from&&through&&from>through)return invalid();
  const {items,more}=await accessHistory(db,ownerId,query.data,{eventIds:selected?.data});
  if(part&&items.length!==selected?.data?.length)return new Response('Reopen the export part to refresh its selection.',{status:409,headers});
  if(more)return new Response('Over '+accessExportLimit+' matching events. Choose Export in parts from record access history, or narrow the filters.',{status:413,headers});

  const downloadHeaders={...headers,'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="harbor-record-access'+(part?'-part-'+part:'')+'.csv"'};
  if(method==='HEAD')return new Response(null,{headers:downloadHeaders});
  const columns=['Event ID','Time (UTC)','Actor ID','Actor email','Activity','Object','Custom object ID','API operation',
    'API token ID','API token name','Record count','Record IDs','File ID','File version ID','File revision'];
  const lines=[columns,...items.map(row=>[row.id,new Date(row.at).toISOString(),row.actorId,row.email,
    row.action,row.kind,row.customObjectId,row.operation,row.token,row.tokenName,row.count,row.ids.join(' '),row.fileId,row.fileVersionId,row.fileRevision])];
  const body=lines.map(line=>line.map(value=>exportCsvCell(value??'')).join(',')).join('\r\n')+'\r\n';
  return new Response(body,{headers:downloadHeaders});
}
