'use client';
import {WorkspaceDate} from './portable-workspace-format';
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {PortableRecordPicker} from './portable-record-picker';
import {InboxTicketResponse} from './portable-inbox-ticket-response';
import {PublishedArticlePicker} from './portable-published-article-picker';
import {ArrowLeft,Check,Inbox,Mail,Send} from 'lucide-react';
import {ticketPriorities} from '../lib/crm';
import {maxHandoffNoteLength,ticketTags,type InboxRead} from '../lib/team-inbox';
import type {readTeamInbox} from '../db/postgres/team-inbox-store';
import {renderPortableTemplate} from '../lib/portable-email-templates';
import './portable-team-inbox.css';

type InboxResult=Awaited<ReturnType<typeof readTeamInbox>>;
type Query=InboxRead;
type Assignee={id:string;label:string;canTakeTicket?:boolean};
type Action='note'|'create_ticket'|'link_ticket'|'assign_ticket'|'tag_ticket'|'reopen_ticket'|'assign'|'claim'|'release'|'resolve'|'reopen'|'tag'|'reply'|'confirm_sent'|'confirm_failed';
type Detail=Extract<InboxResult,{conversation:{id:string}}>;
type Thread=Detail['conversation'];
type Message=NonNullable<Detail['pendingReply']>;
type Write=(action:Action,extra?:Record<string,unknown>)=>Promise<boolean>;

function url(path:string,params:Record<string,string|undefined>){
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(params))if(value)query.set(key,value);
  return path+(query.size?'?'+query:'');
}
const page=(query:Query,from?:string)=>url('/',{view:'team-inbox',...query,from});
const claimLabel=(thread:Thread,actor:string)=>thread.claimedBy===actor?'You':thread.claimedByLabel||'A teammate';
function deadlineLabel(deadline:{overdue:boolean;responseDueAt:string}){
  return <>{deadline.overdue?'First response overdue':'First response due'} · {timestamp(deadline.responseDueAt)}</>;
}
function timestamp(value:string){
  // A fixed locale and time zone keep server and browser renderings consistent.
  return <time dateTime={value}><WorkspaceDate value={value}>{new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZone:'UTC',timeZoneName:'short'}).format(new Date(value))}</WorkspaceDate></time>;
}

