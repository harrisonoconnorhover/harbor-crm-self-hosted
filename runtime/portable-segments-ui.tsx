'use client';

import {useRouter} from 'next/navigation';
import {useRef,useState,useTransition,type FormEvent} from 'react';
import {lifecycles} from '../lib/crm';
import {portableRecordPath} from '../lib/portable-record-path';
import {recordSearchLimit} from '../lib/portable-records';
import {maxPortableListGroups} from '../lib/portable-segments';
import type {PortableSegment,PortableSegmentDefinition,PortableSegmentList,PortableSegmentMembers,PortableSegmentMembershipReceipt,PortableSegmentWrite} from '../lib/portable-segments';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

type MembershipChange=Extract<PortableSegmentWrite,{action:'members'}>;
type Rule=PortableSegmentDefinition['criteria']['groups'][number][number];
const format=new Intl.NumberFormat('en-US');

function link({workspaceId,segment,q,memberQ,after}:{workspaceId?:string;segment?:string;q?:string;memberQ?:string;after?:string}={}){
  const query=new URLSearchParams({view:'segments'});
  if(workspaceId)query.set('workspaceId',workspaceId);
  if(segment)query.set('segment',segment);
  if(q)query.set('q',q);
  if(memberQ)query.set('memberQ',memberQ);
  if(after)query.set('after',after);
  return '/?'+query;
}

