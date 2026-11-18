'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {leadFormPayload,leadFormSubmit,supersededLeadFormCode,type LeadForm} from '@/lib/lead-forms';
import {CONTACT_NAME_MAX} from '@/lib/crm';
import './lead-forms.css';
const rejectedBeforeSaving=new Set([400,403,404,409,413,429]);
const attemptIdentity=leadFormSubmit.pick({id:true,revision:true});

export function PublicLeadForm({form,preview=false,newTabPrivacy=false,approvedEmbedOrigin}:{form:Omit<Pick<LeadForm,'id'|'revision'|'definition'>,'definition'>&{definition:Pick<LeadForm['definition'],'title'|'description'|'thankYou'>};preview?:boolean;newTabPrivacy?:boolean;approvedEmbedOrigin?:string}){
 const router=useRouter();
 const [name,setName]=useState(''),[email,setEmail]=useState(''),[phone,setPhone]=useState(''),[message,setMessage]=useState(''),[website,setWebsite]=useState('');
 const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[reenter,setReenter]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('');
 const [ready,setReady]=useState(false);
 const [superseded,setSuperseded]=useState<{revision:number;reviewRequested:boolean}|null>(null);
 const [refreshing,startRefresh]=useTransition();
 const [initialEmbedOrigin]=useState(approvedEmbedOrigin);
 const [framed,setFramed]=useState<boolean|null>(null);
 // Refresh merges the new form props without replacing the document or its CSP.
 const framePolicyChanged=framed!==false&&approvedEmbedOrigin!==initialEmbedOrigin;
 const formChanged=superseded!==null&&(!superseded.reviewRequested||form.revision<=superseded.revision);
 const submitting=useRef(false);
 const attempt=useRef<{id:string;revision:number}|null>(null);
 const pending=useRef<{submission:ReturnType<typeof leadFormSubmit.parse>;reentered:boolean}|null>(null);
 const storageKey='harbor:lead-inquiry:'+form.id;
 useEffect(()=>{
  if(preview)return;
  let active=true;
  queueMicrotask(()=>{
   if(!active)return;
   setFramed(window.self!==window.top);
   if(!attempt.current){
    try{
     const saved=attemptIdentity.safeParse(JSON.parse(sessionStorage.getItem(storageKey)??'null'));
     if(saved.success){attempt.current=saved.data;setUncertain(true);setReenter(true);}
    }catch{/* An unavailable or invalid browser store leaves in-page retries usable. */}
   }
   setReady(true);
  });
  return ()=>{active=false;};
 },[preview,storageKey]);
 useEffect(()=>{
  if(preview||done||(!busy&&!uncertain))return;
  const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',warn);
  return ()=>window.removeEventListener('beforeunload',warn);
 },[busy,done,preview,uncertain]);
 function clearAttempt(){
  attempt.current=null;
  pending.current=null;
  try{sessionStorage.removeItem(storageKey);}catch{/* Browser storage may be blocked. */}
 }
 async function submit(){
  if(preview||!ready||formChanged||framePolicyChanged||refreshing||submitting.current)return;
  submitting.current=true;setBusy(true);setError('');
  const retry=attempt.current!==null;
  try{
   if(!pending.current){
    const parsed=leadFormPayload.safeParse({name,email,phone,message});
    if(!parsed.success)throw Error('Enter your name and a valid email address.');
    const identity=attempt.current??{id:crypto.randomUUID(),revision:form.revision};
    attempt.current=identity;
    pending.current={submission:{...identity,payload:parsed.data,website},reentered:retry};
    setReenter(false);
    // Only the retry identity survives reload. Inquiry fields stay in memory.
    try{sessionStorage.setItem(storageKey,JSON.stringify(identity));}catch{/* Browser storage may be blocked. */}
   }
   const {submission,reentered}=pending.current;
   const response=await fetch('/api/public/forms/'+form.id,{method:'POST',credentials:'omit',signal:AbortSignal.timeout(20_000),headers:{'content-type':'application/json'},body:JSON.stringify(submission)}),result=await response.json() as {accepted?:boolean;error?:string;code?:string};
   if(!response.ok){
    if(response.status===409&&result.code===supersededLeadFormCode){
     clearAttempt();setUncertain(false);setReenter(false);setSuperseded({revision:submission.revision,reviewRequested:false});
     return;
    }
    // A rejection on this retry cannot tell us whether the earlier request committed.
    if(!retry&&rejectedBeforeSaving.has(response.status))clearAttempt();
    else if(reentered&&response.status===409){pending.current=null;setReenter(true);}
    throw Error(result.error||'Could not confirm your inquiry.');
   }
   if(result.accepted!==true)throw Error('Could not confirm your inquiry.');
   clearAttempt();
   setDone(true);
  }catch(e){
   setUncertain(attempt.current!==null);
   setError(pending.current?'Your inquiry may already have been received. Retry the same inquiry to check.':e instanceof Error?e.message:'Could not confirm your inquiry.');
  }finally{submitting.current=false;setBusy(false);}
 }
 return <main className="lead-form-page"><section className="lead-form-card">
  <span className="lead-form-brand">⚓ harbor.</span>{preview&&<p className="lead-form-preview">Private preview · submissions disabled</p>}
  <h1>{form.definition.title}</h1>{form.definition.description&&<p>{form.definition.description}</p>}
  {done?<p className="lead-form-success" role="status">{form.definition.thankYou}</p>:<form method="post" onSubmit={event=>{event.preventDefault();void submit();}}>
   {!preview&&<noscript><p>Enable JavaScript in your browser to send this inquiry.</p></noscript>}
   {reenter&&<p role="status">Your earlier inquiry may have been received. Re-enter the same details and retry to check.</p>}
   {superseded&&!formChanged&&!framePolicyChanged&&!refreshing&&<p role="status">The form was updated and your details are still here. Review them before sending.</p>}
   <fieldset disabled={preview||!ready||busy||refreshing||formChanged||framePolicyChanged||(uncertain&&!reenter)}><label>Name<input required name="name" autoComplete="name" value={name} maxLength={CONTACT_NAME_MAX} onChange={e=>setName(e.target.value)}/></label>
   <label>Email address<input required type="email" name="email" autoComplete="email" value={email} maxLength={254} onChange={e=>setEmail(e.target.value)}/></label>
   <label>Phone <span>(optional)</span><input type="tel" name="phone" autoComplete="tel" value={phone} maxLength={60} onChange={e=>setPhone(e.target.value)}/></label>
   <label>Message <span>(optional)</span><textarea name="message" rows={4} value={message} maxLength={4000} onChange={e=>setMessage(e.target.value)}/></label>
   <label className="lead-form-trap" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" value={website} onChange={e=>setWebsite(e.target.value)}/></label></fieldset>
   {error&&<p role="alert">{error}</p>}
   {framePolicyChanged?<><p role="alert">This website’s permission to display the form changed. Reload to apply the new settings.</p>
    <button type="button" onClick={()=>window.location.reload()}>Reload form</button></>:
    formChanged?<><p role="alert">This form changed. Review the updated form before sending.</p>
    <button type="button" disabled={refreshing} onClick={()=>startRefresh(()=>{
     setSuperseded(current=>current&&{...current,reviewRequested:true});
     router.refresh();
    })}>{refreshing?'Loading updated form…':'Review updated form'}</button></>:
    <button type="submit" disabled={preview||!ready||busy||refreshing}>{preview?'Preview only':!ready?'Loading form…':busy?'Submitting…':uncertain?'Retry same inquiry':'Send inquiry'}</button>}
   {uncertain&&<p className="lead-form-detail">If you still cannot confirm it, contact the form operator before starting another inquiry.</p>}
   <p className="lead-form-detail">Your details will be stored by the operator of this form to review your inquiry. Submitting does not subscribe you to marketing email.</p>
  </form>}
  <a href="/privacy" {...(newTabPrivacy?{target:'_blank',rel:'noopener noreferrer'}:{})}>Trial privacy</a>
 </section></main>;
}