export function TeamInbox({initial,query,returnQueue,actorId,actorLabel,editable,canLogResponse,canSend,canUseSnippets,canUseKnowledge,grantId,assignees,ticketAssignees}:{
  initial:InboxResult;query:Query;returnQueue?:Omit<Query,'workspaceId'|'id'>;actorId:string;actorLabel:string;editable:boolean;canLogResponse:boolean;canSend:boolean;canUseSnippets:boolean;canUseKnowledge:boolean;grantId?:string;assignees:Assignee[];ticketAssignees:Assignee[];
}){
  const [data,setData]=useState<InboxResult|null>(initial),[readError,setReadError]=useState(''),[busy,setBusy]=useState(false);
  const [writeError,setWriteError]=useState<{message:string;conversationId?:string}>(),[needsReload,setNeedsReload]=useState(false);
  const activeRead=useRef<AbortController|null>(null),writing=useRef(false);
  const readUrl=url('/api/team-inbox',query),writeUrl=url('/api/team-inbox',{workspaceId:query.workspaceId,grantId});
  const refresh=useCallback(async()=>{
    activeRead.current?.abort();
    const controller=new AbortController();
    activeRead.current=controller;
    const timeout=window.setTimeout(()=>controller.abort(),30_000);
    try{
      const response=await fetch(readUrl,{cache:'no-store',signal:controller.signal});
      if(activeRead.current!==controller||controller.signal.aborted)return;
      if([401,403,404].includes(response.status)){
        setData(null);setReadError('This inbox is no longer available to your account.');return;
      }
      if(!response.ok)throw Error();
      const latest=await response.json() as InboxResult;
      if(activeRead.current===controller&&!controller.signal.aborted){setData(latest);setReadError('');}
    }catch{
      if(activeRead.current===controller)setReadError('Could not refresh the inbox.');
    }finally{
      window.clearTimeout(timeout);
      if(activeRead.current===controller)activeRead.current=null;
    }
  },[readUrl]);
  useEffect(()=>{
    const poll=()=>{if(!document.hidden&&!writing.current&&!activeRead.current)void refresh();};
    const timer=window.setInterval(poll,5000);
    window.addEventListener('focus',poll);
    document.addEventListener('visibilitychange',poll);
    return ()=>{
      clearInterval(timer);window.removeEventListener('focus',poll);document.removeEventListener('visibilitychange',poll);
      activeRead.current?.abort();activeRead.current=null;
    };
  },[refresh]);
  const thread=data&&'conversation' in data?data.conversation:undefined;
  const write=async(action:Action,extra:Record<string,unknown>={},target:Pick<Thread,'id'|'revision'>|undefined=thread)=>{
    if(!target||writing.current||needsReload)return false;
    writing.current=true;setBusy(true);activeRead.current?.abort();activeRead.current=null;setWriteError(undefined);
    try{
      const response=await fetch(writeUrl,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({id:target.id,revision:target.revision,action,...extra})});
      const result=await response.json() as {error?:string;state?:Message['state']};
      if(!response.ok){
        if(response.status===403)setNeedsReload(true);
        throw Error(result.error||'Could not update this conversation.');
      }
      if(action==='reply'&&result.state!=='sent'){
        throw Error(result.state==='failed'?'Delivery failed. Review the delivery record before trying again.':'Delivery is unconfirmed. Check the delivery record before sending another reply.');
      }
      return true;
    }catch(error){
      const queueClaim=!thread&&action==='claim';
      const message=error instanceof TypeError
        ?(queueClaim?'Could not confirm the claim. Open the conversation to check its owner.':'The connection was interrupted. Check the latest messages before retrying.')
        :error instanceof Error?error.message:'Could not confirm this change.';
      setWriteError({message,conversationId:queueClaim?target.id:undefined});
      return false;
    }finally{
      await refresh();writing.current=false;setBusy(false);
    }
  };
  const status=query.status??'open',workspaceId=query.workspaceId;
  const tabs={open:'Open',needs_reply:'Needs reply',response_due:'First responses due',resolved:'Resolved',review:'Needs review'} as const;
  const filtered=Boolean(query.q||query.messageText||query.mailbox||query.tag||query.ticketTag||query.claim||query.responseWindow||query.waiting);
  const queueQuery={status:query.status??'open',mailbox:query.mailbox,tag:query.tag,ticketTag:query.ticketTag,q:query.q,messageText:query.messageText,claim:query.claim,responseWindow:query.responseWindow,waiting:query.waiting,after:query.after};
  const from=url('',thread?returnQueue??{}:queueQuery).slice(1);
  return <section className="team-inbox">
    {thread&&<a className="inbox-back" href={page({workspaceId,...(returnQueue??{status:thread.status})})}><ArrowLeft size={15}/> Inbox</a>}
    <div className="inbox-heading"><div>{thread&&<span className="inbox-mailbox"><Inbox size={16}/>{thread.mailbox}</span>}
      <h1>{thread?thread.subject||'(No subject)':'Inbox'}</h1></div>
      {thread&&<span className="inbox-pill">{thread.status==='resolved'?'Resolved':'Open'}</span>}
    </div>
    {readError&&<p role="status">{readError} {data&&<button type="button" onClick={()=>void refresh()}>Refresh</button>}</p>}
    {writeError&&<p role="alert">{writeError.message}{' '}
      {needsReload?<a href={page(query,thread?from:undefined)}>{thread?'Reload conversation':'Reload inbox'}</a>:
        writeError.conversationId&&<a href={page({workspaceId,id:writeError.conversationId},from)}>View conversation</a>}</p>}
    {data&&('items' in data&&data.items?<><nav className="inbox-tabs" aria-label="Conversation status">
      {(Object.keys(tabs) as (keyof typeof tabs)[]).map(s=><a key={s} href={page({...query,after:undefined,status:s,waiting:s==='needs_reply'?query.waiting:undefined,responseWindow:s==='response_due'?query.responseWindow:undefined})} aria-current={status===s?'page':undefined}>{tabs[s]}</a>)}
    </nav>
    <QueueFilters query={query} assignees={assignees} rows={data.items}/>
    {!workspaceId&&<InboxQuickReplySettings/>}
    {data.items.length?<ul className="inbox-list">{data.items.map(item=><li key={item.id}>
      <Mail size={19} aria-hidden="true"/><div><a href={page({workspaceId,id:item.id},from)}>{item.subject||'(No subject)'}</a><p>{item.sender} → <a aria-label={'Filter by mailbox '+item.mailbox}
        href={page({...query,mailbox:item.mailbox,after:undefined})}>{item.mailbox}</a></p>
      {item.matchingMessageId&&<a href={page({workspaceId,id:item.id,messageId:item.matchingMessageId},from)}>Open matching message</a>}
      {item.tags.length>0&&<div className="inbox-tags">{item.tags.map(tag=><a key={tag} aria-label={'Filter by tag '+tag} href={page({...query,tag,after:undefined})}>{tag}</a>)}</div>}</div>
      <div className="inbox-list-meta">
        {item.firstResponse&&<a className="inbox-deadline" data-overdue={item.firstResponse.overdue||undefined}
          href={url('/tickets',{id:item.firstResponse.ticketId,workspaceId})}>{deadlineLabel(item.firstResponse)}</a>}
        {item.claimedBy?<a href={page({...query,claim:item.claimedBy,after:undefined})}
        aria-label={'Filter by teammate '+(item.claimedByLabel||'who claimed this conversation')}>{claimLabel(item,actorId)}</a>:editable&&item.status==='open'?
          <button type="button" className="inbox-claim-open" aria-label={'Claim and open '+(item.subject||'(No subject)')} disabled={busy||needsReload} onClick={async()=>{
            if(await write('claim',{},item))window.location.assign(page({workspaceId,id:item.id},from));
          }}>Claim and open</button>:<span>Unclaimed</span>}
        {item.firstResponse&&item.status==='resolved'&&<span>Resolved conversation</span>}
        {'waitingSince' in item&&(item.waitingSince?<span>Waiting since {timestamp(item.waitingSince)}</span>:timestamp(item.updatedAt))}
      </div>
    </li>)}</ul>:<div className="inbox-empty"><Inbox size={27}/><h2>{filtered?'No conversations match these filters':status==='needs_reply'?'No open conversations are waiting for a reply':status==='response_due'?'No linked tickets are waiting for a first response':status==='review'?'No conversations need a delivery review':'No '+status+' conversations'}{query.after?' on this page':''}</h2>
      {filtered?<p>Try another filter or clear the filters.</p>:status==='open'&&!query.after&&<p>Incoming messages to a connected team mailbox appear here.</p>}</div>}
    {(query.after||data.next)&&<nav className="inbox-pages" aria-label="Inbox pages">
      {query.after&&<a href={page({...query,after:undefined})}>First conversations</a>}
      {data.next&&<a href={page({...query,after:data.next})}>More conversations</a>}
    </nav>}
    </>:'conversation' in data&&data.conversation?<ConversationPane canUseSnippets={canUseSnippets} canUseKnowledge={canUseKnowledge} grantId={grantId} refresh={refresh} detail={data} actorId={actorId} actorLabel={actorLabel}
      assignees={assignees} ticketAssignees={ticketAssignees} isOwner={!workspaceId} editable={editable&&!needsReload} canLogResponse={canLogResponse&&!needsReload} canSend={canSend} busy={busy} write={write} query={query} from={from}/>:null)}
  </section>;
}

