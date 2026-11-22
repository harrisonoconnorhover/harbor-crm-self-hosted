import {z} from 'zod';
import {readWorkItemResponse} from '../db/postgres/record-access-store';
import {ApiError} from '../lib/api-error';
import {leadDistribution,leadRoutingRule} from '../lib/portable-lead-routing';
import {previewLeadRouting,previewTerritoryRouting,readLeadRouting,readRepWorkload,saveLeadBalance,saveLeadRouting} from '../db/postgres/lead-routing-store';
import {readPortableLeadHistory,readPortableLeads,routeWaitingLeadPage,writePortableLead} from '../db/postgres/portable-lead-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {leadRoutingPage,portableLeadHistoryQuery,portableLeadRead,portableLeadWrite} from '../lib/portable-leads';
import {sharedRecordWriteScope,type SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const messages={not_routable:'Choose an open lead that needs routing.',missing:'Lead not found.',stale:'This lead changed. Reload it before saving.',
  contact_missing:'Contact not found in this workspace.',company_missing:'Company not found in this workspace.',
  disqualified:'Reopen this disqualified lead before creating a deal.',access:'Editor access to this workspace is required.',
  assignee_missing:'Choose the workspace owner or a teammate who can edit leads.'} as const;
const conflicts=new Set(['stale','disqualified','assignee_missing','not_routable']);

async function leadRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(params.get('view')==='routing'){
      if(user.guest||params.size!==1)return json({error:'Manage routing in your own workspace.'},403);
      if(request.method==='GET'||request.method==='HEAD')return json(await readLeadRouting(db,user.userId));
      let body:unknown;
      try{const text=await readBoundedRequestText(request,32*1024);if(text!==null)body=JSON.parse(text);}catch{}
      const balance=z.union([
        z.object({action:z.literal('balance'),distribution:leadDistribution}).strict(),
        z.object({action:z.literal('balance'),byCapacity:z.boolean()}).strict()
          .transform(({byCapacity})=>({distribution:byCapacity?'capacity' as const:'count' as const})),
      ]).safeParse(body);
      if(balance.success)return json(await saveLeadBalance(db,user.userId,balance.data.distribution));
      const rule=leadRoutingRule.safeParse(body);
      if(!rule.success)return json({error:'Check the territory, capacity, away date and working hours.'},400);
      return json(await saveLeadRouting(db,user.userId,rule.data));
    }
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid lead query.'},400);
      if(params.get('view')==='territory-preview'){
        if(user.guest||params.has('workspaceId'))return json({error:'Test routing in your own workspace.'},403);
        const location=z.string().trim().max(100).refine(value=>!value.includes('\0')).optional();
        const at=z.iso.datetime().refine(value=>Date.parse(value)>Date.now(),'Choose a future preview time.').optional();
        const query=z.object({view:z.literal('territory-preview'),country:location,region:location,at}).strict()
          .refine(({country,region})=>!region||Boolean(country)).safeParse(Object.fromEntries(params));
        if(!query.success)return json({error:query.error.issues.some(issue=>issue.path[0]==='at')?'Choose a valid future preview time.':'Enter a country for a state or province, with up to 100 characters per field.'},400);
        return json(await previewTerritoryRouting(db,user.userId,query.data.country,query.data.region,query.data.at));
      }
      if(params.get('view')==='routing-workload'){
        if(user.guest||params.has('workspaceId'))return json({error:'Manage routing in your own workspace.'},403);
        const grant=z.string().guid().safeParse(params.get('memberId'));
        if(params.size!==2||!grant.success)return json({error:'Choose a sales rep.'},400);
        return json(await readRepWorkload(db,user.userId,grant.data));
      }
      if(params.get('view')==='routing-preview'){
        const query=z.object({view:z.literal('routing-preview'),id:z.string().guid(),workspaceId:z.string().guid().optional()}).strict()
          .safeParse(Object.fromEntries(params));
        if(!query.success)return json({error:'Choose one open lead to preview routing.'},400);
        return json(await previewLeadRouting(db,user,query.data.id,query.data.workspaceId,request.method!=='HEAD'));
      }
      if(params.get('view')==='history'){
        params.delete('view');
        const historyQuery=portableLeadHistoryQuery.safeParse(Object.fromEntries(params));
        if(!historyQuery.success)return json({error:'Invalid lead history query.'},400);
        const history=await readPortableLeadHistory(db,user.userId,historyQuery.data);
        return history?json(history):json({error:messages.missing},404);
      }
      const query=portableLeadRead.safeParse(Object.fromEntries(params));
      if(!query.success)return json({error:'Invalid lead query.'},400);
      const result=await readWorkItemResponse(db,user,'leads',query.data.workspaceId,request.method,
        tx=>readPortableLeads(tx,user.userId,query.data));
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
    if(raw&&typeof raw==='object'&&'action' in raw&&raw.action==='route_page'){
      const page=leadRoutingPage.safeParse(raw);
      if(!page.success)return json({error:'Choose up to 25 distinct leads with their current versions.'},400);
      return json(await routeWaitingLeadPage(db,user.userId,page.data.leads,shared,page.data.queueIfUnavailable));
    }
    const input=portableLeadWrite.safeParse(raw);
    if(!input.success)return json({error:'Check the lead fields and try again.'},400);
    const result=await writePortableLead(db,user.userId,input.data,shared);
    if('error' in result)return json({error:messages[result.error]},result.error==='access'?403:conflicts.has(result.error)?409:404);
    return json(result,result.created?201:200);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    console.error('Portable lead request failed.');
    return json({error:'Could not finish this lead request.'},500);
  }
}

export {leadRoute as GET,leadRoute as POST};
