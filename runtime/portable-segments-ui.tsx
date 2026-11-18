'use client';

import {useRouter} from 'next/navigation';
import {useRef,useState,useTransition,type FormEvent} from 'react';
import {lifecycles} from '../lib/crm';
import {recordSearchLimit} from '../lib/portable-records';
import type {PortableSegment,PortableSegmentDefinition,PortableSegmentList,PortableSegmentMembers,PortableSegmentMembershipReceipt,PortableSegmentWrite} from '../lib/portable-segments';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

type MembershipChange=Extract<PortableSegmentWrite,{action:'members'}>;
type Rule=PortableSegmentDefinition['criteria']['groups'][number][number];
const format=new Intl.NumberFormat('en-US');

function link({segment,q,memberQ,after}:{segment?:string;q?:string;memberQ?:string;after?:string}={}){
  const query=new URLSearchParams({view:'segments'});
  if(segment)query.set('segment',segment);
  if(q)query.set('q',q);
  if(memberQ)query.set('memberQ',memberQ);
  if(after)query.set('after',after);
  return '/?'+query;
}

function MemberSearch({segment,q,memberQ,disabled}:{segment:string;q?:string;memberQ?:string;disabled:boolean}){
  return <form action="/" method="get" role="search" aria-label="Find segment members">
    <input type="hidden" name="view" value="segments"/>
    <input type="hidden" name="segment" value={segment}/>
    {q&&<input type="hidden" name="q" value={q}/>}
    <label>Search members<input key={memberQ??''} name="memberQ" type="search" placeholder="Name or email"
      maxLength={recordSearchLimit} defaultValue={memberQ} disabled={disabled}/></label>
    <button type="submit" disabled={disabled}>Search members</button>
    {memberQ&&!disabled&&<> <a href={link({segment,q})}>Clear member search</a></>}
  </form>;
}

