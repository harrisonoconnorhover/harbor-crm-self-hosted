import {readPortableTickets,savePortableTicket} from '../db/postgres/ticket-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableTicketExportFilters,portableTicketRead,portableTicketWrite,type PortableTicketRecord} from '../lib/portable-tickets';
import {sharedRecordWriteScope,type SharedRecordWriteScope} from '../lib/portable-workspace-access';
import {exportCsvCell} from '../lib/shared-record-export';
import {closeSlaLabels} from '../lib/ticket-sla';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
const ticketExportLimit=500;

function ticketsCsv(records:PortableTicketRecord[]){
  const line=(values:unknown[])=>values.map(value=>exportCsvCell(value)).join(',');
  const columns=['Ticket ID','Name','Status','Priority','Owner','Source','Category','Description',
    'Contact ID','Contact','Company ID','Company','SLA status','Close by (UTC)','Closed at','Created at','Updated at'];
  const rows=records.map(({id,data,contactId,contactName,companyId,companyName,sla,closedAt,createdAt,updatedAt})=>
    line([id,data.name,data.ticketStatus,data.ticketPriority,data.owner,data.ticketSource,data.ticketCategory,data.description,
      contactId,contactName,companyId,companyName,sla?.status?closeSlaLabels[sla.status]:null,
      sla?.receipt?.dueAt,closedAt,createdAt,updatedAt]));
  return [line(columns),...rows].join('\r\n')+'\r\n';
}

async function exportTickets(user:{userId:string;guest:boolean},params:URLSearchParams,head:boolean){
  if(user.guest||params.has('workspaceId'))return json({error:'Export tickets from your own workspace.'},403);
  if(params.get('export')!=='csv')return json({error:'Choose Ticket list filters to export.'},400);
  params.delete('export');
  const query=portableTicketExportFilters.safeParse(Object.fromEntries(params));
  if(!query.success)return json({error:'Choose Ticket list filters to export.'},400);
  const page=await readPortableTickets(portableDb(),user.userId,{...query.data,limit:ticketExportLimit});
  if(!page||!('records' in page))return json({error:'Choose a Ticket list to export.'},400);
  if(page.next)return json({error:`More than ${ticketExportLimit} tickets match. Narrow your filters to export the full list.`},413);
  return new Response(head?null:ticketsCsv(page.records),{headers:{
    'cache-control':'private, no-store','x-content-type-options':'nosniff',
    'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="harbor-tickets.csv"',
  }});
}

async function ticketRoute(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    if(user.guest&&!params.has('workspaceId'))return json({error:'Open tickets in a workspace shared with you.'},403);
    if(request.method==='GET'||request.method==='HEAD'){
      if(params.size!==new Set(params.keys()).size)return json({error:'Invalid ticket query.'},400);
      if(params.has('export'))return await exportTickets(user,params,request.method==='HEAD');
      const query=portableTicketRead.safeParse(Object.fromEntries(params));
      if(!query.success)return json({error:'Invalid ticket query.'},400);
      const result=await readPortableTickets(portableDb(),user.userId,query.data);
      return result?json(result):json({error:'Ticket not found.'},404);
    }
    let shared:SharedRecordWriteScope|undefined;
    if(params.size){
      const scope=sharedRecordWriteScope.safeParse(Object.fromEntries(params));
      if(!scope.success||params.size!==2)return json({error:'Open the shared workspace again before editing tickets.'},403);
      shared=scope.data;
    }
    let body:unknown;
    try{
      const text=await readBoundedRequestText(request,64_000);
      if(text!==null)body=JSON.parse(text);
    }catch{}
    const input=portableTicketWrite.safeParse(body);
    if(!input.success)return json({error:'Check the ticket fields and try again.'},400);
    const result=await savePortableTicket(portableDb(),user.userId,input.data,shared);
    if('error' in result&&result.error==='access')return json({error:'Editor access to this workspace is required.'},403);
    if('record' in result)return json(result,'id' in input.data?200:201);
    if(result.error==='contact_missing')return json({error:'Contact not found in this workspace.'},404);
    if(result.error==='company_missing')return json({error:'Company not found in this workspace.'},404);
    return result.error==='missing'?json({error:'Ticket not found.'},404):
      json({error:'This ticket changed. Reload it before saving.'},409);
  }catch{
    console.error('Portable ticket request failed.');
    return json({error:'Could not finish this ticket request.'},503);
  }
}

export {ticketRoute as GET,ticketRoute as HEAD,ticketRoute as POST};
