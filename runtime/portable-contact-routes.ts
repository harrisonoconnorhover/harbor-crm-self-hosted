import {ZodError,type output} from 'zod';
import {ApiError} from '../lib/api-error';
import {saveContact} from '../db/postgres/contact-store';
import {saveCompany} from '../db/postgres/company-store';
import {saveDeal} from '../db/postgres/deal-store';
import {readPortableTaskCompletions,readPortableTasks,savePortableTask} from '../db/postgres/task-store';
import {listPortableTaskQueues} from '../db/postgres/task-queue-store';
import {readPortablePropertyHistory} from '../db/postgres/portable-property-history-store';
import {portablePropertyHistoryQuery} from '../lib/portable-property-history';
import {portableRecordReaders} from '../db/postgres/portable-record-readers';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {assignPortableRecordOwners,editPortableRecordProperty} from '../db/postgres/portable-record-bulk-store';
import {portableRecordOwnerBatch,portableRecordPropertyBatch} from '../lib/portable-record-bulk';
import {sharedRecordWriteScope,type SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {portableContactFields,portableContactTextPatch,portableRecordLabels,portableRecordRead,portableRecordWrite,type ContactTextWrite} from '../lib/portable-records';
import {missingDealStageMessage} from '../lib/portable-deal-pipelines';
import {portableTaskCompletionRead,portableTaskRead,portableTaskWrite,taskLinkTarget} from '../lib/portable-tasks';
import {exportCsvCell} from '../lib/shared-record-export';
import {portableApiIdentity} from './portable-api-identity';
import {portableWorkflowGmailOwner} from './portable-gmail-config';
import {portableDb} from './portable-db';
import {portableRecordCsv} from './portable-record-csv';

function json(body:unknown,status=200){
  return Response.json(body,{status,headers:{'cache-control':'no-store'}});
}

async function readInput(request:Request){
  const reader=request.body?.getReader();
  if(!reader)return undefined;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0,text='';
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)return JSON.parse(text+decoder.decode()) as unknown;
      bytes+=value.byteLength;
      if(bytes>512_000)return undefined;
      text+=decoder.decode(value,{stream:true});
    }
  }catch{return undefined;}
  finally{
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

const taskExportLimit=500;
const taskCsvHeaders={'cache-control':'private, no-store','x-content-type-options':'nosniff'};

async function exportTaskCsv(db:ReturnType<typeof portableDb>,user:{userId:string;guest:boolean},query:Record<string,string>,head:boolean){
  const {export:format,...filters}=query;
  const error=(message:string,status:number)=>Response.json({error:message},{status,headers:taskCsvHeaders});
  if(user.guest||filters.workspaceId!==undefined)return error('Export tasks from your own workspace.',403);
  if(format!=='csv'||filters.id!==undefined||filters.after!==undefined||filters.limit!==undefined)
    return error('Choose task list filters to export.',400);
  const input=portableTaskRead.safeParse(filters);
  if(!input.success)return error('Invalid task export filters.',400);

  const page=await readPortableTasks(db,user.userId,{...input.data,limit:taskExportLimit});
  if(!page||!('records' in page))return error('Choose a task list to export.',400);
  if(page.next)return error(`This list matches more than ${taskExportLimit} tasks. Narrow your filters to export the full list.`,413);

  const headers={...taskCsvHeaders,'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="harbor-tasks.csv"'};
  if(head)return new Response(null,{headers});
  const queues=page.records.some(task=>task.queueId!==null)?await listPortableTaskQueues(db,user.userId):[];
  const queueNames=new Map(queues.map(queue=>[queue.id,queue.name]));
  const line=(values:unknown[])=>values.map(value=>exportCsvCell(value)).join(',');
  const columns=['Task ID','Name','Task type','Status','Priority','Due date','Due time','Time zone','Due at (UTC)',
    'Assignee','Queue','Linked record type','Linked record ID','Linked record','Notes','Completed at','Created at','Updated at'];
  const rows=page.records.map(task=>{
    const {name,taskType,status,priority,dueDate,dueTime,dueTimeZone,dueAt,notes}=task.data;
    const linked=taskLinkTarget(task);
    return line([task.id,name,taskType,status,priority,dueDate,dueTime,dueTimeZone,dueAt,task.assigneeLabel,
      task.queueId?queueNames.get(task.queueId):null,linked?portableRecordLabels[linked.kind]:null,linked?.id,
      task.contactName??task.companyName??task.dealName,notes,task.completedAt,task.createdAt,task.updatedAt]);
  });
  return new Response([line(columns),...rows].join('\r\n')+'\r\n',{headers});
}

async function recordsRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid record query.'},400);
      const query=Object.fromEntries(params);
      if(query.export!==undefined){
        const head=request.method==='HEAD';
        return await (query.kind==='tasks'?exportTaskCsv(db,user,query,head):portableRecordCsv(db,user,query,head));
      }
      if(query.history!==undefined){
        const input=portablePropertyHistoryQuery.safeParse(query);
        if(!input.success)return json({error:'Invalid property history query.'},400);
        const page=await readPortablePropertyHistory(db,user.userId,input.data);
        return page?json(page):json({error:'Record not found.'},404);
      }
      if(query.completionHistoryFor!==undefined){
        const input=portableTaskCompletionRead.safeParse(query);
        if(!input.success)return json({error:'Invalid task history query.'},400);
        const page=await readPortableTaskCompletions(db,user.userId,input.data);
        return page?json(page):json({error:'Contact not found.'},404);
      }
      const input=(query.kind==='tasks'?portableTaskRead:portableRecordRead).safeParse(query);
      if(!input.success)return json({error:'Invalid record query.'},400);
      if(input.data.workspaceId&&!await sharedWorkspaceGrant(db,user.userId,input.data.workspaceId))
        return json({error:'Shared workspace unavailable.'},404);
      if(input.data.kind==='tasks'){
        const result=await readPortableTasks(db,user.userId,input.data);
        return result?json(result):json({error:'Task not found.'},404);
      }
      const read=portableRecordReaders[input.data.kind];
      const result=await read(db,user.userId,input.data);
      return result?json(result):json({error:portableRecordLabels[input.data.kind]+' not found.'},404);
    }
    let shared:SharedRecordWriteScope|undefined;
    if(params.size){
      const scope=sharedRecordWriteScope.safeParse(Object.fromEntries(params));
      if(!scope.success||params.size!==2)return json({error:'Open the shared workspace again before saving.'},403);
      shared=scope.data;
    }
    const body=await readInput(request);
    const property=portableRecordPropertyBatch.safeParse(body);
    if(property.success)return json(await editPortableRecordProperty(db,user.userId,property.data,shared));
    const owners=portableRecordOwnerBatch.safeParse(body);
    if(owners.success){
      const result=await assignPortableRecordOwners(db,user.userId,owners.data,shared);
      if('changed' in result)return json(result);
      if(result.error==='access')return json({error:'You no longer have edit access for this workspace. Refresh before trying again.'},403);
      if(result.error==='assignee_missing')return json({error:'Choose an active workspace editor or the owner.'},409);
      if(result.error==='records_missing')return json({error:'Some selected records are no longer available. Refresh and select again.'},404);
      return json({error:'Some selected records changed. Refresh and select again. No records were updated.'},409);
    }
    const task=portableTaskWrite.safeParse(body);
    if(task.success){
      const result=await savePortableTask(db,user.userId,task.data,shared);
      if('record' in result)return json({record:result.record,nextTaskId:result.nextTaskId},'id' in task.data?200:201);
      if(result.error==='queue_scope')return json({error:'Task queues belong to the workspace owner.'},403);
      if(result.error==='queue_missing')return json({error:'Task queue not found.'},404);
      if(result.error==='assignee_missing')return json({error:'Choose an active workspace editor or the owner.'},409);
      if(result.error==='related_missing')return json({error:'Linked record not found in this workspace.'},404);
      if(result.error==='contact_missing')return json({error:'Contact not found in this workspace.'},404);
      if(result.error==='access')return json({error:'You no longer have edit access for this workspace. Refresh before trying again.'},403);
      if(result.error==='missing')return json({error:'Task not found.'},404);
      return json({error:'This task changed. Reload it before saving.'},409);
    }
    const patch=portableContactTextPatch.safeParse(body);
    let data:ContactTextWrite|output<typeof portableRecordWrite>;
    if(patch.success){
      const {id,expectedRevision,field,value}=patch.data;
      const parsed=portableContactFields.shape[field].safeParse(value??undefined);
      if(!parsed.success||(parsed.data!==undefined&&typeof parsed.data!=='string'))
        return json({error:'Enter a valid value for this property.'},400);
      data={action:'save',kind:'contacts',id,expectedRevision,data:{[field]:parsed.data}};
    }else{
      const input=portableRecordWrite.safeParse(body);
      if(!input.success)return json({error:'Check the record fields and try again.'},400);
      data=input.data;
    }
    const label=portableRecordLabels[data.kind];
    const gmailSender=!shared&&portableWorkflowGmailOwner()===user.email.toLowerCase()?user.email.toLowerCase():undefined;
    const result=data.kind==='contacts'?await saveContact(db,user.userId,data,shared,{gmailSender}):
      data.kind==='companies'?await saveCompany(db,user.userId,data,shared):await saveDeal(db,user.userId,data,shared);
    if('error' in result&&result.error==='access')return json({error:'You no longer have edit access for this workspace. Refresh before trying again.'},403);
    if('error' in result&&result.error==='assignee_missing')return json({error:'Choose an active workspace editor or the owner.'},409);
    if('error' in result&&result.error==='company_missing')return json({error:'Company not found in this workspace.'},404);
    if('error' in result&&result.error==='stage_required')return json({
      error:missingDealStageMessage(result.stageName,result.fields),fields:result.fields,
    },400);
    if('error' in result&&result.error==='stage_invalid')return json({error:'Choose a valid stage for this pipeline.'},400);
    if('error' in result&&result.error==='stage_missing')return json({error:'Stage not found in this workspace and pipeline.'},404);
    if('error' in result&&result.error==='contact_missing')return json({error:'Contact not found in this workspace.'},404);
    if('error' in result)return result.error==='missing'?json({error:label+' not found.'},404):
      json({error:'This '+label.toLowerCase()+' changed. Reload it before saving.',code:'stale_revision'},409);
    return json({record:result.record},'id' in data?200:201);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    if(error instanceof ZodError)return json({error:error.issues[0]?.message??'Check the record fields and try again.'},400);
    console.error('Portable CRM record request failed.');
    return json({error:'Could not finish this record request.'},500);
  }
}

export {recordsRoute as GET,recordsRoute as POST};