function MemberSearch({workspaceId,segment,q,memberQ,disabled}:{workspaceId?:string;segment:string;q?:string;memberQ?:string;disabled:boolean}){
  return <form action="/" method="get" role="search" aria-label="Find list members">
    <input type="hidden" name="view" value="segments"/>
    {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
    <input type="hidden" name="segment" value={segment}/>
    {q&&<input type="hidden" name="q" value={q}/>}
    <label>Search members<input key={memberQ??''} name="memberQ" type="search" placeholder="Name or email"
      maxLength={recordSearchLimit} defaultValue={memberQ} disabled={disabled}/></label>
    <button type="submit" disabled={disabled}>Search members</button>
    {memberQ&&!disabled&&<> <a href={link({workspaceId,segment,q})}>Clear member search</a></>}
  </form>;
}

function ContactsTable({page,label,workspaceId,selection,onSelect,disabled}: {
  page:Pick<PortableSegmentMembers,'items'>;workspaceId?:string;label:string;selection?:string[];onSelect?:(id:string)=>void;disabled:boolean;
}){
  if(!page.items.length)return <p>No contacts on this page.</p>;
  return <div className="portable-contacts-table"><table aria-label={label}>
    <thead><tr>{selection&&<th scope="col">Select</th>}<th scope="col">Contact</th><th scope="col">Email</th><th scope="col">Lifecycle stage</th></tr></thead>
    <tbody>{page.items.map(contact=><tr key={contact.id}>
      {selection&&<td><input type="checkbox" aria-label={'Select '+contact.name} checked={selection.includes(contact.id)}
        disabled={disabled} onChange={()=>onSelect?.(contact.id)}/></td>}
      <th scope="row"><a href={portableRecordPath('contacts',contact.id,workspaceId)}>{contact.name}</a></th>
      <td>{contact.email||'—'}</td><td>{contact.lifecycle||'—'}</td>
    </tr>)}</tbody>
  </table></div>;
}

function StaticMembership({members,q,memberQ,after,editing,onPending}:{
  members:PortableSegmentMembers;q?:string;memberQ?:string;after?:string;editing:boolean;onPending:(pending:boolean)=>void;
}){
  const router=useRouter();
  const {segment}=members;
  const [selected,setSelected]=useState<string[]>([]);
  const [showCandidates,setShowCandidates]=useState(false);
  const [candidates,setCandidates]=useState<PortableSegmentMembers>();
  const [query,setQuery]=useState('');
  const [candidateAfter,setCandidateAfter]=useState<string>();
  const [pending,setPending]=useState<MembershipChange>();
  const [busy,setBusy]=useState(false);
  const [refreshing,startRefresh]=useTransition();
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [refreshRequired,setRefreshRequired]=useState(false);
  const locked=editing||busy||refreshing||!!pending||refreshRequired;

  async function findCandidates(text:string,cursor?:string){
    if(locked)return;
    setBusy(true);
    setError('');
    setNotice('');
    setSelected([]);
    setCandidates(undefined);
    setShowCandidates(true);
    const params=new URLSearchParams({id:segment.id,candidates:'true'});
    if(text)params.set('q',text);
    if(cursor)params.set('after',cursor);
    try{
      const response=await fetch('/api/segments?'+params,{cache:'no-store'});
      if(!response.ok)throw Error('Could not load contacts.');
      setCandidates(await response.json() as PortableSegmentMembers);
      setQuery(text);
      setCandidateAfter(cursor);
    }catch{setError('Could not load contacts. Try searching again.');}
    finally{setBusy(false);}
  }

  async function changeMembership(operation:MembershipChange['operation']){
    const change=pending??{
      action:'members',id:segment.id,revision:segment.revision,requestId:crypto.randomUUID(),operation,contactIds:selected,
    };
    if(!change.contactIds.length||editing||busy||refreshing||refreshRequired)return;
    setBusy(true);
    setPending(change);
    onPending(true);
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/segments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(change)});
      const result=await response.json() as {receipt?:PortableSegmentMembershipReceipt;error?:string};
      if(!response.ok){
        if(response.status>=500)throw Error('Unconfirmed membership change');
        setPending(undefined);
        onPending(false);
        setSelected([]);
        setError(result.error??'Could not update list membership.');
        if(response.status===409)setRefreshRequired(true);
        return;
      }
      if(result.receipt?.id!==segment.id||result.receipt.requestId!==change.requestId)throw Error('Unconfirmed membership change');
      setPending(undefined);
      onPending(false);
      setSelected([]);
      setShowCandidates(false);
      setCandidates(undefined);
      setNotice(change.operation==='add'?'Contacts added.':'Contacts removed.');
      startRefresh(()=>router.refresh());
    }catch{setError('Could not confirm the membership change. Retry to check and finish the same change.');}
    finally{setBusy(false);}
  }

  function toggle(id:string){
    setSelected(current=>current.includes(id)?current.filter(value=>value!==id):[...current,id]);
  }

  return <>
    <p>Static membership changes when you add or remove contacts. It does not enroll contacts in workflows.</p>
    {error&&<p role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {pending&&<button type="button" disabled={busy} onClick={()=>void changeMembership(pending.operation)}>Retry same membership change</button>}
    <button type="button" disabled={locked} aria-expanded={showCandidates} onClick={()=>{
      if(showCandidates){setSelected([]);setShowCandidates(false);setCandidates(undefined);setError('');}
      else void findCandidates('');
    }}>{showCandidates?'Close contact picker':'Add contacts'}</button>{' '}
    {!showCandidates&&<button type="button" disabled={locked||!selected.length} onClick={()=>void changeMembership('remove')}>Remove selected contacts</button>}
    {refreshRequired&&<button type="button" disabled={editing||busy||refreshing} onClick={()=>{
      setRefreshRequired(false);setError('');setShowCandidates(false);setCandidates(undefined);
      startRefresh(()=>router.refresh());
    }}>Refresh members before trying again</button>}
    {showCandidates?<>
      <form aria-label="Find contacts to add" onSubmit={event=>{
        event.preventDefault();
        const text=String(new FormData(event.currentTarget).get('search')??'').trim();
        void findCandidates(text);
      }}>
        <label>Search contacts to add<input name="search" type="search" maxLength={recordSearchLimit} disabled={locked}/></label>
        <button type="submit" disabled={locked}>Search contacts</button>
      </form>
      {busy&&!candidates&&<p role="status">Loading contacts…</p>}
      {candidates&&<>
        <ContactsTable page={candidates} label="Contacts to add" selection={selected} onSelect={toggle} disabled={locked}/>
        <button type="button" disabled={locked||!selected.length} onClick={()=>void changeMembership('add')}>Add selected contacts</button>{' '}
        {candidateAfter&&<button type="button" disabled={locked} onClick={()=>void findCandidates(query)}>First results</button>}{' '}
        {candidates.next&&<button type="button" disabled={locked} onClick={()=>void findCandidates(query,candidates.next!)}>Next results</button>}
      </>}
    </>:<>
      <MemberSearch segment={segment.id} q={q} memberQ={memberQ} disabled={locked}/>
      <ContactsTable page={members} label="List members" selection={selected} onSelect={toggle} disabled={locked}/>
      {!locked&&(after||members.next)&&<nav aria-label="Member pages">
        {after&&<a href={link({segment:segment.id,q,memberQ})}>First members</a>}
        {members.next&&<a href={link({segment:segment.id,q,memberQ,after:members.next})}>Next members</a>}
      </nav>}
    </>}
  </>;
}

