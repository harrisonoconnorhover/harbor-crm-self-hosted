'use client';

import {useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {portableRecycleBinLink} from './portable-contact-recycle-ui';
import {InvoiceAction,InvoiceDocument,InvoiceEditor} from '../app/invoices';
import {formatCents} from '../lib/commerce';
import {invoiceBalance,invoiceLabel,invoiceStatus,invoiceStatusLabels,paymentLabels,type InvoiceData,type InvoicePayment} from '../lib/invoices';
import type {PortableInvoiceDetail,PortableInvoicePreview,PortableInvoiceSourceQuery} from '../lib/portable-invoices';

const page='/?view=invoices',endpoint='/api/invoices';
async function request<T>(path:string,body?:unknown){
  const response=await fetch(path,{cache:'no-store',...(body?{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  }:{})});
  const result=await response.json() as T&{error?:string};
  if(!response.ok)throw Error(result.error??'Could not finish the invoice request.');
  return result;
}

export function PortableInvoiceExportButton({href}:{href:string}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function download(){
    setBusy(true);setError('');
    try{
      const response=await fetch(href,{cache:'no-store'});
      if(!response.ok){
        const result=await response.json().catch(()=>null) as {error?:string}|null;
        throw Error(result?.error??'Could not export invoices.');
      }
      if(!response.headers.get('content-type')?.startsWith('text/csv'))throw Error('Expected an invoice CSV.');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url;
      link.download='harbor-invoices.csv';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }
  return <><button type="button" onClick={()=>void download()} disabled={busy}>{busy?'Preparing CSV…':'Export CSV'}</button>
    {error&&<p role="alert">{error}</p>}</>;
}

export function PortableInvoiceCreate({source,sourceId}:Pick<PortableInvoiceSourceQuery,'source'|'sourceId'>){
  const router=useRouter();
  const [recurring,setRecurring]=useState<PortableInvoiceSourceQuery['recurring']>('exclude');
  const [review,setReview]=useState<{id:string;preview:PortableInvoicePreview}>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function perform(){
    setBusy(true);setError('');
    try{
      if(!review){
        const query=new URLSearchParams({source,sourceId,recurring});
        const preview=await request<PortableInvoicePreview>(endpoint+'?'+query);
        setReview({id:crypto.randomUUID(),preview});
        return;
      }
      const result=await request<{id:string}>(endpoint,{action:'create',id:review.id,source:review.preview.source,recurring});
      router.push(page+'&invoiceId='+result.id);
    }catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }
  return <section aria-label="Invoice drafts">
    <h2>Invoice drafts</h2>
    <label>Recurring source charges
      <select value={recurring} disabled={busy||!!review} onChange={event=>setRecurring(
        event.target.value==='one_payment'?'one_payment':'exclude')}>
        <option value="exclude">Copy one-time charges only</option>
        <option value="one_payment">Include one payment of each recurring item</option>
      </select>
    </label>
    {review&&<div>
      <p>{review.preview.sourceNote} Draft total <strong>{formatCents(review.preview.totalCents)} USD</strong></p>
      <ul>{review.preview.data.items.map(item=><li key={item.id}>{item.name} · {item.quantity} × {formatCents(item.unitPriceCents)}</li>)}</ul>
      <button type="button" disabled={busy} onClick={()=>{setReview(undefined);setError('');}}>Refresh source</button>{' '}
    </div>}
    <button type="button" disabled={busy} onClick={()=>void perform()}>{review?'Create invoice draft':'Review invoice draft'}</button>{' '}
    <Link href={page+'&'+(source==='deal'?'dealId':'quoteId')+'='+sourceId}>View invoices</Link>
    {error&&<p role="alert">{error}</p>}
  </section>;
}

export function PortableInvoiceDetailView({detail,dealArchived,before,paymentsBefore}:{detail:PortableInvoiceDetail;dealArchived:boolean;
  before?:number;paymentsBefore?:number}){
  const router=useRouter();
  const [editing,setEditing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [action,setAction]=useState<'payment'|'unapply'|'void'>();
  const [selectedPayment,setSelectedPayment]=useState<InvoicePayment|null>(null);
  const {invoice,history,payments}=detail;
  const balance=invoiceBalance(invoice);
  const draft=invoice.status==='draft';
  const current=(historyCursor?:number,paymentCursor?:number)=>page+'&'+new URLSearchParams({
    invoiceId:invoice.id,...(historyCursor?{before:String(historyCursor)}:{}),
    ...(paymentCursor?{paymentsBefore:String(paymentCursor)}:{}),
  });
  async function save(data:InvoiceData){
    setBusy(true);
    try{
      await request(endpoint,{action:'save',id:invoice.id,revision:invoice.revision,data});
      setEditing(false);
      router.refresh();
    }finally{setBusy(false);}
  }
  async function finalize(){
    if(!confirm('Finalize this invoice to assign a number and freeze the charges and terms?'))return;
    setBusy(true);setError('');
    try{
      await request(endpoint,{action:'finalize',id:invoice.id,revision:invoice.revision});
      router.refresh();
    }catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }
  function closeAction(){
    setAction(undefined);setSelectedPayment(null);
  }
  async function recordAction(fields:Record<string,unknown>){
    if(!action)return;
    setBusy(true);
    try{
      await request(endpoint,{...fields,action,id:invoice.id,revision:invoice.revision});
      closeAction();
      router.refresh();
    }finally{setBusy(false);}
  }
  return <section className="commerce-page quote-page">
    <Link href={page}>Back to invoices</Link>{' '}
    {invoice.dealId&&<Link href={dealArchived?portableRecycleBinLink('deals'):'/?kind=deals&record='+invoice.dealId}>
      {invoice.dealName}{dealArchived?' (archived)':''}
    </Link>}{' '}
    {invoice.quoteId&&<Link href={'/quotes?id='+invoice.quoteId+'&version='+invoice.quoteVersion}>Source quote version {invoice.quoteVersion}</Link>}
    <div className="portable-contacts-heading">
      <h2>{invoice.data.title}</h2>
      {draft?<>
        <button type="button" disabled={busy} onClick={()=>setEditing(true)}>Edit draft</button>
        <button type="button" disabled={busy} onClick={()=>void finalize()}>Finalize invoice</button>
      </>:invoice.snapshot&&<a href={endpoint+'?id='+invoice.id+'&download=true'}>Download HTML</a>}
      {invoice.status!=='void'&&invoice.paidCents===0&&
        <button type="button" disabled={busy} onClick={()=>setAction('void')}>Void invoice</button>}
    </div>
    {!draft&&<p>{invoiceLabel(invoice)} · {invoiceStatusLabels[invoiceStatus(invoice)]}</p>}
    {invoice.voidReason&&<p>Void reason · {invoice.voidReason}</p>}
    <p>{invoice.sourceNote}</p>
    {error&&<p role="alert">{error}</p>}
    <InvoiceDocument invoice={invoice} privateOnly/>
    {invoice.finalizedAt&&<section aria-label="Offline payments">
      <h3>Offline payments</h3>
      <p>Record money already received outside Harbor.</p>
      <p>Recorded {formatCents(invoice.paidCents)} USD · Balance {formatCents(balance)} USD</p>
      {invoice.status==='open'&&balance>0&&<button type="button" disabled={busy} onClick={()=>setAction('payment')}>Record offline payment</button>}
      {payments.length?<ul>{payments.map(payment=><li key={payment.id}>
        <strong>{formatCents(payment.amountCents)} USD</strong> · {payment.receivedOn} · {paymentLabels[payment.method]}
        {payment.reference&&<p>Reference {payment.reference}</p>}
        {payment.note&&<p>{payment.note}</p>}
        {payment.unappliedAt?<p>Unapplied · {payment.unapplyReason}</p>:
          invoice.status==='open'&&<button type="button" disabled={busy} onClick={()=>{setSelectedPayment(payment);setAction('unapply');}}>
            Unapply payment
          </button>}
      </li>)}</ul>:<p>No offline payments recorded on this page.</p>}
      {paymentsBefore&&<Link href={current(before)}>Latest payments</Link>}{' '}
      {detail.nextPayment&&<Link href={current(before,detail.nextPayment)}>Older payments</Link>}
    </section>}
    <h3>Invoice history</h3>
    <ol>{history.map(item=><li key={item.revision}>{{create:'Created',save:'Saved',finalize:'Finalized',payment:'Payment recorded',unapply:'Payment unapplied',void:'Voided'}[item.action]} · {item.actorName??'Workspace owner'} ·{' '}
      <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>{item.note&&<p>{item.note}</p>}</li>)}</ol>
    {before&&<Link href={current(undefined,paymentsBefore)}>Latest changes</Link>}{' '}
    {detail.next&&<Link href={current(detail.next,paymentsBefore)}>Older changes</Link>}
    {action&&<InvoiceAction action={action} invoice={invoice} payment={selectedPayment} busy={busy}
      onClose={closeAction} onSubmit={recordAction}/>}
    {editing&&draft&&<InvoiceEditor invoice={invoice} draftOnly busy={busy} onClose={()=>setEditing(false)} onSave={save}/>}
  </section>;
}