function ContactsTable({page,label,selection,onSelect,disabled}: {
  page:PortableSegmentMembers;label:string;selection?:string[];onSelect?:(id:string)=>void;disabled:boolean;
}){
  if(!page.items.length)return <p>No contacts on this page.</p>;
  return <div className="portable-contacts-table"><table aria-label={label}>
    <thead><tr>{selection&&<th scope="col">Select</th>}<th scope="col">Contact</th><th scope="col">Email</th><th scope="col">Lifecycle stage</th></tr></thead>
    <tbody>{page.items.map(contact=><tr key={contact.id}>
      {selection&&<td><input type="checkbox" aria-label={'Select '+contact.name} checked={selection.includes(contact.id)}
        disabled={disabled} onChange={()=>onSelect?.(contact.id)}/></td>}
      <th scope="row"><a href={'/?contact='+contact.id}>{contact.name}</a></th>
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
        setError(result.error??'Could not update segment membership.');
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
      <ContactsTable page={members} label="Segment members" selection={selected} onSelect={toggle} disabled={locked}/>
      {!locked&&(after||members.next)&&<nav aria-label="Member pages">
        {after&&<a href={link({segment:segment.id,q,memberQ})}>First members</a>}
        {members.next&&<a href={link({segment:segment.id,q,memberQ,after:members.next})}>Next members</a>}
      </nav>}
    </>}
  </>;
}

export function PortableSegments({email,list,members,q,memberQ,after}:{
  email:string;list:PortableSegmentList;members?:PortableSegmentMembers;q?:string;memberQ?:string;after?:string;
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
  const ruleValue=(field:Rule['field'])=>segment?.criteria.groups[0]?.find(rule=>rule.field===field)?.value??'';

  async function send(input:PortableSegmentWrite){
    if(busy)return;
    setBusy(true);
    setError('');
    try{
      const response=await fetch('/api/segments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      const result=await response.json() as {segment?:PortableSegment;ok?:true;error?:string};
      if(!response.ok){
        setError(result.error??'Could not finish this segment request.');
        return;
      }
      return result;
    }catch{
      setError('Could not confirm the change. Reload to check the saved segment.');
    }finally{setBusy(false);}
  }

  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(membershipPending)return;
    const data=new FormData(event.currentTarget);
    const name=String(data.get('name')??'').trim();
    const description=String(data.get('description')??'').trim();
    const lifecycle=String(data.get('lifecycle')??'') as typeof lifecycles[number]|'';
    const group:Rule[]=[];
    if(lifecycle)group.push({field:'lifecycle',operator:'eq',value:lifecycle,valueTo:''});
    for(const field of ['name','email'] as const){
      const value=String(data.get(field+'Contains')??'').trim();
      if(value)group.push({field,operator:'contains',value,valueTo:''});
    }
    const id=segment?.id??(createId.current??=crypto.randomUUID());
    const result=await send({action:'save',segment:{id,revision:segment?.revision??0,name,description,kind:'contacts',mode,
      criteria:{groups:group.length?[group]:[]},...(!segment&&mode==='static'?{initialMembers}:{})}});
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
    <section aria-labelledby="portable-segments-title">
      <div className="portable-contacts-heading"><h1 id="portable-segments-title">Segments</h1><a href={link({q})}>New segment</a></div>
      <form action="/" method="get" aria-label="Find segments">
        <input type="hidden" name="view" value="segments"/>
        <label>Search segments<input name="q" type="search" maxLength={recordSearchLimit} defaultValue={q}/></label>
        <button type="submit">Search</button>{' '}<a href={link()}>Clear search</a>
      </form>
      {list.segments.length?<div className="portable-contacts-table"><table aria-label="Saved segments">
        <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead>
        <tbody>{list.segments.map(item=><tr key={item.id}>
          <th scope="row"><a href={link({segment:item.id,q})} aria-current={item.id===segment?.id?'page':undefined}>{item.name}</a></th>
          <td>{item.mode==='static'?'Static':'Active'}</td><td>{item.description||'—'}</td>
        </tr>)}</tbody>
      </table></div>:<p>No saved segments match this view.</p>}
      {(!segment&&after||list.next)&&<nav aria-label="Segment pages">
        {!segment&&after&&<a href={link({q})}>First segments</a>}
        {list.next&&<a href={link({q,after:list.next})}>Next segments</a>}
      </nav>}
    </section>
    <section aria-labelledby="portable-segment-editor">
      <h2 id="portable-segment-editor">{segment?'Edit '+segment.name:'Create a Contact segment'}</h2>
      {mode==='active'&&<p>Members are contacts that meet every selected filter. Leave the filters empty to include all contacts.</p>}
      {mode==='static'&&<p>Static segments hold a list of contacts you manage. They do not trigger automatic workflow enrollment.</p>}
      {error&&<p role="alert">{error}</p>}
      <form onSubmit={save} aria-label="Segment settings">
        <fieldset disabled={busy||membershipPending}>
          {segment?<p>Type: {mode==='static'?'Static':'Active'}</p>:<label>Segment type<select value={newMode}
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
        {showFilters&&<fieldset disabled={busy||membershipPending}>
          <label>Lifecycle stage<select name="lifecycle" defaultValue={ruleValue('lifecycle')}>
            <option value="">Any stage</option>
            {lifecycles.map(stage=><option key={stage}>{stage}</option>)}
          </select></label>
          <label>Name contains<input name="nameContains" defaultValue={ruleValue('name')} maxLength={recordSearchLimit}/></label>
          <label>Email contains<input name="emailContains" defaultValue={ruleValue('email')} maxLength={recordSearchLimit}/></label>
        </fieldset>}
        <button type="submit" disabled={busy||membershipPending}>{busy?'Saving…':'Save segment'}</button>{' '}
        {segment&&<button type="button" disabled={busy||membershipPending} onClick={()=>void remove()}>Delete segment</button>}
      </form>
    </section>
    {members&&<section aria-labelledby="portable-segment-members">
      <h2 id="portable-segment-members">{(memberQ?'Matching members':'Members')+' · '+format.format(members.total as `${number}`)}</h2>
      {mode==='static'?<StaticMembership key={JSON.stringify([members.segment.id,memberQ,after])} members={members} q={q} memberQ={memberQ} after={after} editing={busy}
        onPending={setMembershipPending}/>:<>
        <p>Membership reflects the current saved filters and contact properties.</p>
        <MemberSearch segment={members.segment.id} q={q} memberQ={memberQ} disabled={busy}/>
        <ContactsTable page={members} label="Segment members" disabled={busy}/>
        {(after||members.next)&&<nav aria-label="Member pages">
          {after&&<a href={link({segment:members.segment.id,q,memberQ})}>First members</a>}
          {members.next&&<a href={link({segment:members.segment.id,q,memberQ,after:members.next})}>Next members</a>}
        </nav>}
      </>}
    </section>}
  </main>;
}
