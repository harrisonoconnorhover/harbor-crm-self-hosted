import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {isPortableDealArchived} from '../db/postgres/portable-deal-archive-store';
import Link from 'next/link';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {listPortableInvoices,readPortableInvoice} from '../db/postgres/portable-invoice-store';
import {invoiceBalance,invoiceLabel,invoiceStatusLabels} from '../lib/invoices';
import {formatCents} from '../lib/commerce';
import {portableInvoiceDetail,portableInvoiceList,portableInvoiceStatuses} from '../lib/portable-invoices';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {PortableInvoiceDetailView,PortableInvoiceExportButton} from './portable-invoices-ui';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

const page='/?view=invoices';
export async function PortableInvoicesPage({invoiceId,...query}:Record<string,string|undefined>){
  delete query.view;
  if(invoiceId===undefined){
    if(query.dueFrom==='')delete query.dueFrom;
    if(query.dueThrough==='')delete query.dueThrough;
  }
  const input=invoiceId!==undefined?portableInvoiceDetail.safeParse({...query,id:invoiceId}):portableInvoiceList.safeParse(query);
  if(!input.success||'download' in input.data)notFound();
  const user=await requireChatGPTUser(invoiceId?page+'&invoiceId='+encodeURIComponent(invoiceId):page);
  if(portableWorkspaceGuest(user.email))notFound();
  const db=portableDb(),value=input.data;
  const draft='id' in value?await readPortableInvoice(db,user.userId,value.id,value.before,value.paymentsBefore):undefined;
  if(invoiceId&&!draft)notFound();
  const dealArchived=draft?.invoice.dealId?await isPortableDealArchived(db,user.userId,draft.invoice.dealId):false;
  const list='id' in value?undefined:await listPortableInvoices(db,user.userId,value);
  const params=new URLSearchParams();
  if('dealId' in value&&value.dealId)params.set('dealId',value.dealId);
  if('quoteId' in value&&value.quoteId)params.set('quoteId',value.quoteId);
  if('q' in value&&value.q)params.set('q',value.q);
  if('status' in value&&value.status&&value.status!=='all')params.set('status',value.status);
  if('dueFrom' in value&&value.dueFrom)params.set('dueFrom',value.dueFrom);
  if('dueThrough' in value&&value.dueThrough)params.set('dueThrough',value.dueThrough);
  const exportParams=new URLSearchParams(params);
  exportParams.set('export','csv');
  if(list?.next)params.set('after',list.next);
  return withPortableNavigation(user.email,<main className="portable-contacts">
    <PortableCrmHeader email={user.email} page="invoices" currentHref={page}/>
    {draft?<PortableInvoiceDetailView key={draft.invoice.id} detail={draft} dealArchived={dealArchived} before={'before' in value?value.before:undefined} paymentsBefore={'paymentsBefore' in value?value.paymentsBefore:undefined}/>:<section>
      <div className="portable-contacts-heading"><h1>Invoices</h1><Link href="/?kind=deals">Choose a deal</Link></div>
      <p>Create a private draft from a deal or a current published quote.</p>
      <form action="/" method="get">
        <input type="hidden" name="view" value="invoices"/>
        {params.get('dealId')&&<input type="hidden" name="dealId" value={params.get('dealId')??''}/>}
        {params.get('quoteId')&&<input type="hidden" name="quoteId" value={params.get('quoteId')??''}/>}
        <label>Search title, buyer or reference <input type="search" name="q" defaultValue={params.get('q')??''} maxLength={200}/></label>
        <label>Status <select name="status" defaultValue={params.get('status')??'all'}>
          <option value="all">All statuses</option>
          {portableInvoiceStatuses.map(status=><option key={status} value={status}>{invoiceStatusLabels[status]}</option>)}
        </select></label>
        <label>Due date from <input type="date" name="dueFrom" defaultValue={params.get('dueFrom')??''}/></label>
        <label>Due date through <input type="date" name="dueThrough" defaultValue={params.get('dueThrough')??''}/></label>
        <button>Search invoices</button>
      </form>
      <PortableInvoiceExportButton href={'/api/invoices?'+exportParams}/>
      {list?.items.length?<div className="portable-contacts-table">
        <table><thead><tr><th>Invoice</th><th>Status</th><th>Buyer</th><th>Due (UTC)</th><th>Total</th><th>Balance due</th></tr></thead>
          <tbody>{list.items.map(item=><tr key={item.id}>
            <td><Link href={page+'&invoiceId='+item.id}>{item.title}</Link></td><td>{invoiceStatusLabels[item.status]}{item.number!==null?' · '+invoiceLabel(item):''}</td><td>{item.buyer||'—'}</td>
            <td>{item.dueOn}</td><td>{formatCents(item.totalCents)} USD</td>
            <td>{item.status==='draft'?'—':formatCents(invoiceBalance(item))+' USD'}</td>
          </tr>)}</tbody></table>
      </div>:<p>No matching invoices.</p>}
      {list?.next&&<Link href={page+'&'+params}>Next invoices</Link>}
    </section>}
  </main>);
}
