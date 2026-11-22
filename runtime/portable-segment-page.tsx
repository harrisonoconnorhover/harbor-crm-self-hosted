import {portablePageHasBody} from './portable-page-body';
import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {readPortableSegments} from '../db/postgres/portable-segment-store';
import {guestWorkspaceAllowed} from '../db/postgres/workspace-sign-in-store';
import {portableLoginConfig} from './portable-login-config';
import {env} from './portable-env';
import {listSummary,portableSegmentRead} from '../lib/portable-segments';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {PortableSegments,SharedLists} from './portable-segments-ui';

const trimSearch=(value:string|undefined)=>typeof value==='string'?value.trim()||undefined:value;

export async function PortableSegmentPage({view,workspaceId,segment,after,q,memberQ,...rest}:Record<string,string|undefined>){
  if(view!=='segments'||Object.keys(rest).length||memberQ!==undefined&&segment===undefined)notFound();
  const search=trimSearch(q);
  const memberSearch=trimSearch(memberQ);
  const library=portableSegmentRead.safeParse({workspaceId,q:search,after:segment?undefined:after});
  const selection=segment===undefined?undefined:portableSegmentRead.safeParse({workspaceId,id:segment,after,q:memberSearch});
  if(!library.success||selection&&!selection.success)notFound();
  const params=new URLSearchParams({view:'segments'});
  for(const [key,value] of Object.entries({workspaceId,segment,q:search,memberQ:memberSearch,after}))if(value)params.set(key,value);
  const user=await requireChatGPTUser('/?'+params);
  const db=portableDb();
  if(portableWorkspaceGuest(user.email)&&(!workspaceId||!await guestWorkspaceAllowed(db,user.userId,workspaceId,portableLoginConfig(env).allowedEmails)))notFound();
  const includeBody=await portablePageHasBody();
  const [list,members]=await Promise.all([
    readPortableSegments(db,user,library.data),
    selection?.success?readPortableSegments(db,user,selection.data,includeBody):undefined,
  ]);
  if(!list||!('segments' in list)||selection&&(!members||!('items' in members)))notFound();
  const current=members&&'items' in members?members:undefined;
  if(workspaceId)return withPortableNavigation(user.email,<SharedLists email={user.email} workspaceId={workspaceId}
    list={{segments:list.segments.map(listSummary),next:list.next}} members={current&&{...current,segment:listSummary(current.segment)}}
    q={search} memberQ={memberSearch} after={after}/>,{actorId:user.userId,workspaceId});
  return withPortableNavigation(user.email,<PortableSegments origin={process.env.HARBOR_LOGIN_ORIGIN!} key={current?current.segment.id+':'+current.segment.revision:'new'} email={user.email}
    list={list} members={current} q={search} memberQ={memberSearch} after={after}/>);
}
