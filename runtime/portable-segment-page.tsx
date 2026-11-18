import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {readPortableSegments} from '../db/postgres/portable-segment-store';
import {portableSegmentRead} from '../lib/portable-segments';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {PortableSegments} from './portable-segments-ui';

const trimSearch=(value:string|undefined)=>typeof value==='string'?value.trim()||undefined:value;

export async function PortableSegmentPage({view,segment,after,q,memberQ,...rest}:Record<string,string|undefined>){
  if(view!=='segments'||Object.keys(rest).length||memberQ!==undefined&&segment===undefined)notFound();
  const search=trimSearch(q);
  const memberSearch=trimSearch(memberQ);
  const library=portableSegmentRead.safeParse({q:search,after:segment?undefined:after});
  const selection=segment===undefined?undefined:portableSegmentRead.safeParse({id:segment,after,q:memberSearch});
  if(!library.success||selection&&!selection.success)notFound();
  const params=new URLSearchParams({view:'segments'});
  for(const [key,value] of Object.entries({segment,q:search,memberQ:memberSearch,after}))if(value)params.set(key,value);
  const user=await requireChatGPTUser('/?'+params);
  if(portableWorkspaceGuest(user.email))notFound();
  const db=portableDb();
  const [list,members]=await Promise.all([
    readPortableSegments(db,user.userId,library.data),
    selection?.success?readPortableSegments(db,user.userId,selection.data):undefined,
  ]);
  if(!list||!('segments' in list)||selection&&(!members||!('items' in members)))notFound();
  const current=members&&'items' in members?members:undefined;
  return withPortableNavigation(user.email,<PortableSegments key={current?current.segment.id+':'+current.segment.revision:'new'} email={user.email}
    list={list} members={current} q={search} memberQ={memberSearch} after={after}/>);
}
