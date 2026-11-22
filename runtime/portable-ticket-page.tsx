import {effectiveMemberToolPolicy} from '../lib/portable-tool-permissions';
import {portablePageHasBody} from './portable-page-body';
import {recordWorkItemAccess} from '../db/postgres/record-access-store';
import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {portableRecordReaders} from '../db/postgres/portable-record-readers';
import {portableWorkspaceAssignees} from '../db/postgres/workspace-assignee-store';
import {readPortableTickets} from '../db/postgres/ticket-store';
import {portableTicketRead} from '../lib/portable-tickets';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {portableLoginConfig as loginConfig} from './portable-login-config';
import {env} from './portable-env';
import {PortableTickets} from './portable-tickets-ui';

function ticketReturnFilters(value:string|string[]|undefined){
  if(typeof value!=='string')return undefined;
  const params=new URLSearchParams(value);
  const filters=Object.fromEntries(params);
  if(params.size!==Object.keys(filters).length||params.has('id')||params.has('workspaceId'))return undefined;
  if(portableTicketRead.safeParse(filters).success)return params.toString();
}

export default async function TicketsPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const {from,...params}=await searchParams;
  const {status,priority,source,category,sla,sort,search:term}=params;
  const query=portableTicketRead.safeParse({...params,status:status===''?undefined:status,priority:priority===''?undefined:priority,
    source:source===''?undefined:source,category:category===''?undefined:category,sla:sla===''?undefined:sla,response:params.response===''?undefined:params.response,
    assignee:params.assignee===''?undefined:params.assignee,
    tag:typeof params.tag==='string'?params.tag.trim()||undefined:params.tag,sort:sort===''?undefined:sort,
    search:typeof term==='string'?term.trim()||undefined:term});
  if(!query.success||(!query.data.id&&from!==undefined))notFound();
  const returnFilters=ticketReturnFilters(from);
  const search=new URLSearchParams();
  for(const [key,value] of Object.entries(params))if(typeof value==='string')search.set(key,value);
  if(returnFilters)search.set('from',returnFilters);
  const user=await requireChatGPTUser('/tickets'+(search.size?'?'+search:''));
  const db=portableDb();
  const {contactId,companyId,workspaceId}=query.data;
  let grant:{id:string;canEdit:boolean;canCreate:boolean;canDelete:boolean;restrictedEdit:boolean}|undefined;
  if(workspaceId){
    // Viewers read shared Tickets; editors also create and change them.
    if(portableWorkspaceGuest(user.email)&&!await guestWorkspaceAllowed(db,user.userId,workspaceId,loginConfig(env).allowedEmails))notFound();
    const current=await sharedWorkspaceGrant(db,user.userId,workspaceId,true);
    if(!current)notFound();
    const policy=effectiveMemberToolPolicy(current,'tickets');
    if(policy.view==='none')notFound();
    grant={id:current.id,canEdit:policy.edit!=='none',canCreate:policy.create,canDelete:policy.delete,restrictedEdit:policy.edit!=='all'};
  }else if(portableWorkspaceGuest(user.email))notFound();
  const target=contactId?{kind:'contacts' as const,id:contactId}:companyId?{kind:'companies' as const,id:companyId}:undefined;
  const includeBody=await portablePageHasBody();
  const {result,related,assignees}=await db.transaction(async tx=>{
    const [result,linked,assignees]=await Promise.all([
      readPortableTickets(tx,user.userId,query.data),
      target?portableRecordReaders[target.kind](tx,user.userId,{id:target.id,limit:1,workspaceId}):undefined,
      grant&&!grant.canEdit&&!grant.canCreate?[]:portableWorkspaceAssignees(tx,user.userId,workspaceId,undefined,'tickets'),
    ]);
    if(!result||target&&(!linked||!('data' in linked)))notFound();
    const related=target&&linked&&'data' in linked?{...target,name:linked.data.name}:undefined;
    if(includeBody)await recordWorkItemAccess(tx,user,'tickets',result,workspaceId,undefined,related?[related]:[]);
    return {result,related,assignees};
  },{isolationLevel:'repeatable read'});
  return withPortableNavigation(user.email,<PortableTickets key={query.data.id??'list'} email={user.email} result={result} related={related} assignees={assignees}
    query={query.data} returnFilters={returnFilters} grant={grant&&workspaceId?{...grant,workspaceId}:undefined}/>,{actorId:user.userId,workspaceId});
}