function QueueFilters({query,assignees,rows}:{query:Query;assignees:Assignee[];rows:Thread[]}){
  // Readers can follow claims on visible conversations without receiving the editor directory.
  const choices=new Map(assignees.map(member=>[member.id,member.label]));
  for(const row of rows){
    if(row.claimedBy&&!choices.has(row.claimedBy))choices.set(row.claimedBy,row.claimedByLabel||'Teammate');
  }
  if(query.claim&&query.claim!=='mine'&&query.claim!=='unclaimed'&&!choices.has(query.claim)){
    choices.set(query.claim,'Selected teammate');
  }
  const active=Boolean(query.q||query.messageText||query.claim||query.mailbox||query.tag||query.ticketTag||query.responseWindow||query.waiting);
  return <form className="inbox-queue-filters" aria-label="Filter conversations" action="/" method="get">
    <input type="hidden" name="view" value="team-inbox"/>
    {query.workspaceId&&<input type="hidden" name="workspaceId" value={query.workspaceId}/>}
    {query.status&&<input type="hidden" name="status" value={query.status}/>}
    <label>Search conversations<input type="search" name="q" placeholder="Subject or sender" maxLength={120} defaultValue={query.q}/></label>
    <label>Message text<input type="search" name="messageText" placeholder="Words in one message" maxLength={120} defaultValue={query.messageText}/></label>
    <label>Claim<select name="claim" defaultValue={query.claim??''}><option value="">Everyone</option>
      <option value="mine">Claimed by me</option><option value="unclaimed">Unclaimed</option>
      {choices.size>0&&<optgroup label="Teammates">{Array.from(choices,([id,label])=><option key={id} value={id}>{label}</option>)}</optgroup>}
    </select></label>
    {query.status==='needs_reply'&&<label>Customer wait<select name="waiting" defaultValue={query.waiting??''}>
      <option value="">Any duration</option><option value="24h">At least 24 hours</option><option value="72h">At least 72 hours</option>
    </select></label>}
    {query.status==='response_due'&&<label>Reply deadline<select name="responseWindow" defaultValue={query.responseWindow??''}>
      <option value="">All unanswered</option><option value="overdue">Overdue</option>
      <option value="due_next_hour">Due in the next hour</option>
    </select></label>}
    <label>Team mailbox<input name="mailbox" type="email" defaultValue={query.mailbox} placeholder="All mailboxes" maxLength={254}/></label>
    <label>Conversation tag<input name="tag" defaultValue={query.tag} maxLength={40} placeholder="All tags"/></label>
    <label>Ticket tag<input name="ticketTag" defaultValue={query.ticketTag} maxLength={40} placeholder="All ticket tags"/></label>
    <button type="submit">Apply filters</button>
    {active&&<a href={page({workspaceId:query.workspaceId,status:query.status})}>Clear filters</a>}
  </form>;
}

function ReviewLink({href,keepDraft,children}:{href:string;keepDraft:boolean;children:string}){
  return <a href={href} target={keepDraft?'_blank':undefined} rel={keepDraft?'noopener':undefined}
    aria-label={keepDraft?children+' (opens in a new tab)':undefined}>{children}{keepDraft&&<span aria-hidden="true"> ↗</span>}</a>;
}

