import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {portableRecordReaders} from '../db/postgres/portable-record-readers';
import {readPortableTickets} from '../db/postgres/ticket-store';
import {portableTicketExportFilters,portableTicketRead} from '../lib/portable-tickets';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {loginConfig} from '../lib/identity';
import {env} from './portable-env';
import {PortableTickets} from './portable-tickets-ui';

function ticketReturnFilters(value:string|string[]|undefined){
  if(typeof value!=='string')return undefined;
  const params=new URLSearchParams(value);
  const filters=Object.fromEntries(params);
  if(params.size===Object.keys(filters).length&&portableTicketExportFilters.safeParse(filters).success)return params.toString();
}

export default async function TicketsPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const {from,...params}=await searchParams;
  const {status,priority,source,category,sla,sort,search:term}=params;
  const query=portableTicketRead.safeParse({...params,status:status===''?undefined:status,priority:priority===''?undefined:priority,
    source:source===''?undefined:source,category:category===''?undefined:category,sla:sla===''?undefined:sla,
    sort:sort===''?undefined:sort,
    search:typeof term==='string'?term.trim()||undefined:term});
  if(!query.success||(!query.data.id&&from!==undefined))notFound();
  const returnFilters=ticketReturnFilters(from);
  const search=new URLSearchParams();
  for(const [key,value] of Object.entries(params))if(typeof value==='string')search.set(key,value);
  if(returnFilters)search.set('from',returnFilters);
  const user=await requireChatGPTUser('/tickets'+(search.size?'?'+search:''));
  const db=portableDb();
  const {contactId,companyId,workspaceId}=query.data;
  let grant:{id:string;role:'viewer'|'editor'}|undefined;
  if(workspaceId){
    // Viewers read shared Tickets; editors also create and change them.
    if(portableWorkspaceGuest(user.email)&&!await guestWorkspaceAllowed(db,user.userId,workspaceId,loginConfig(env).allowedEmails))notFound();
    const current=await sharedWorkspaceGrant(db,user.userId,workspaceId);
    if(!current)notFound();
    grant={id:current.id,role:current.role};
  }else if(portableWorkspaceGuest(user.email))notFound();
  const target=contactId?{kind:'contacts' as const,id:contactId}:companyId?{kind:'companies' as const,id:companyId}:undefined;
  const [result,linked]=await Promise.all([
    readPortableTickets(db,user.userId,query.data),
    target?portableRecordReaders[target.kind](db,user.userId,{id:target.id,limit:1,workspaceId}):undefined,
  ]);
  if(!result||target&&(!linked||!('data' in linked)))notFound();
  const related=target&&linked&&'data' in linked?{...target,name:linked.data.name}:undefined;
  return withPortableNavigation(user.email,<PortableTickets key={query.data.id??'list'} email={user.email} result={result} related={related}
    query={query.data} returnFilters={returnFilters} grant={grant&&workspaceId?{...grant,workspaceId}:undefined}/>);
}
