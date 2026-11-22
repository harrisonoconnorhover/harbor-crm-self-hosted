import {WorkspaceDate} from './portable-workspace-format';
import {sharedToolAllowed} from '../db/postgres/shared-tool-permission';
import {notFound} from 'next/navigation';
import {z} from 'zod';
import {portablePageHasBody} from './portable-page-body';
import {recordPreviewAccess} from '../db/postgres/record-access-store';
import {readCallList} from '../db/postgres/call-list-store';
import {sharedWorkspaceGrant} from '../db/postgres/workspace-viewer-store';
import {portableRecordPath} from '../lib/portable-record-path';
import {PortableAircallLink} from './portable-aircall-link';
import {PortableCrmHeader} from './portable-crm-header';
import {portableDb} from './portable-db';

export const portableCallsQuery=z.object({view:z.literal('calls'),workspaceId:z.string().guid().optional(),search:z.string().trim().max(160).optional(),after:z.string().max(100).optional()}).strict();
const cursor=z.tuple([z.coerce.number().int().nonnegative(),z.string().guid(),z.enum(['contacts','companies','deals'])]);
const labels={contacts:'Contact',companies:'Company',deals:'Deal'};
const date=new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'});

export async function PortableCallsPage({query,user}:{query:z.output<typeof portableCallsQuery>;user:{userId:string;email:string}}){
  const {workspaceId,after,search}=query,db=portableDb();
  const position=after===undefined?undefined:cursor.safeParse(after.split('_'));
  if(position&&!position.success)notFound();
  if(workspaceId){
    const grant=await sharedWorkspaceGrant(db,user.userId,workspaceId,true);
    if((!grant?.contactOutreach&&!grant?.recordActivities)||!await sharedToolAllowed(db,user.userId,workspaceId,'calls'))notFound();
  }
  const key=position?.data;
  const includeBody=await portablePageHasBody();
  const {items,next}=await db.transaction(async tx=>{
    const page=await readCallList(tx,user.userId,workspaceId,key&&{at:key[0],id:key[1],home:key[2]},search);
    if(includeBody)await recordPreviewAccess(tx,user,'related',page.items.map(call=>({kind:call.home,id:call.record_id})),workspaceId);
    return page;
  },{isolationLevel:'repeatable read',accessMode:includeBody?'read write':'read only'});
  const listParams={view:'calls',...(workspaceId?{workspaceId}:{})};
  const unfiltered='/?'+new URLSearchParams(listParams);
  const base='/?'+new URLSearchParams({...listParams,...(search?{search}:{})});
  return <main className="portable-contacts">
    <PortableCrmHeader email={user.email} page="calls" workspaceId={workspaceId}/>
    <section aria-labelledby="call-title"><h1 id="call-title">Calls</h1>
      <form className="portable-call-search" method="get" action="/" role="search" aria-label="Call history">
        <input type="hidden" name="view" value="calls"/>
        {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        <label>Search call summaries <input type="search" name="search" maxLength={160} defaultValue={search}/></label>
        <button type="submit">Search</button>{search&&<a href={unfiltered}>Clear search</a>}
      </form>
      {items.length?<ul className="portable-call-list">{items.map(call=>{
        const time=new Date(Number(call.at));
        return <li key={call.home+call.id}><div>
          <a href={portableRecordPath(call.home,call.record_id,workspaceId,base+(after?'&after='+after:''))}>{call.name}</a>
          <span>{labels[call.home]}</span></div>
          <time dateTime={time.toISOString()}><WorkspaceDate value={time.getTime()}>{date.format(time)} UTC</WorkspaceDate></time><p>{call.summary}</p>
          {call.home==='contacts'&&<PortableAircallLink activityId={call.id} assets={call.assets}/>}</li>;
      })}</ul>:<p>{search?'No matching calls on this page.':'No logged calls on this page. Calls logged on contacts, companies and deals appear here.'}</p>}
      {(after||next)&&<nav aria-label="Call history pages">{after&&<a href={base}>Latest calls</a>}{next&&<a href={base+'&after='+[next.at,next.id,next.home].join('_')}>Older calls</a>}</nav>}
    </section>
  </main>;
}