function ConversationPane({detail,actorId,actorLabel,assignees,ticketAssignees,isOwner,editable,canLogResponse,canSend,canUseSnippets,canUseKnowledge,busy,write,query,from,grantId,refresh}:{
  grantId?:string;refresh:()=>Promise<void>;detail:Detail;actorId:string;actorLabel:string;assignees:Assignee[];ticketAssignees:Assignee[];isOwner:boolean;editable:boolean;canLogResponse:boolean;canSend:boolean;canUseSnippets:boolean;canUseKnowledge:boolean;busy:boolean;write:Write;query:Query;from:string;
}){
  const t=detail.conversation,mine=t.claimedBy===actorId,[tags,setTags]=useState<string|null>(null),[tagRevision,setTagRevision]=useState(t.revision);
  const ticket=detail.ticket;
  const [replyBody,setReplyBody]=useState('');
  const teamHistory=Boolean(query.history);
  const historyTabs={team:'All team activity',notes:'Notes',handoffs:'Handoffs'} as const;
  return <div className="inbox-layout"><div className="inbox-stream">
    {detail.pendingReply&&<DeliveryReview key={detail.pendingReply.id} message={detail.pendingReply} write={write} editable={editable&&isOwner} busy={busy}/>}
    <div className="inbox-history-heading"><h2>{teamHistory?'Team notes and handoffs':query.messageId?(detail.messages[0]?.state==='note'?'Team note':detail.messages[0]?.direction==='internal'?'Internal handoff':detail.messages[0]?.direction==='outgoing'?'Original reply':'Original message'):'Messages'}</h2>
      {teamHistory?<a href={page({...query,history:undefined,after:undefined},from)}>All messages</a>:
        <a href={page({...query,history:'team',after:undefined,messageId:undefined},from)} target="_blank" rel="noopener"
          aria-label="Team history (opens in a new tab)">Team history ↗</a>}
    </div>
    {teamHistory&&<nav className="inbox-tabs" aria-label="Team history filters">
      {(Object.keys(historyTabs) as (keyof typeof historyTabs)[]).map(history=><a key={history}
        href={page({...query,history,after:undefined},from)} aria-current={history===query.history?'page':undefined}>{historyTabs[history]}</a>)}
    </nav>}
    {(query.after||query.messageId)&&<a href={page({...query,after:undefined,messageId:undefined},from)}>{teamHistory?'Latest team activity':'Latest messages'}</a>}
    {teamHistory&&!detail.messages.length&&<p>{query.history==='handoffs'?'No handoffs on this page.':query.history==='notes'?'No team notes on this page.':'No team notes or handoffs on this page.'}</p>}
    <ol className="inbox-messages">{[...detail.messages].reverse().map(m=><li key={m.id} className={'inbox-msg '+m.direction}>
      <header><strong>{m.direction==='internal'?deliveryLabel[m.state]:m.direction==='incoming'?t.sender:t.mailbox}</strong>{timestamp(m.createdAt)}</header>
      {m.direction==='internal'?<><span className="inbox-delivery">{m.state==='note'?m.author:m.author+' assigned this conversation to '+m.handoffToLabel+'.'}</span>
        {m.body&&<p>{m.body}</p>}</>:<p>{m.body||'No plain-text message.'}</p>}
      {m.direction==='outgoing'&&<span className="inbox-delivery">{deliveryLabel[m.state]}{m.author&&' · '+m.author}</span>}
      {m.responseTicketId?<ReviewLink href={url('/tickets',{id:m.responseTicketId,workspaceId:query.workspaceId})} keepDraft={!!replyBody}>View first response on ticket</ReviewLink>:
        canLogResponse&&m.direction==='outgoing'&&m.state==='sent'&&<InboxTicketResponse replyId={m.id} workspaceId={query.workspaceId}
          grantId={grantId} onSaved={refresh}/>}
    </li>)}</ol>
    {detail.next&&<ReviewLink href={page({...query,after:detail.next},from)} keepDraft={!!replyBody}>{teamHistory?'Older team activity':'Older messages'}</ReviewLink>}
    {!query.after&&!query.messageId&&query.history!=='handoffs'&&editable&&t.status==='open'&&<TeamNote busy={busy} write={write}/>}
    {!teamHistory&&!query.after&&!query.messageId&&<ReplyComposer activityUrl={url('/api/team-inbox',{workspaceId:query.workspaceId,grantId})} canUseSnippets={canUseSnippets} canUseKnowledge={canUseKnowledge} thread={t} body={replyBody} setBody={setReplyBody} workspaceId={query.workspaceId} messages={detail.messages} pendingReply={detail.pendingReply} editable={editable} mine={mine} isOwner={isOwner}
      canSend={canSend} busy={busy} write={write} actorLabel={actorLabel}/>}
  </div><aside className="inbox-details"><h2>Conversation details</h2>
    <dl><dt>From</dt><dd>{t.sender}</dd><dt>Team mailbox</dt><dd>{t.mailbox}</dd><dt>Claimed by</dt>
      <dd aria-live="polite">{t.claimedBy?claimLabel(t,actorId):'Unclaimed'}
        {!mine&&detail.recentDraftAt&&<small> · Last worked on a reply at {timestamp(detail.recentDraftAt)}</small>}</dd></dl>
    {editable&&<div className="inbox-actions">
      {!t.claimedBy?<button type="button" disabled={busy} onClick={()=>void write('claim')}>Claim conversation</button>:
        (mine||isOwner)&&<button type="button" disabled={busy} onClick={()=>void write('release')}>{mine?'Release claim':'Release teammate’s claim'}</button>}
      {mine&&<button type="button" disabled={busy||!!detail.pendingReply&&t.status==='open'} onClick={()=>void write(t.status==='open'?'resolve':'reopen')}>{t.status==='open'?'Resolve conversation':'Reopen conversation'}</button>}
    </div>}
    {editable&&(isOwner||mine)&&t.status==='open'&&<AssignConversation key={t.claimedBy??'unclaimed'}
      choices={assignees.filter(member=>member.id!==t.claimedBy)} replyBody={mine&&!detail.pendingReply?replyBody:''} ticket={detail.ticket} revision={t.revision} busy={busy} write={write}/>}
    {ticket?<div><h3>Ticket</h3>{ticket.firstResponse&&<p className="inbox-deadline" data-overdue={ticket.firstResponse.overdue||undefined}>{deadlineLabel(ticket.firstResponse)}</p>}{ticket.archivedAt?<p>Linked ticket is in the recycle bin.</p>:
      <><p>Ticket status · {ticket.status}</p><p>Ticket assignee · {ticket.assigneeLabel||'Unassigned'}</p><ReviewLink href={url('/tickets',{id:ticket.id,workspaceId:query.workspaceId})} keepDraft={!!replyBody}>Open linked ticket</ReviewLink>
        <TicketTagEditor key={ticket.id} tags={ticket.tags} ticketId={ticket.id} ticketRevision={ticket.revision}
          threadRevision={t.revision} editable={editable&&mine&&t.status==='open'} busy={busy} write={write} workspaceId={query.workspaceId}/>
        {editable&&mine&&t.status==='open'&&<div className="inbox-actions">
          {ticket.status==='Closed'?<button type="button" disabled={busy} onClick={()=>void write('reopen_ticket',{
            linkedTicket:{id:ticket.id,revision:ticket.revision}})}>Reopen ticket</button>:
            <button type="button" disabled={busy||!!detail.pendingReply} onClick={()=>void write('resolve',{
              linkedTicket:{id:ticket.id,revision:ticket.revision}})}>Resolve conversation and close ticket</button>}
        </div>}
        {editable&&(mine||isOwner)&&t.status==='open'&&<TicketAssignment key={ticket.id} ticket={ticket} threadRevision={t.revision}
          choices={ticketAssignees} busy={busy} write={write}/>}</>}</div>:
      editable&&mine&&t.status==='open'&&<><form onSubmit={event=>{
        event.preventDefault();
        void write('create_ticket',{priority:new FormData(event.currentTarget).get('priority')});
      }}>
        <label htmlFor="inbox-ticket-priority">Ticket priority</label>
        <select id="inbox-ticket-priority" name="priority" defaultValue="Medium" disabled={busy}>
          {ticketPriorities.map(priority=><option key={priority}>{priority}</option>)}
        </select>
        <button disabled={busy}>Create ticket</button>
      </form>
      <LinkExistingTicket workspaceId={query.workspaceId} busy={busy} write={write} revision={t.revision}/>
      </>}
    <h3>Conversation tags</h3>
    {t.tags.length?<div className="inbox-tags">{t.tags.map(tag=><span key={tag}>{tag}</span>)}</div>:<p>No tags</p>}
    {editable&&mine&&(tags===null?<button type="button" disabled={busy} onClick={()=>{setTags(t.tags.join(', '));setTagRevision(t.revision);}}>Edit tags</button>:
      <form onSubmit={async event=>{event.preventDefault();if(await write('tag',{revision:tagRevision,tags:tags.split(',').map(v=>v.trim()).filter(Boolean)}))setTags(null);}}>
        <label>Tags, separated by commas<input maxLength={420} value={tags} onChange={e=>setTags(e.target.value)}/></label>
        <button disabled={busy||tagRevision!==t.revision}>Save tags</button> <button type="button" onClick={()=>setTags(null)}>Cancel</button>
        {tagRevision!==t.revision&&<p role="status">The conversation changed. Cancel and reopen the tag editor to see the latest tags.</p>}
      </form>)}
  </aside></div>;
}

