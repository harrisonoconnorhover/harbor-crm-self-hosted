'use client';
import {useEffect,useState} from 'react';
import {emailRequest} from './email-templates';
import {suppressedAddress,type EmailSuppressionPage} from '@/lib/email/suppression';

export function EmailSuppressionSettings({portable=false}:{portable?:boolean}={}){
 const [loaded,setLoaded]=useState<{key:string;page?:EmailSuppressionPage;error?:string}|null>(null),[email,setEmail]=useState(''),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[after,setAfter]=useState(''),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const loadKey=JSON.stringify([search,after,revision]),page=loaded?.key===loadKey?loaded.page:null,displayError=error||(loaded?.key===loadKey?loaded.error:'');
 useEffect(()=>{let active=true;emailRequest<EmailSuppressionPage>('/api/email/suppressions?'+new URLSearchParams({query:search,after})).then(value=>{if(active)setLoaded({key:loadKey,page:value});}).catch(e=>{if(active)setLoaded({key:loadKey,error:e.message});});return()=>{active=false;};},[search,after,loadKey]);
 async function change(id?:string){
  setBusy(true);setError('');setNotice('');
  try{
   if(id)await emailRequest('/api/email/suppressions','DELETE',{id});
   else {const parsed=suppressedAddress.safeParse(email);if(!parsed.success)throw Error('Enter a valid email address.');await emailRequest('/api/email/suppressions','POST',{id:crypto.randomUUID(),email:parsed.data});}
   setEmail('');setAfter('');setRevision(n=>n+1);
   setNotice(portable?id?'Manual block removed.':'Address added to the do-not-email list.':id?'Block removed. Saved emails and sequences are unchanged; review them before retrying.':'Address blocked for future sends. A message already submitted to Gmail may still arrive.');
  }catch(e){setError(e instanceof Error?e.message:'The block could not be saved.');}finally{setBusy(false);}
 }
 return <section className="panel tool-body" aria-label="Do not email">
  <h2>Do not email</h2>
  {portable?<p>Manage addresses that should not receive email from this workspace. You can remove a manual block. An address stays blocked if the recipient unsubscribed.</p>:<>
   <p>Block an exact email address across this workspace’s Harbor sends, including replies, forwards, scheduled emails and sequence emails. A match in To, Cc or Bcc blocks the whole message.</p>
  <p className="muted">Blocks survive contact edits or deletion. Other workspaces, messages sent outside Harbor and Calendar invitations are unaffected. This does not remove past emails or stop a send already submitted to Gmail. Sequence emails sent from the independent Harbor installation include a recipient unsubscribe link. Confirmed recipient opt-outs stay blocked.</p>
  </>}
  {displayError&&<p role="alert">{displayError}</p>}{notice&&<p role="status">{notice}</p>}
  <form onSubmit={e=>{e.preventDefault();void change();}}><label className="form-field">Email address to block<input type="email" aria-label="Email address to block" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} disabled={busy} placeholder="person@example.com"/></label><button className="secondary" disabled={busy||!email.trim()}>{busy?'Saving…':'Block email address'}</button></form>
  <form className="tool-actions" onSubmit={e=>{e.preventDefault();setSearch(query.trim());setAfter('');setRevision(n=>n+1);}}><label className="form-field">Search blocked addresses<input aria-label="Search blocked addresses" maxLength={254} value={query} onChange={e=>setQuery(e.target.value)}/></label><button className="secondary" disabled={busy}>Search blocks</button><button type="button" className="text-button" disabled={busy} onClick={()=>setRevision(n=>n+1)}>Reload blocks</button></form>
  {page?<><p>{page.total} matching blocked {page.total===1?'address':'addresses'}</p>{page.results.length?<ul>{page.results.map(row=><li key={row.id}>{row.email} {row.recipientOptedOutAt?<span className="muted">Recipient unsubscribed</span>:<button className="text-button" disabled={busy} aria-label={'Remove block for '+row.email} onClick={()=>void change(row.id)}>Remove block</button>}</li>)}</ul>:<p>No matching blocked addresses.</p>}<div className="tool-actions"><button className="secondary" disabled={busy||!after} onClick={()=>setAfter('')}>First addresses</button><button className="secondary" disabled={busy||!page.next} onClick={()=>setAfter(page.next!)}>Next addresses</button></div></>:!displayError&&<p>Loading blocked addresses…</p>}
 </section>;
}
