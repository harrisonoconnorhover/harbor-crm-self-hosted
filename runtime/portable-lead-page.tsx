import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {readPortableLeads} from '../db/postgres/portable-lead-store';
import {portableWorkspaceAssignees} from '../db/postgres/workspace-assignee-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {portableLeadRead} from '../lib/portable-leads';
import {portableDb} from './portable-db';
import {portableLoginConfig as loginConfig} from './portable-login-config';
import {env} from './portable-env';
import {portableWorkspaceGuest} from './portable-identity';
import {PortableLeads} from './portable-leads-ui';
import {PortableGuestHome} from './portable-workspace-ui';

export async function PortableLeadPage({search,stage,owner,after,record,add,workspaceId}:{
  search?:string;stage?:string;owner?:string;after?:string;record?:string;add?:string;workspaceId?:string;
}){
  const query=portableLeadRead.safeParse({search:typeof search==='string'?search.trim()||undefined:search,stage:stage||undefined,
    owner:owner||undefined,after,workspaceId});
  const selected=z.string().guid("Invalid uuid").optional().safeParse(record);
  if(!query.success||!selected.success||add!==undefined&&(add!=='1'||record))notFound();
  const params=new URLSearchParams({kind:'leads'});
  for(const [key,value] of Object.entries({search:query.data.search,stage:query.data.stage,owner:query.data.owner,after,record,add,workspaceId})){
    if(value)params.set(key,value);
  }
  const user=await requireChatGPTUser('/?'+params);
  const db=portableDb();
  let grant:{id:string;role:'viewer'|'editor'}|undefined;
  if(workspaceId){
    // Shared Leads follow the workspace grant: viewers read, editors also write.
    if(portableWorkspaceGuest(user.email)&&!await guestWorkspaceAllowed(db,user.userId,workspaceId,loginConfig(env).allowedEmails))notFound();
    const current=await sharedWorkspaceGrant(db,user.userId,workspaceId);
    if(!current)notFound();
    grant={id:current.id,role:current.role};
    if(add&&grant.role!=='editor')notFound();
  }else if(portableWorkspaceGuest(user.email))return <PortableGuestHome email={user.email}/>;
  const [page,lead,assignees]=await Promise.all([
    readPortableLeads(db,user.userId,query.data),
    selected.data?readPortableLeads(db,user.userId,{id:selected.data,limit:1,workspaceId}):undefined,
    // Viewers can't assign, so only editors and the owner load the member list.
    (record||add)&&grant?.role!=='viewer'?portableWorkspaceAssignees(db,user.userId,workspaceId):[],
  ]);
  if(!page||!('records' in page)||selected.data&&(!lead||!('data' in lead)))notFound();
  return withPortableNavigation(user.email,<PortableLeads key={record??(add?'add':'list')} email={user.email} query={query.data} page={page}
    record={lead&&'data' in lead?lead:undefined} adding={add==='1'} grant={grant} assignees={assignees}/>);
}