function LinkExistingTicket({workspaceId,busy,write,revision}:{workspaceId?:string;busy:boolean;write:Write;revision:number}){
  const [openedAt,setOpenedAt]=useState<number|null>(null);
  const [ticket,setTicket]=useState<{id:string;revision?:number}|null>(null);
  if(openedAt===null)return <button type="button" disabled={busy} onClick={()=>setOpenedAt(revision)}>Link existing ticket</button>;
  return <form onSubmit={event=>{
    event.preventDefault();
    if(ticket?.revision)void write('link_ticket',{revision:openedAt,ticketId:ticket.id,ticketRevision:ticket.revision});
  }}>
    <fieldset disabled={busy}><legend>Link existing ticket</legend>
      <PortableRecordPicker kind="tickets" field="linkedTicket" label="Existing ticket" value={null} workspaceId={workspaceId}
        onSelect={setTicket} emptyLabel="Choose a ticket"/>
      {openedAt!==revision&&<p role="status">The conversation changed. Cancel and reopen to review it.</p>}
      <button disabled={!ticket||openedAt!==revision}>Link ticket</button>{' '}
      <button type="button" onClick={()=>{setTicket(null);setOpenedAt(null);}}>Cancel</button>
    </fieldset>
  </form>;
}

function TeamNote({busy,write}:{busy:boolean;write:Write}){
  const [body,setBody]=useState('');
  const attempt=useRef<{noteId:string;body:string}|null>(null);
  return <details className="inbox-note"><summary>Add team note</summary>
    <form onSubmit={async event=>{
      event.preventDefault();
      const text=body.trim();
      if(!text||busy)return;
      if(attempt.current?.body!==text)attempt.current={noteId:crypto.randomUUID(),body:text};
      if(await write('note',attempt.current)){setBody('');attempt.current=null;}
    }}>
      <label>Note for teammates<textarea rows={3} maxLength={2000} value={body} disabled={busy}
        onChange={e=>setBody(e.target.value)}/></label>
      <button type="submit" disabled={busy||!body.trim()}>Save team note</button>
    </form>
  </details>;
}

function TicketTagEditor({tags,ticketId,ticketRevision,threadRevision,editable,busy,write,workspaceId}:{
  tags:string[];ticketId:string;ticketRevision:number;threadRevision:number;editable:boolean;busy:boolean;write:Write;workspaceId?:string;
}){
  const [draft,setDraft]=useState<{text:string;ticket:number;thread:number}|null>(null);
  const stale=draft&&(draft.ticket!==ticketRevision||draft.thread!==threadRevision);
  const values=draft?ticketTags.safeParse(draft.text.split(/\r?\n/).map(tag=>tag.trim()).filter(Boolean)):undefined;
  const edit=()=>setDraft({text:tags.join('\n'),ticket:ticketRevision,thread:threadRevision});
  return <div className="inbox-ticket-tags">
    {tags.length>0&&<div className="inbox-tags" aria-label="Ticket tags">{tags.map(tag=><a key={tag}
      aria-label={'Open conversations with ticket tag '+tag} href={page({workspaceId,ticketTag:tag})}>{tag}</a>)}</div>}
    {editable&&(draft?<form onSubmit={async event=>{
      event.preventDefault();
      if(!stale&&values?.success&&await write('tag_ticket',{revision:draft.thread,linkedTicket:{id:ticketId,revision:draft.ticket},tags:values.data}))setDraft(null);
    }}>
      <label>Ticket tags, one per line<textarea rows={3} maxLength={419} value={draft.text}
        onChange={event=>setDraft({...draft,text:event.target.value})}/></label>
      {stale&&<p role="status">The ticket or conversation changed. <button type="button" onClick={edit}>Reload ticket tags</button></p>}
      {values&&!values.success&&<p role="alert">Use up to ten distinct tags, each at most 40 characters.</p>}
      <button disabled={busy||Boolean(stale)||!values?.success}>Save ticket tags</button>{' '}
      <button type="button" disabled={busy} onClick={()=>setDraft(null)}>Cancel</button>
    </form>:<button type="button" disabled={busy} onClick={edit}>Edit ticket tags</button>)}
  </div>;
}

function TicketAssignment({ticket,threadRevision,choices,busy,write}:{ticket:NonNullable<Detail['ticket']>;threadRevision:number;choices:Assignee[];busy:boolean;write:Write}){
  const [choice,setChoice]=useState<{id:string;revision:number;ticketRevision:number}|null>(null);
  const stale=choice&&(choice.revision!==threadRevision||choice.ticketRevision!==ticket.revision);
  return <details><summary>Reassign ticket</summary>
    <form onSubmit={async event=>{
      event.preventDefault();
      if(!choice||stale)return;
      if(await write('assign_ticket',{revision:choice.revision,ticketId:ticket.id,ticketRevision:choice.ticketRevision,assigneeId:choice.id}))setChoice(null);
    }}>
      <label htmlFor="inbox-ticket-assignee">Ticket assignee</label>
      <select id="inbox-ticket-assignee" value={choice?.id??''} onChange={event=>setChoice(event.target.value?
        {id:event.target.value,revision:threadRevision,ticketRevision:ticket.revision}:null)}>
        <option value="">Choose a teammate</option>
        {choices.filter(member=>member.id!==ticket.assigneeId).map(member=><option key={member.id} value={member.id}>{member.label}</option>)}
      </select>
      <p>The current inbox agent keeps the conversation.</p>
      {stale&&<p role="status">The ticket or conversation changed. <button type="button" onClick={()=>setChoice(null)}>Choose assignee again</button></p>}
      <button disabled={busy||!choice||!!stale}>Assign ticket</button>
    </form>
  </details>;
}

