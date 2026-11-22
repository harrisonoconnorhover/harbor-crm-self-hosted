/* eslint-disable @next/next/no-html-link-for-pages -- Document navigation records one access per opened page. */
import {WorkspaceNumber} from './portable-workspace-format';
import {portablePageHasBody} from './portable-page-body';
import {notFound} from 'next/navigation';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {listRecordedPayments} from '../db/postgres/portable-invoice-payment-store';
import {formatCents} from '../lib/commerce';
import {invoiceLabel,paymentLabels} from '../lib/invoices';
import {portablePaymentLedgerQuery} from '../lib/portable-invoices';
import {PortableCrmHeader} from './portable-crm-header';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {withPortableNavigation} from './portable-navigation';
import './portable-contacts.css';

export async function PortablePaymentsPage({input}:{input:Record<string,string|undefined>}){
  const parsed=portablePaymentLedgerQuery.safeParse(input);
  if(!parsed.success)notFound();
  const {status,beforeDate,beforeId}=parsed.data;
  const filters={view:'payments',...(status==='all'?{}:{status})};
  const path=(cursor?:{beforeDate:string;beforeId:string})=>'/?'+new URLSearchParams({...filters,...cursor});
  const user=await requireChatGPTUser(path(beforeDate&&beforeId?{beforeDate,beforeId}:undefined));
  if(portableWorkspaceGuest(user.email))notFound();
  const includeBody=await portablePageHasBody();
  const {items,next}=await listRecordedPayments(portableDb(),user,includeBody,parsed.data);
  return withPortableNavigation(user.email,<main className="portable-contacts">
    <PortableCrmHeader email={user.email} page="payments"/>
    <section><div className="portable-contacts-heading"><h1>Payments</h1><a href="/?view=invoices">Invoices</a></div>
      <p>Offline payments recorded on your invoices, newest received first. Open an invoice to review its payment history.</p>
      <form action="/" method="get">
        <input type="hidden" name="view" value="payments"/>
        <label>Payment status <select name="status" defaultValue={status}>
          <option value="all">All payments</option><option value="applied">Applied</option><option value="unapplied">Unapplied</option>
        </select></label><button>Apply</button>
      </form>
      {items.length?<div className="portable-contacts-table"><table><thead><tr>
        <th>Received</th><th>Invoice</th><th>Buyer</th><th>Amount</th><th>Method</th><th>Reference</th><th>Status</th>
      </tr></thead><tbody>{items.map(row=>{
        const destination=new URLSearchParams({view:'invoices',invoiceId:row.invoiceId});
        if(row.revision<2147483647)destination.set('paymentsBefore',String(row.revision+1));
        return <tr key={row.id}><td>{row.receivedOn}</td>
          <td><a href={'/?'+destination}>{invoiceLabel({number:row.invoiceNumber})}</a></td>
          <td>{row.buyer||'—'}</td><td><WorkspaceNumber kind="usd" value={row.amountCents/100}>{formatCents(row.amountCents)}</WorkspaceNumber> USD</td><td>{paymentLabels[row.method]}</td>
          <td>{row.reference||'—'}</td><td>{row.unappliedAt?'Unapplied':'Applied'}</td></tr>;
      })}</tbody></table></div>:<p>No matching recorded payments.</p>}
      {beforeId&&<a href={path()}>Latest payments</a>}{' '}
      {next&&<a href={path(next)}>Older payments</a>}
    </section>
  </main>);
}
