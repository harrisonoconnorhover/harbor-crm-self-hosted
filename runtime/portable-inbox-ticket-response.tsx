'use client';
import {useState} from 'react';
import {PortableRecordPicker} from './portable-record-picker';

export function InboxTicketResponse({replyId,workspaceId,grantId,onSaved}:{
  replyId:string;workspaceId?:string;grantId?:string;onSaved:()=>Promise<void>;
}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [ticket,setTicket]=useState<{id:string;revision?:number}|null>(null);
  if(!open)return <button type="button" onClick={()=>setOpen(true)}>Use as first response</button>;
  const scope=workspaceId&&grantId?'?'+new URLSearchParams({workspaceId,grantId}):'';
  async function save(){
    if(!ticket?.revision||busy||(workspaceId&&!grantId))return;
    setBusy(true);setError('');
    try{
      const r=await fetch('/api/tickets'+scope,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'inbox_first_response',id:ticket.id,expectedRevision:ticket.revision,replyId})});
      if(!r.ok){
        const result=await r.json() as {error?:string};
        throw Error(result.error||'Could not log this reply.');
      }
      await onSaved();setOpen(false);
    }catch(e){setError(e instanceof TypeError?'Could not confirm the change. Refresh the conversation to check.':e instanceof Error?e.message:'Could not log this reply.');}
    finally{setBusy(false);}
  }
  return <form className="inbox-response-ticket" onSubmit={e=>{e.preventDefault();void save();}}>
    <fieldset disabled={busy}><legend>Log first response</legend>
      <PortableRecordPicker kind="tickets" field="ticket" label="Ticket awaiting a first response" value={null}
        emptyLabel="Choose a ticket" workspaceId={workspaceId} unansweredTickets editableOnly onSelect={setTicket}/>
      <p>Uses the time this reply was submitted.</p>
      {error&&<p role="alert">{error}</p>}
      <button disabled={!ticket}>Log first response</button>{' '}
      <button type="button" onClick={()=>{setOpen(false);setTicket(null);setError('');}}>Cancel</button>
    </fieldset>
  </form>;
}
