'use client';
/* eslint-disable @next/next/no-html-link-for-pages -- Portable CRM uses document navigation for its paged lists. */

import {useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {PublicLeadForm} from '../app/forms/public-lead-form';
import {LeadFormBackendSetup} from '../app/forms/lead-form-backend-setup';
import type {listLeadForms,readLeadInquiries} from '../db/postgres/lead-form-store';
import {LEAD_FORM_DAILY_LIMIT,LEAD_FORM_HOURLY_LIMIT} from '../lib/lead-forms';
import {formNoteCapacityIssue,type PortableInquiryFilter} from '../lib/portable-lead-forms';
import {recordSearchLimit} from '../lib/portable-records';
import {leadFormEmbedHtml} from '../lib/lead-form-embedding';
import {jobDetailsHref} from '../lib/portable-job-labels';
import './portable-contacts.css';
import {PortableCrmHeader} from './portable-crm-header';

type Form=Awaited<ReturnType<typeof listLeadForms>>[number];
type Page=Awaited<ReturnType<typeof readLeadInquiries>>;
const definition={title:'Contact us',description:'',thankYou:'Thank you. Your inquiry has been received.'};
const noteStatuses={
  awaiting_contact:'Waiting for a Contact match',waiting:'Waiting for the worker',queued:'Queued',
  succeeded:'Added to the Contact',skipped:'Skipped',failed:'Could not add Note',
};

const reviewReasons={
  duplicate_email:'More than one Contact has this email. Resolve the duplicates in Contacts, then retry matching.',
  archived_contact:'A matching Contact is in the Recycle Bin. Restore it, then retry matching.',
};

const received=(at:number)=>new Date(at).toISOString().slice(0,16).replace('T',' ')+' UTC';

function CaptureSettings({selected}:{selected?:Form}){
  const saved=selected?.definition;
  const [capture,setCapture]=useState(!!saved&&saved.captureContacts!==false);
  const [queueNote,setQueueNote]=useState(capture&&saved?.queueWorkflows===true&&!!saved.automationNote);
  return <div className="portable-form-settings">
    <div>
      <label><input name="captureContacts" type="checkbox" checked={capture} onChange={event=>{
        setCapture(event.target.checked);
        if(!event.target.checked)setQueueNote(false);
      }}/>
        Automatically create or link contacts
      </label>
      <small>Leave unchecked to keep new submissions in the inquiry inbox until you choose to capture them.</small>
    </div>
    <div>
      <label><input name="showMessageOnContact" type="checkbox" defaultChecked={saved?.showMessageOnContact===true}/>
        Show captured inquiry messages on the Contact timeline
      </label>
      <small>People with access to this Contact’s logged activities can read the message. Remove the inquiry to remove it from the timeline.</small>
    </div>
    <div>
      <label><input name="queueWorkflows" type="checkbox" checked={queueNote} disabled={!capture}
        onChange={event=>setQueueNote(event.target.checked)} aria-describedby="portable-form-note-help"/>
        Queue one internal Note after Contact matching
      </label>
      <small id="portable-form-note-help">Requires automatic Contact capture. Harbor queues the fixed Note once a Contact is created or matched.
        Inquiry messages stay in the inbox unless timeline sharing is enabled above. Editing or disabling this form skips its pending Notes.</small>
    </div>
    {queueNote&&<label className="portable-form-text">Internal Note text<textarea name="automationNote" required maxLength={2000}
      defaultValue={saved?.automationNote}/></label>}
  </div>;
}

export function PortableLeadForms({email,publicOrigin,forms,openOnly,workspaceInbox,selected,page,filter,inquirySearch}:{
  email:string;publicOrigin:string;forms:Form[];openOnly:boolean;workspaceInbox:boolean;selected?:Form;page?:Page;
  filter:PortableInquiryFilter;inquirySearch?:string;
}){
  const router=useRouter();
  const draftId=useRef<string|null>(null);
  const busyRef=useRef(false);
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState<{message:string;contactId?:string}>();
  const [error,setError]=useState('');
  const link=(id?:string,cursor?:Page['next'],inquiryFilter:PortableInquiryFilter='all',onlyOpen=openOnly,inbox=false,search?:string)=>{
    const params=new URLSearchParams({view:'forms'});
    if(id)params.set('formId',id);
    if(inbox)params.set('inquiries','workspace');
    if(inbox||inquiryFilter!=='all')params.set('filter',inquiryFilter);
    if(onlyOpen&&!inbox)params.set('followUp','open');
    if(search)params.set('inquirySearch',search);
    if(cursor){params.set('afterAt',String(cursor.at));params.set('afterId',cursor.id);}
    return '/?'+params;
  };
  const inquiryLink=(value:PortableInquiryFilter,cursor?:Page['next'],search=inquirySearch)=>
    link(selected?.id,cursor,value,openOnly,workspaceInbox,search);

  async function action(data:unknown,message:string,opened?:string){
    if(busyRef.current)return;
    busyRef.current=true;
    setBusy(true);
    setError('');
    setStatus(undefined);
    try{
      const response=await fetch('/api/lead-forms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
      if(!response.ok){
        const result=await response.json() as {error?:string};
        setError(result.error||'Could not update this form.');
        return;
      }
      const result=await response.json() as {capturedContact?:{id:string;status:'created'|'linked'}};
      const contact=result.capturedContact;
      setStatus(contact?{message:contact.status==='created'?'Contact created.':'Linked existing Contact.',contactId:contact.id}:{message});
      if(opened)router.push(link(opened));
      else router.refresh();
    }catch{setError('Could not confirm the update. Reload to check before trying again.');}
    finally{busyRef.current=false;setBusy(false);}
  }

  function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const {captureContacts,showMessageOnContact,queueWorkflows,automationNote,...fields}=Object.fromEntries(new FormData(event.currentTarget));
    const capture=captureContacts==='on';
    const queueNote=capture&&queueWorkflows==='on';
    const note=typeof automationNote==='string'?automationNote.trim():'';
    if(queueNote&&!note){setError('Enter text for the internal Note.');return;}
    const id=selected?.id??(draftId.current??=crypto.randomUUID());
    void action({action:'save',id,revision:selected?.revision??0,definition:{...fields,captureContacts:capture,showMessageOnContact:showMessageOnContact==='on',
      queueWorkflows:queueNote,...(queueNote?{automationNote:note}:{})}},
      'Form saved.',selected?undefined:id);
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="forms" formsHref={link()}/>
    <section>
      <h1>Forms</h1>
      <p>Collect unverified website inquiries. New forms start Off. Each workspace accepts up to {LEAD_FORM_DAILY_LIMIT} inquiries per UTC day and each form accepts up to {LEAD_FORM_HOURLY_LIMIT} in a rolling hour.</p>
      <a href={link()}>Create form</a>
      <nav aria-label="Form views">
        <a href={link(selected?.id,undefined,selected?filter:'all',false,false,selected?inquirySearch:undefined)}
          aria-current={!openOnly&&!workspaceInbox?'page':undefined}>All forms</a>
        <a href={link(selected?.id,undefined,selected?filter:'all',true,false,selected?inquirySearch:undefined)}
          aria-current={openOnly?'page':undefined}>Needs follow-up</a>
        <a href={link(undefined,undefined,'open',false,true)} aria-current={workspaceInbox?'page':undefined}>Workspace inquiries</a>
      </nav>
      {openOnly&&!forms.length&&<p>No forms with open inquiries.</p>}
      {forms.length>0&&<ul>{forms.map(form=><li key={form.id}>
        <a href={link(form.id)} aria-current={selected?.id===form.id?'page':undefined}>{form.definition.title}</a> · {form.enabled?'On':'Off'}
        {form.hasOpenInquiries&&<> · <a href={link(form.id,undefined,'open')+'#form-inquiries'}
          aria-label={'Open inquiries · '+form.definition.title}>Open inquiries</a></>}
        {form.hasUnmatchedInquiries&&<> · <a href={link(form.id,undefined,'unmatched')+'#form-inquiries'}
          aria-label={'Needs contact matching · '+form.definition.title}>Needs contact matching</a></>}
      </li>)}</ul>}
      {error&&<p role="alert">{error}</p>}
      {status&&!status.contactId&&<p role="status">{status.message}</p>}
      {!workspaceInbox&&<><h2>{selected?'Edit form':'New form'}</h2>
      <form className="portable-form-editor" key={selected?.id??'new'} onSubmit={save}>
        <fieldset disabled={busy}>
          <label>Title<input name="title" required maxLength={100} defaultValue={selected?.definition.title??definition.title}/></label>
          <label className="portable-form-text">Introduction<textarea name="description" maxLength={1000} defaultValue={selected?.definition.description??definition.description}/></label>
          <label className="portable-form-text">Confirmation message<textarea name="thankYou" required maxLength={500} defaultValue={selected?.definition.thankYou??definition.thankYou}/></label>
          <label>Website origin for embedding (optional)<input name="embedOrigin" type="url" maxLength={254}
            placeholder="https://www.example.com" defaultValue={selected?.definition.embedOrigin??''}/></label>
          <CaptureSettings key={selected?.revision??0} selected={selected}/>
        </fieldset>
        <button type="submit" disabled={busy}>Save form</button>
      </form></>}
      {selected&&<>
        <p>{selected.enabled?'On · accepting inquiries':'Off · private draft'}</p>
        <button type="button" disabled={busy} onClick={()=>void action({action:'setEnabled',id:selected.id,revision:selected.revision,
          enabled:!selected.enabled},selected.enabled?'Public form disabled.':'Public form enabled.')}>
          {selected.enabled?'Disable public form':'Enable public form'}
        </button>
        {selected.enabled&&<p><a href={'/forms/'+selected.id}>Open public form</a></p>}
        {selected.enabled&&selected.definition.embedOrigin&&<details>
          <summary>Embed on your website</summary>
          <p>Copy this HTML into a page on {selected.definition.embedOrigin}.</p>
          <label>Embed HTML<textarea readOnly rows={4} onFocus={event=>event.currentTarget.select()} value={leadFormEmbedHtml(publicOrigin+'/forms/'+selected.id)}/></label>
        </details>}
        {selected.definition.captureContacts===false&&
          <LeadFormBackendSetup formId={selected.id} origin={publicOrigin} enabled={selected.enabled} apiAccessHref="/?view=api-access"/>}
        <details><summary>Preview saved form</summary><PublicLeadForm key={selected.revision} form={selected} preview/></details>
      </>}
      {(selected||workspaceInbox)&&<>
        <h2 id="form-inquiries">{workspaceInbox?'Workspace inquiries':'Inquiries'}</h2>
        <p>Contact capture links an exact email match without changing it, or creates a contact for a new address. Multiple matches and archived matches may need review.</p>
        <nav className="portable-inquiry-filters" aria-label="Filter inquiries">
          <a href={inquiryLink('all')} aria-current={filter==='all'?'page':undefined}>All inquiries</a>
          <a href={inquiryLink('open')} aria-current={filter==='open'?'page':undefined}>Open</a>
          <a href={inquiryLink('overdue')} aria-current={filter==='overdue'?'page':undefined}>Overdue follow-up</a>
          <a href={inquiryLink('handled')} aria-current={filter==='handled'?'page':undefined}>Handled</a>
          <a href={inquiryLink('unmatched')} aria-current={filter==='unmatched'?'page':undefined}>Needs contact matching</a>
          <a href={inquiryLink('needs_review')} aria-current={filter==='needs_review'?'page':undefined}>Needs review</a>
          <a href={inquiryLink('note_issues')} aria-current={filter==='note_issues'?'page':undefined}>Note issues</a>
        </nav>
        <form method="get" action="/">
          <input type="hidden" name="view" value="forms"/>
          {selected&&<input type="hidden" name="formId" value={selected.id}/>}
          {workspaceInbox&&<input type="hidden" name="inquiries" value="workspace"/>}
          {(workspaceInbox||filter!=='all')&&<input type="hidden" name="filter" value={filter}/>}
          {openOnly&&<input type="hidden" name="followUp" value="open"/>}
          <label>Search inquiries by name or email <input type="search" name="inquirySearch" maxLength={recordSearchLimit}
            key={inquirySearch??''} defaultValue={inquirySearch??''}/></label>
          <button type="submit">Search inquiries</button>
          {inquirySearch&&<a href={inquiryLink(filter,undefined,'')}>Clear search</a>}
        </form>
        <button type="button" disabled={busy} onClick={()=>router.refresh()}>Refresh inquiries</button>
        {status?.contactId&&<p role="status">{status.message}{' '}
          <a href={'/?contact='+status.contactId}>Open contact</a>
        </p>}
        {filter==='overdue'&&<p>Open inquiries received at least 24 hours ago.</p>}
        {filter==='note_issues'&&<p>See overdue Notes, expired worker claims and unreviewed failures. <a href="/?view=job-queue">Open the Job queue</a> for details.</p>}
        {!page?.results.length&&<p>{inquirySearch?'No matching inquiries on this page.':filter==='note_issues'?'No Note issues on this page.':
          filter==='overdue'?'No overdue inquiries on this page.':
          filter==='unmatched'?'No inquiries need contact matching on this page.':
          filter==='needs_review'?'No inquiries need review on this page.':'No inquiries on this page.'}</p>}
        {page?.results.map(inquiry=><article key={inquiry.id}>
          {inquiry.payload?<><h3>{inquiry.payload.name}</h3>
            <p>{inquiry.payload.email}{inquiry.payload.phone?' · '+inquiry.payload.phone:''} · {received(inquiry.receivedAt)}
              {workspaceInbox&&<> · <a href={link(inquiry.formId)}>{inquiry.formTitle}</a></>}</p>
            <p style={{whiteSpace:'pre-wrap'}}>{inquiry.payload.message}</p>
            <p>{inquiry.handled?'Handled':'Open'} · {inquiry.status==='created'?'Created contact':inquiry.status==='linked'?'Linked contact':inquiry.status==='inbox_only'?'Inbox only':'Needs review'}</p>
            {inquiry.status==='needs_review'&&<p>{inquiry.reviewReason&&reviewReasons[inquiry.reviewReason]||
              'Retry contact matching to check this inquiry again.'}</p>}
            {inquiry.contactId&&(inquiry.contactAvailable
              ?<a href={'/?contact='+inquiry.contactId}>Open contact</a>
              :<p>Linked Contact unavailable. If it is in the <a href="/?view=recycle-bin">Recycle Bin</a>, restore it to reopen it here.</p>)}{' '}
            {(inquiry.status==='needs_review'||inquiry.status==='inbox_only')&&<button type="button" disabled={busy} onClick={()=>void action({
              action:'retry',formId:inquiry.formId,submissionId:inquiry.id,
            },'Matching checked.')}>{inquiry.status==='inbox_only'?'Create or link contact':'Retry contact matching'}</button>}{' '}
            <button type="button" disabled={busy} onClick={()=>void action({
              action:'setInquiryHandled',formId:inquiry.formId,submissionId:inquiry.id,
              handled:!inquiry.handled,triageRevision:inquiry.triageRevision,
            },inquiry.handled?'Inquiry reopened.':'Inquiry marked handled.')}>{inquiry.handled?'Reopen':'Mark handled'}</button>{' '}
            <button type="button" disabled={busy} onClick={()=>{
              if(window.confirm('Remove this inquiry’s saved details? The contact and backup copies are kept.'))
                void action({action:'removeInquiry',formId:inquiry.formId,submissionId:inquiry.id},'Inquiry details removed.');
            }}>Remove inquiry details</button>
          </>:<p>Inquiry details removed · received {received(inquiry.receivedAt)}</p>}
          {'noteAutomation' in inquiry&&inquiry.noteAutomation&&<p>Internal Note · {
            inquiry.noteAutomation.issue===formNoteCapacityIssue
              ?'Note skipped because the workspace has too many pending form Notes.'+
                (inquiry.handled?'':' Add a Note manually if needed, then mark this inquiry handled.')
              :inquiry.noteAutomation.claimExpired?'Worker claim expired':inquiry.noteAutomation.overdue?'Waiting longer than expected':noteStatuses[inquiry.noteAutomation.status]
          }{inquiry.noteAutomation.attentionJobId&&<> · <a href={jobDetailsHref(inquiry.noteAutomation.attentionJobId)}>Open Note job</a></>}</p>}
        </article>)}
        <nav aria-label="Inquiry pages">
          <a href={inquiryLink(filter)}>Latest inquiries</a>
          {page?.next&&<a href={inquiryLink(filter,page.next)}>Older inquiries</a>}
        </nav>
      </>}
    </section>
  </main>;
}
