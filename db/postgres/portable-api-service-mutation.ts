import {isDeepStrictEqual} from 'node:util';
import {and,eq,isNull} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {portableLeadFields} from '../../lib/portable-leads';
import {portableTaskFields} from '../../lib/portable-tasks';
import {portableTicketFields} from '../../lib/portable-tickets';
import {portableLeads} from './portable-lead-schema';
import {writePortableLead} from './portable-lead-store';
import {changePortableTaskArchive} from './portable-task-archive-store';
import {changeServiceArchive} from './service-archive-store';
import {portableTasks} from './task-schema';
import {savePortableTask} from './task-store';
import {portableTickets} from './ticket-schema';
import {savePortableTicket} from './ticket-store';

const tables={tasks:portableTasks,leads:portableLeads,tickets:portableTickets};
const fields={tasks:portableTaskFields,leads:portableLeadFields.partial({leadStage:true}),tickets:portableTicketFields.omit({owner:true})};
function saved(result:{error:string}|{record:{id:string}}|{id:string}){
  if(!('error' in result))return {id:'record' in result?result.record.id:result.id};
  if(result.error==='stale')throw new ApiError(412,'Read the record again before updating it.');
  if(result.error==='access')throw new ApiError(403,'Record edit unavailable.');
  if(result.error==='missing')throw new ApiError(404,'Record unavailable.');
  throw new ApiError(409,'The record could not be saved with its current links or assignment.');
}

export async function mutateExternalService(db:PostgresJsDatabase,ownerId:string,workspaceId:string,kind:keyof typeof tables,
  id:string|undefined,action:'create'|'patch'|'archive',properties:Record<string,unknown>,revision:number|undefined):Promise<{id:string}>{
  const table=tables[kind];
  if(action!=='create'&&(!id||revision===undefined))throw new ApiError(428,'Read the current record before editing.');
  if(action==='archive'){
    const input={action:'archive' as const,id:id!,requestId:crypto.randomUUID(),expectedRevision:revision!};
    if(kind==='tasks')await changePortableTaskArchive(db,ownerId,input);
    else await changeServiceArchive(db,ownerId,kind,input);
    return {id:id!};
  }
  const current=action==='patch'?(await db.select({data:table.data,revision:table.revision}).from(table)
    .where(and(eq(table.workspaceId,workspaceId),eq(table.id,id!),isNull(table.archivedAt))).for('update'))[0]:undefined;
  if(action==='patch'&&!current)throw new ApiError(404,'Record unavailable.');
  if(current&&current.revision!==revision)throw new ApiError(412,'Read the current record before editing.');
  const inputKeys=Object.keys(properties);
  const schema=fields[kind];
  if(inputKeys.some(key=>!Object.hasOwn(schema.shape,key)))throw new ApiError(400,'Unknown or read-only property.');
  // Supply only the defaults and required name a partial edit must preserve. The domain writer
  // merges the rest. In particular omitted deadline/recurrence inputs retain their original meaning.
  const existing=current?.data as Record<string,unknown>|undefined;
  const retained=existing?Object.fromEntries(['name','taskType','priority','status','ticketStatus','ticketPriority']
    .filter(k=>Object.hasOwn(schema.shape,k)&&Object.hasOwn(existing,k)).map(k=>[k,existing[k]])):{};
  const raw={...retained,...properties},result=schema.safeParse(raw);
  if(!result.success)throw new ApiError(400,'Check the record property names and values.');
  const values=result.data as Record<string,unknown>;
  if(existing&&inputKeys.every(key=>isDeepStrictEqual(existing[key],values[key])))return {id:id!};
  const target=action==='patch'?{id:id!,expectedRevision:revision!}:{},createId=action==='create'?id:undefined;
  switch(kind){
    case 'tasks':return saved(await savePortableTask(db,ownerId,{action:'save',kind,...target,data:fields.tasks.parse(raw)},undefined,createId));
    case 'leads':return saved(await writePortableLead(db,ownerId,{action:'save',...target,data:fields.leads.parse(raw)},undefined,createId));
    case 'tickets':return saved(await savePortableTicket(db,ownerId,{action:'save',...target,data:fields.tickets.parse(raw)},undefined,createId));
  }
}