function AssignConversation({choices,replyBody,ticket,revision,busy,write}:{choices:Assignee[];replyBody:string;ticket:Detail['ticket'];revision:number;busy:boolean;write:Write}){
  const [recipient,setRecipient]=useState(''),[note,setNote]=useState(''),[draftRevision,setDraftRevision]=useState<number|null>(null);
  const [linkedTicket,setLinkedTicket]=useState<{id:string;revision:number}>();
  const active=ticket&&!ticket.archivedAt?ticket:null;
  const stale=(draftRevision!==null&&draftRevision!==revision)||Boolean(linkedTicket&&
    (linkedTicket.id!==active?.id||linkedTicket.revision!==active?.revision));
  const tooLong=note.trim().length>maxHandoffNoteLength;
  function startDraft(){setDraftRevision(current=>current??revision);}
  if(!choices.length)return null;
  return <details className="inbox-assign"><summary>Assign to teammate</summary>
    <form onSubmit={event=>{event.preventDefault();if(recipient&&!stale&&!tooLong)void write('assign',{revision,assigneeId:recipient,note:note.trim(),linkedTicket});}}>
      <label htmlFor="inbox-handoff-recipient">Teammate</label>
      <select id="inbox-handoff-recipient" required value={recipient} onChange={event=>{startDraft();setRecipient(event.target.value);if(!choices.find(member=>member.id===event.target.value)?.canTakeTicket)setLinkedTicket(undefined);}}>
        <option value="">Choose a teammate</option>
        {choices.map(member=><option key={member.id} value={member.id}>{member.label}</option>)}
      </select>
      {(active||linkedTicket)&&<label><input type="checkbox" disabled={!choices.some(member=>member.id===recipient&&member.canTakeTicket)} checked={!!linkedTicket} onChange={event=>{
        startDraft();setLinkedTicket(event.target.checked&&active?{id:active.id,revision:active.revision}:undefined);
      }}/> Also assign linked ticket</label>}
      {replyBody.trim()&&!note&&<button type="button" disabled={busy} onClick={()=>{startDraft();setNote(replyBody.trim());}}>
        Copy reply draft into handoff note</button>}
      <label>Handoff note (team only)<textarea rows={3} maxLength={maxHandoffNoteLength} value={note}
        onChange={event=>{startDraft();setNote(event.target.value);}}/></label>
      {tooLong&&<p role="status">Shorten the handoff note to {maxHandoffNoteLength.toLocaleString('en-US')} characters before assigning. Your reply draft stays in this tab.</p>}
      {stale&&<p role="status">The conversation or ticket changed. Review the latest details. <button type="button"
        onClick={()=>{setDraftRevision(revision);if(linkedTicket)setLinkedTicket(active?{id:active.id,revision:active.revision}:undefined);}}>Keep preparing handoff</button></p>}
      <button disabled={busy||!recipient||stale||tooLong}>Assign conversation</button>
    </form>
  </details>;
}

const deliveryLabel:Record<Message['state'],string>={
  note:'Team note',handoff:'Team handoff',received:'Received',sending:'Awaiting delivery confirmation',sent:'Accepted for delivery',uncertain:'Delivery unconfirmed',failed:'Delivery failed',
};

function DeliveryReview({message,write,editable,busy}:{message:Message;write:Write;editable:boolean;busy:boolean}){
  const [evidence,setEvidence]=useState('');
  const [timedOut,setTimedOut]=useState(false);
  useEffect(()=>{
    const remaining=Date.parse(message.createdAt)+600_000-Date.now();
    const timer=window.setTimeout(()=>setTimedOut(true),Math.max(0,remaining));
    return ()=>clearTimeout(timer);
  },[message.createdAt]);
  const reviewable=message.state==='uncertain'||timedOut;
  return <div className="inbox-review"><h2>{reviewable?'Delivery needs review':'Sending reply'}</h2>
    <p>{reviewable?'Harbor is waiting for the workspace owner to verify whether this reply was accepted.':
      'Waiting for the provider to confirm delivery. An owner can review this reply if confirmation takes over ten minutes.'}</p>
    {reviewable&&editable&&<details key={message.id}><summary>Review delivery</summary>
    <p>Check the provider’s activity before recording an outcome. Reply ID: <code>{message.id}</code></p>
    <blockquote>{message.body}</blockquote>
    <label>Verified outcome<select value={evidence} onChange={e=>setEvidence(e.target.value)}>
      <option value="">Select outcome</option><option value="sent">Provider accepted this reply</option><option value="failed">Provider confirms this reply was never accepted</option>
    </select></label>
    <button disabled={busy||!evidence} onClick={()=>void write(evidence==='sent'?'confirm_sent':'confirm_failed',{replyId:message.id})}>Record verified outcome</button>
  </details>}</div>;
}

const quickReplies=[
  {label:'Acknowledge an inquiry',body:'Thanks for getting in touch. I’m looking into this and will follow up here.'},
  {label:'Ask for details',body:'Could you share a little more detail about what happened and what you expected to see?'},
  {label:'Confirm resolution',body:'I’ve made the change we discussed. Could you confirm that everything looks right on your end?'},
];

