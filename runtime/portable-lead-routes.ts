import {readPortableLeadHistory,readPortableLeads,writePortableLead} from '../db/postgres/portable-lead-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableLeadHistoryQuery,portableLeadRead,portableLeadWrite} from '../lib/portable-leads';
import {sharedRecordWriteScope,type SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const messages={missing:'Lead not found.',stale:'This lead changed. Reload it before saving.',
  contact_missing:'Contact not found in this workspace.',company_missing:'Company not found in this workspace.',
  disqualified:'Reopen this disqualified lead before creating a deal.',access:'Editor access to this workspace is required.',
  assignee_missing:'Choose an active workspace editor or the owner.'} as const;
const conflicts=new Set(['stale','disqualified','assignee_missing']);

async function leadRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid lead query.'},400);
      if(params.get('view')==='history'){
        params.delete('view');
        const historyQuery=portableLeadHistoryQuery.safeParse(Object.fromEntries(params));
        if(!historyQuery.success)return json({error:'Invalid lead history query.'},400);
        const history=await readPortableLeadHistory(db,user.userId,historyQuery.data);
        return history?json(history):json({error:messages.missing},404);
      }
      const query=portableLeadRead.safeParse(Object.fromEntries(params));
      if(!query.success)return json({error:'Invalid lead query.'},400);
      const result=await readPortableLeads(db,user.userId,query.data);
      return result?json(result):json({error:messages.missing},404);
    }
    let shared:SharedRecordWriteScope|undefined;
    if(params.size){
      const scope=sharedRecordWriteScope.safeParse(Object.fromEntries(params));
      if(!scope.success||params.size!==2)return json({error:'Open the shared workspace again before editing leads.'},403);
      shared=scope.data;
    }
    let raw:unknown;
    try{const text=await readBoundedRequestText(request,12_288);if(text!==null)raw=JSON.parse(text);}catch{}
    const input=portableLeadWrite.safeParse(raw);
    if(!input.success)return json({error:'Check the lead fields and try again.'},400);
    const result=await writePortableLead(db,user.userId,input.data,shared);
    if('error' in result)return json({error:messages[result.error]},result.error==='access'?403:conflicts.has(result.error)?409:404);
    return json(result,result.created?201:200);
  }catch{
    console.error('Portable lead request failed.');
    return json({error:'Could not finish this lead request.'},500);
  }
}

export {leadRoute as GET,leadRoute as POST};