export function PortableSegments({email,list,members,q,memberQ,after,origin}:{
  email:string;origin:string;list:PortableSegmentList;members?:PortableSegmentMembers;q?:string;memberQ?:string;after?:string;
}){
  const router=useRouter();
  const segment=members?.segment;
  const createId=useRef<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [membershipPending,setMembershipPending]=useState(false);
  const [newMode,setNewMode]=useState<PortableSegment['mode']>('active');
  const [initialMembers,setInitialMembers]=useState<'empty'|'snapshot'>('empty');
  const mode=segment?.mode??newMode;
  const showFilters=mode==='active'||!segment&&initialMembers==='snapshot';
  const [error,setError]=useState('');
  const [groupIds,setGroupIds]=useState(()=>segment?.criteria.groups.length?segment.criteria.groups.map((_,i)=>i):[0]);
  const nextGroupId=useRef(groupIds.length);
  const ruleValue=(id:number,field:Rule['field'])=>segment?.criteria.groups[id]?.find(rule=>rule.field===field)?.value??'';

  async function send(input:PortableSegmentWrite){
    if(busy)return;
    setBusy(true);
    setError('');
    try{
      const response=await fetch('/api/segments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      const result=await response.json() as {segment?:PortableSegment;ok?:true;error?:string};
      if(!response.ok){
        setError(result.error??'Could not finish this list request.');
        return;
      }
      return result;
    }catch{
      setError('Could not confirm the change. Reload to check the saved list.');
    }finally{setBusy(false);}
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(membershipPending)return;
    const data=new FormData(event.currentTarget);
    const name=String(data.get('name')??'').trim();
    const description=String(data.get('description')??'').trim();
    const groups:Rule[][]=[];
    for(const id of showFilters?groupIds:[]){
      const group:Rule[]=[];
      const lifecycle=String(data.get('lifecycle-'+id)??'') as typeof lifecycles[number]|'';
      if(lifecycle)group.push({field:'lifecycle',operator:'eq',value:lifecycle,valueTo:''});
      for(const field of ['name','email'] as const){
        const value=String(data.get(field+'-'+id)??'').trim();
        if(value)group.push({field,operator:'contains',value,valueTo:''});
      }
      if(group.length)groups.push(group);
      else if(groupIds.length>1){setError('Add a filter to each group or remove the empty group.');return;}
    }
    const id=segment?.id??(createId.current??=crypto.randomUUID());
    const result=await send({action:'save',segment:{id,revision:segment?.revision??0,name,description,kind:'contacts',mode,
      criteria:{groups},...(!segment&&mode==='static'?{initialMembers}:{})}});
    if(result?.segment){
      if(!segment||after)router.replace(link({segment:id,q,memberQ}));
      router.refresh();
    }
  }

  async function remove(){
    if(!segment||busy||membershipPending||!confirm('Delete “'+segment.name+'”? Its contacts stay in Harbor.'))return;
    if((await send({action:'delete',id:segment.id,revision:segment.revision}))?.ok){
      router.replace(link({q}));
      router.refresh();
    }
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="segments"/>
    <ListLibrary list={list} segment={segment?.id} q={q} after={after}/>
    {members&&segment&&<section aria-label="List sharing">
      <h2>List sharing</h2>
      <p>{segment.shared?'Workspace teammates can open this list. Each sees only contacts they can already view.':'Only you can open this list.'}</p>
      <button disabled={busy||membershipPending} type="button" onClick={async()=>{
        if(await send({action:'share',id:segment.id,revision:segment.revision,shared:!segment.shared}))router.refresh();
      }}>{segment.shared?'Stop sharing list':'Share list with workspace'}</button>
      {segment.shared&&<label>Teammate link<input readOnly value={origin+link({segment:segment.id,workspaceId:members.workspaceId})}
        onFocus={e=>e.currentTarget.select()}/></label>}
    </section>}
    <section aria-labelledby="portable-segment-editor">
      <h2 id="portable-segment-editor">{segment?'Edit '+segment.name:'Create a contact list'}</h2>
      {mode==='active'&&<p>A contact joins if it matches every filter in any one group. Leave a single group empty to include all contacts.</p>}
      {mode==='static'&&<p>Add or remove contacts to manage a static list. They do not trigger automatic workflow enrollment.</p>}
      {error&&<p role="alert">{error}</p>}
      <form onSubmit={save} aria-label="List settings">
        <fieldset disabled={busy||membershipPending}>
          {segment?<p>Type: {mode==='static'?'Static':'Active'}</p>:<label>List type<select value={newMode}
            onChange={event=>setNewMode(event.target.value==='static'?'static':'active')}>
            <option value="active">Active</option><option value="static">Static</option>
          </select></label>}
          <label>Name<input name="name" defaultValue={segment?.name} required maxLength={120}/></label>
          <label>Description<textarea name="description" defaultValue={segment?.description} maxLength={2000}/></label>
        </fieldset>
        {!segment&&mode==='static'&&<fieldset disabled={busy}>
          <label>Starting contacts<select value={initialMembers} onChange={event=>setInitialMembers(event.target.value==='snapshot'?'snapshot':'empty')}>
            <option value="empty">Start empty</option><option value="snapshot">Add contacts matching filters now</option>
          </select></label>
          {initialMembers==='snapshot'&&<p>Harbor adds contacts that match these filters now. Empty filters include all current contacts.</p>}
        </fieldset>}
        {showFilters&&<>
          {groupIds.map((id,index)=><fieldset key={id} disabled={busy||membershipPending}>
            <legend>{(index?'Or match group ':'Match group ')+(index+1)}</legend>
            <label>Lifecycle stage<select name={'lifecycle-'+id} defaultValue={ruleValue(id,'lifecycle')}>
              <option value="">Any stage</option>
              {lifecycles.map(stage=><option key={stage}>{stage}</option>)}
            </select></label>
            <label>Name contains<input name={'name-'+id} defaultValue={ruleValue(id,'name')} maxLength={recordSearchLimit}/></label>
            <label>Email contains<input name={'email-'+id} defaultValue={ruleValue(id,'email')} maxLength={recordSearchLimit}/></label>
            {groupIds.length>1&&<button type="button" onClick={()=>setGroupIds(groupIds.filter(key=>key!==id))}>Remove group {index+1}</button>}
          </fieldset>)}
          {groupIds.length<maxPortableListGroups&&<button type="button" disabled={busy||membershipPending}
            onClick={()=>setGroupIds([...groupIds,nextGroupId.current++])}>Add OR group</button>}
        </>}
        <button type="submit" disabled={busy||membershipPending}>{busy?'Saving…':'Save list'}</button>{' '}
        {segment&&<button type="button" disabled={busy||membershipPending} onClick={()=>void remove()}>Delete list</button>}
      </form>
    </section>
    {members&&<section aria-labelledby="portable-segment-members">
      <h2 id="portable-segment-members">{(memberQ?'Matching members':'Members')+' · '+format.format(members.total as `${number}`)}</h2>
      {mode==='static'?<StaticMembership key={JSON.stringify([members.segment.id,memberQ,after])} members={members} q={q} memberQ={memberQ} after={after} editing={busy}
        onPending={setMembershipPending}/>:<>
        <p>Membership reflects the current saved filters and contact properties.</p>
        <MemberSearch segment={members.segment.id} q={q} memberQ={memberQ} disabled={busy}/>
        <ContactsTable page={members} label="List members" disabled={busy}/>
        {(after||members.next)&&<nav aria-label="Member pages">
          {after&&<a href={link({segment:members.segment.id,q,memberQ})}>First members</a>}
          {members.next&&<a href={link({segment:members.segment.id,q,memberQ,after:members.next})}>Next members</a>}
        </nav>}
      </>}
    </section>}
  </main>;
}


type ListLibraryData={segments:Pick<PortableSegment,'id'|'name'|'description'|'mode'>[];next:string|null};
function ListLibrary({list,segment,q,after,workspaceId}:{list:ListLibraryData;segment?:string;q?:string;after?:string;workspaceId?:string}){
  return     <section aria-labelledby="portable-segments-title">
      <div className="portable-contacts-heading"><h1 id="portable-segments-title">Lists</h1>{!workspaceId&&<a href={link({q})}>New list</a>}</div>
      <form action="/" method="get" aria-label="Find lists">
        <input type="hidden" name="view" value="segments"/>
        {workspaceId&&<input type="hidden" name="workspaceId" value={workspaceId}/>}
        <label>Search lists<input name="q" type="search" maxLength={recordSearchLimit} defaultValue={q}/></label>
        <button type="submit">Search</button>{' '}<a href={link({workspaceId})}>Clear search</a>
      </form>
      {list.segments.length?<div className="portable-contacts-table"><table aria-label="Saved lists">
        <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead>
        <tbody>{list.segments.map(item=><tr key={item.id}>
          <th scope="row"><a href={link({workspaceId,segment:item.id,q})} aria-current={item.id===segment?'page':undefined}>{item.name}</a></th>
          <td>{item.mode==='static'?'Static':'Active'}</td><td>{item.description||'—'}</td>
        </tr>)}</tbody>
      </table></div>:<p>No saved lists match this view.</p>}
      {(!segment&&after||list.next)&&<nav aria-label="List pages">
        {!segment&&after&&<a href={link({workspaceId,q})}>First lists</a>}
        {list.next&&<a href={link({workspaceId,q,after:list.next})}>Next lists</a>}
      </nav>}
    </section>;
}

export function SharedLists({email,workspaceId,list,members,q,memberQ,after}:{email:string;workspaceId:string;list:ListLibraryData;
  members?:Pick<PortableSegmentMembers,'items'|'total'|'next'>&{segment:ListLibraryData['segments'][number]};q?:string;memberQ?:string;after?:string}){
  const segment=members?.segment.id;
  return <main className="portable-contacts">
    <PortableCrmHeader email={email} workspaceId={workspaceId} page="segments"/>
    <ListLibrary list={list} segment={segment} q={q} after={after} workspaceId={workspaceId}/>
    {members&&segment&&<section aria-label="Shared list members"><h2>{members.segment.name}</h2>
      <p>{memberQ?'Matching contacts':'Contacts you can view'} · {format.format(members.total as `${number}`)}</p>
      <MemberSearch workspaceId={workspaceId} segment={segment} q={q} memberQ={memberQ} disabled={false}/>
      <ContactsTable workspaceId={workspaceId} page={members} label="List members" disabled={false}/>
      {after&&<a href={link({workspaceId,segment,q,memberQ})}>First members</a>}
      {members.next&&<a href={link({workspaceId,segment,q,memberQ,after:members.next})}>Next members</a>}
    </section>}
  </main>;
}