function ReplyComposer({activityUrl,thread,body,setBody,workspaceId,messages,pendingReply,editable,mine,isOwner,canSend,canUseSnippets,canUseKnowledge,busy,write,actorLabel}:{
  activityUrl:string;thread:Thread;body:string;setBody:(text:string)=>void;workspaceId?:string;messages:Message[];pendingReply:Message|null;editable:boolean;mine:boolean;isOwner:boolean;canSend:boolean;canUseSnippets:boolean;canUseKnowledge:boolean;busy:boolean;write:Write;actorLabel:string;
}){
  const [draftRevision,setDraftRevision]=useState(thread.revision);
  const [attempt,setAttempt]=useState<string|null>(null),[notice,setNotice]=useState('');
  const latestBody=useRef(body);
  const lastActivity=useRef<{revision:number;time:number}|null>(null);
  const pending=!!pendingReply;
  const attemptedMessage=attempt?(pendingReply?.id===attempt?pendingReply:messages.find(m=>m.id===attempt)):undefined;
  const canCompose=editable&&mine&&canSend&&thread.status==='open';
  const review=!!body&&draftRevision!==thread.revision;
  const reason=!editable?'You have read-only access.':!canSend?'Reply sending is disabled for this mailbox.':thread.status==='resolved'?'Reopen the conversation to reply.':
    !mine?'Claim this conversation to reply.':pending?'Review the previous reply’s delivery before sending again.':'';
  function change(value:string){
    if(!body)setDraftRevision(thread.revision);
    const now=performance.now(),last=lastActivity.current;
    if(canCompose&&!busy&&!pending&&!review&&value.trim()&&(!last||last.revision!==thread.revision||now-last.time>=10_000)){
      lastActivity.current={revision:thread.revision,time:now};
      // Advisory only. Reply delivery and revision checks run independently.
      void fetch(activityUrl,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'draft_activity',id:thread.id,revision:thread.revision})}).catch(()=>{});
    }
    latestBody.current=value;setAttempt(null);setNotice('');setBody(value);
  }
  function insert(text:string){
    const current=latestBody.current,next=current?current+'\n\n'+text:text;
    if(next.length>16000){setNotice('The combined reply exceeds 16,000 characters. Shorten the draft before inserting.');return;}
    change(next);
  }
  async function send(){
    if(!canCompose||busy||pending||review||!body.trim())return;
    const replyId=attempt??crypto.randomUUID();
    setAttempt(replyId);
    if(await write('reply',{replyId,body:body.trim(),revision:draftRevision})){
      latestBody.current='';setBody('');setAttempt(null);setNotice('Reply accepted for delivery.');
    }
  }
  return <section className="inbox-compose"><h2><Send size={17}/> Reply</h2>
    {reason&&<p>{reason}</p>}
    {(canCompose||body)&&<>
      <fieldset disabled={!canCompose||busy||pending||!!attemptedMessage}>
        <label>Reply to {thread.sender}<textarea rows={5} maxLength={16000} value={body} onChange={e=>change(e.target.value)}/></label>
        {canUseSnippets&&<QuickReplyPicker workspaceId={workspaceId} insert={insert}/>}
        {canUseKnowledge&&<PublishedArticlePicker workspaceId={workspaceId} action="Insert" onSelect={item=>insert(item.title+'\n'+new URL(item.path,window.location.origin).href)}/>}
        {isOwner&&<SavedTemplatePicker recipient={thread.sender} actorLabel={actorLabel} insert={insert}/>}
      </fieldset>
      {attemptedMessage?<p role="status">This draft has a delivery record: {deliveryLabel[attemptedMessage.state]}.{' '}
        {attemptedMessage.state!=='sending'&&attemptedMessage.state!=='uncertain'&&<button type="button" disabled={busy} onClick={()=>{
          if(attemptedMessage.state==='sent'){latestBody.current='';setBody('');}
          setAttempt(null);setDraftRevision(thread.revision);
        }}>{attemptedMessage.state==='sent'?'Clear sent draft':'Prepare a new attempt'}</button>}</p>:
        review&&<p role="status">The conversation changed while you were writing. Read the latest messages before sending.{' '}
          {canCompose&&!pending&&<button disabled={busy} onClick={()=>setDraftRevision(thread.revision)}>I reviewed the conversation</button>}</p>}
      {canCompose&&<button className="inbox-send" disabled={busy||review||pending||!!attemptedMessage||!body.trim()} onClick={()=>void send()}><Send size={15}/> Send reply</button>}
    </>}
    {notice&&<p role="status"><Check size={15}/> {notice}</p>}
  </section>;
}

function SavedTemplatePicker({actorLabel,recipient,insert}:{actorLabel:string;recipient:string;insert:(body:string)=>void}){
  const [open,setOpen]=useState(false),[term,setTerm]=useState(''),[options,setOptions]=useState<{id:string;name:string}[]>([]);
  const [selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[more,setMore]=useState(false);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      try{
        const r=await fetch(url('/api/email/templates',{search:term.trim()||undefined}),{signal:controller.signal,cache:'no-store'});
        if(!r.ok)throw Error();
        const result=await r.json() as {items:{id:string;name:string}[];next:string|null};
        if(!controller.signal.aborted){setOptions(result.items);setMore(!!result.next);setError('');}
      }catch{if(!controller.signal.aborted)setError('Could not load templates.');}
    },200);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[open,term]);
  async function add(){
    setBusy(true);setError('');
    try{
      const r=await fetch(url('/api/email/templates',{id:selected}),{cache:'no-store'});
      if(!r.ok)throw Error();
      const {template}=await r.json() as {template:{subject:string;body:string}};
      const result=renderPortableTemplate({...template,subject:'Reply'},{email:recipient},actorLabel);
      if(!result||result.missing.length){setError('This template needs contact details. Use a template with email or sender fields instead.');return;}
      insert(result.body);
    }catch{setError('Could not insert this template.');}
    finally{setBusy(false);}
  }
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>My saved email templates</summary>
    <label>Find template<input value={term} maxLength={120} onChange={e=>{setTerm(e.target.value);setSelected('');setOptions([]);setMore(false);}}/></label>
    <label>Template<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Choose template</option>
      {options.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    {more&&<small>Search by name to find more templates.</small>}
    <button type="button" disabled={busy||!selected} onClick={()=>void add()}>Insert template</button>
    {error&&<p role="status">{error}</p>}
  </details>;
}

type QuickReply={id:string;revision:number;name:string;body:string};
function useQuickReplies(workspaceId?:string){
  const [items,setItems]=useState<QuickReply[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const sequence=useRef(0);
  const refresh=useCallback(async()=>{
    const current=++sequence.current;
    try{
      const r=await fetch(url('/api/team-inbox',{snippets:'1',workspaceId}),{cache:'no-store'});
      if(!r.ok)throw Error();
      const result=await r.json() as {items:QuickReply[]};
      if(current===sequence.current){setItems(result.items);setError('');}
      return result.items;
    }catch{
      if(current===sequence.current){setItems([]);setError('Could not load workspace quick replies.');}
      return null;
    }finally{if(current===sequence.current)setLoading(false);}
  },[workspaceId]);
  useEffect(()=>{
    const load=()=>{void refresh();};
    const frame=window.requestAnimationFrame(load);
    window.addEventListener('focus',load);
    return ()=>{window.cancelAnimationFrame(frame);window.removeEventListener('focus',load);};
  },[refresh]);
  return {items,error,loading,refresh};
}

function QuickReplyPicker({workspaceId,insert}:{workspaceId?:string;insert:(text:string)=>void}){
  const [open,setOpen]=useState(false);
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>Quick replies</summary>
    {open&&<QuickReplySearch key={workspaceId} workspaceId={workspaceId} insert={insert}/>}
  </details>;
}

function QuickReplySearch({workspaceId,insert}:{workspaceId?:string;insert:(text:string)=>void}){
  const choiceId=useId();
  const [term,setTerm]=useState(''),[selection,setSelection]=useState('');
  const [names,setNames]=useState<Pick<QuickReply,'id'|'name'>[]|null>(null);
  const [body,setBody]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const q=term.trim();
  const defaults=quickReplies.filter(reply=>[reply.label,reply.body].some(text=>text.toLowerCase().includes(q.toLowerCase())));
  const builtin=quickReplies.find(reply=>reply.label===selection);
  const preview=builtin?.body??body;
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      try{
        const res=await fetch(url('/api/team-inbox',{snippets:'names',workspaceId,q}),{signal:controller.signal,cache:'no-store'});
        if(!res.ok)throw Error();
        const result=await res.json() as {items:Pick<QuickReply,'id'|'name'>[]};
        if(!controller.signal.aborted)setNames(result.items);
      }catch{if(!controller.signal.aborted)setError('Could not search workspace replies.');}
    },160);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[q,retry,workspaceId]);
  useEffect(()=>{
    if(!selection||builtin)return;
    const controller=new AbortController();
    async function load(){
      try{
        const res=await fetch(url('/api/team-inbox',{snippets:'1',workspaceId,id:selection}),{signal:controller.signal,cache:'no-store'});
        if(!res.ok)throw Error();
        const {items}=await res.json() as {items:QuickReply[]};
        if(controller.signal.aborted)return;
        if(items[0])setBody(items[0].body);
        else setError('This quick reply is no longer available.');
      }catch{if(!controller.signal.aborted)setError('Could not load this quick reply.');}
    }
    void load();
    return ()=>controller.abort();
  },[selection,builtin,retry,workspaceId]);
  function select(id:string){setSelection(id);setBody('');setError('');}
  return <div>
    <label>Find a quick reply<input type="search" placeholder="Search names and messages" maxLength={120} value={term}
      onChange={e=>{if(e.target.value.trim()!==q){select('');setNames(null);}setTerm(e.target.value);}}/></label>
    <div className="inbox-compose-actions"><div><label htmlFor={choiceId}>Quick reply</label><select id={choiceId} value={selection} onChange={e=>select(e.target.value)}>
      <option value="">Choose a reply</option>
      {!!names?.length&&<optgroup label="Workspace quick replies">{names.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}
      {defaults.length>0&&<optgroup label="Harbor quick replies">{defaults.map(s=><option key={s.label}>{s.label}</option>)}</optgroup>}
    </select></div>
    <button type="button" disabled={!preview} onClick={()=>{if(preview){insert(preview);select('');}}}>Insert reply</button></div>
    {preview&&<blockquote className="inbox-reply-preview" aria-label="Quick reply preview">{preview}</blockquote>}
    {error?<p role="status">{error} <button type="button" onClick={()=>{setError('');setRetry(n=>n+1);}}>Retry</button></p>:
      !names?<p role="status">Searching workspace replies…</p>:selection&&!preview?<p role="status">Loading preview…</p>:
      !names.length&&!defaults.length?<p role="status">No matching quick replies.</p>:null}
  </div>;
}

function InboxQuickReplySettings(){
  const [open,setOpen]=useState(false);
  return <details className="inbox-library" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>Manage quick replies</summary>{open&&<QuickReplyEditor/>}
  </details>;
}

export function QuickReplyEditor(){
  const {items,refresh,error,loading}=useQuickReplies();
  const blank=():QuickReply=>({id:crypto.randomUUID(),name:'',body:'',revision:0});
  const [draft,setDraft]=useState<QuickReply|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [conflict,setConflict]=useState(false);
  const latest=items.find(item=>item.id===draft?.id);
  function choose(value:string){
    setDraft(items.find(s=>s.id===value)??blank());setNotice('');setConflict(false);
  }
  async function change(action:'save_snippet'|'delete_snippet'){
    if(!draft||busy||conflict)return;
    if(action==='delete_snippet'&&!window.confirm('Delete “'+draft.name+'” from this workspace’s quick replies?'))return;
    setBusy(true);setNotice('');
    try{
      const r=await fetch('/api/team-inbox',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        action,id:draft.id,revision:draft.revision,...(action==='save_snippet'?{name:draft.name.trim(),body:draft.body.trim()}:{})
      })});
      if(!r.ok){
        const result=await r.json() as {error?:string};
        if(r.status===409||r.status===404){
          await refresh();setConflict(true);
          setNotice(result.error||'This quick reply changed. Your draft is still here.');return;
        }
        throw Error(result.error||'Could not save the quick reply.');
      }
      await refresh();setDraft(null);setNotice(action==='delete_snippet'?'Quick reply deleted.':'Quick reply saved.');
    }catch(e){
      setNotice(e instanceof TypeError?'Could not confirm the change. Refresh the library before retrying.':
        e instanceof Error?e.message:'Could not confirm the quick reply change.');
    }finally{setBusy(false);}
  }
  return <div><p>These replies are available to teammates working in this inbox.</p>
    {error&&<p role="status">{error} <button type="button" onClick={()=>void refresh()}>Reload library</button></p>}
    <fieldset disabled={busy||loading}><label>Choose quick reply<select value={draft?draft.revision?draft.id:'new':''} onChange={e=>choose(e.target.value)}>
      <option disabled value="">Choose a reply</option><option value="new">New quick reply</option>
      {items.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
      {draft&&<form onSubmit={e=>{e.preventDefault();void change('save_snippet');}}>
        <label>Quick reply name<input required maxLength={100} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        <label>Quick reply message<textarea required rows={4} maxLength={16000} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/></label>
        <button disabled={conflict||!draft.name.trim()||!draft.body.trim()}>Save quick reply</button>{' '}
        {draft.revision>0&&<button type="button" disabled={conflict} onClick={()=>void change('delete_snippet')}>Delete quick reply</button>}
      </form>}
    </fieldset>
    {notice&&<p role="status">{notice}</p>}
    {conflict&&draft&&!error&&<div>{latest?<><p>Current saved reply: <strong>{latest.name}</strong></p><blockquote>{latest.body}</blockquote>
      <button type="button" onClick={()=>choose(latest.id)}>Use saved version</button>{' '}
      <button type="button" onClick={()=>{setDraft({...draft,revision:latest.revision});setConflict(false);setNotice('Your draft is ready to edit and save.');}}>Keep my draft</button></>:
      <button type="button" onClick={()=>{setDraft({...draft,id:crypto.randomUUID(),revision:0});setConflict(false);setNotice('Choose a unique name and save your quick reply.');}}>Keep draft as a new quick reply</button>}</div>}
  </div>;
}
