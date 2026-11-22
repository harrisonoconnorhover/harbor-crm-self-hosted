import {portablePageHasBody} from './portable-page-body';
import {withPortableNavigation} from './portable-navigation';
import {notFound} from 'next/navigation';
import {isPortableDealArchived} from '../db/postgres/portable-deal-archive-store';
import Link from 'next/link';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {listPortableQuotes,readPortableQuote} from '../db/postgres/portable-quote-store';
import {portableQuoteDisplayStatuses,portableQuoteQuery,portableQuoteStatusLabels} from '../lib/portable-quotes';
import {quoteLabel} from '../lib/quotes';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {PortableCsvExportButton} from './portable-csv-export-button';
import {PortableQuoteEditor} from './portable-quotes-ui';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

export default async function QuotesPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params={...await searchParams};
  if(params.id===undefined){
    if(params.expiresFrom==='')delete params.expiresFrom;
    if(params.expiresThrough==='')delete params.expiresThrough;
  }
  const query=portableQuoteQuery.safeParse(params);
  if(!query.success)notFound();
  const {id,dealId,q,status,expiresFrom,expiresThrough,before,version,versionBefore,download}=query.data;
  if(download)notFound();
  const next=new URLSearchParams();
  if(dealId)next.set('dealId',dealId);
  if(q)next.set('q',q);
  if(status)next.set('status',status);
  if(expiresFrom)next.set('expiresFrom',expiresFrom);
  if(expiresThrough)next.set('expiresThrough',expiresThrough);
  const exportParams=new URLSearchParams(next);
  exportParams.set('export','csv');
  const selected=new URLSearchParams();
  for(const [key,value] of Object.entries(query.data)){
    if(value!==undefined)selected.set(key,String(value));
  }
  const user=await requireChatGPTUser(selected.size?'/quotes?'+selected:'/quotes');
  if(portableWorkspaceGuest(user.email))notFound();
  const includeBody=await portablePageHasBody();
  const db=portableDb(),detail=id?await readPortableQuote(db,user,includeBody,id,query.data):undefined;
  if(id&&!detail)notFound();
  const dealArchived=detail?await isPortableDealArchived(db,user.userId,detail.quote.dealId):false;
  const page=detail?undefined:await listPortableQuotes(db,user,includeBody,query.data);
  if(page?.next)next.set('after',page.next);
  return withPortableNavigation(user.email,<main className="portable-contacts">
    <PortableCrmHeader email={user.email} page="quotes"/>
    {detail?<PortableQuoteEditor key={detail.quote.id} detail={detail} dealArchived={dealArchived} before={before} version={version} versionBefore={versionBefore}/>:<section>
      <div className="portable-contacts-heading"><h1>Quotes</h1><Link href="/?kind=deals">Choose a deal</Link></div>
      <p>Open a deal to create a draft from its line items.</p>
      <form action="/quotes" method="get">
        {dealId&&<input type="hidden" name="dealId" value={dealId}/>}
        <label>Search title, buyer or deal <input type="search" name="q" defaultValue={q} maxLength={200}/></label>
        <label>Status <select name="status" defaultValue={status??'all'}>
          <option value="all">All statuses</option>
          {portableQuoteDisplayStatuses.map(value=><option key={value} value={value}>{portableQuoteStatusLabels[value]}</option>)}
        </select></label>
        <label>Expiration date from <input type="date" name="expiresFrom" defaultValue={expiresFrom}/></label>
        <label>Expiration date through <input type="date" name="expiresThrough" defaultValue={expiresThrough}/></label>
        <button>Search quotes</button>
      </form>
      <PortableCsvExportButton filename="harbor-quotes.csv" href={'/api/quotes?'+exportParams}/>
      {page?.items.length?<div className="portable-contacts-table"><table><thead><tr><th>Quote</th><th>Status</th><th>Buyer</th><th>Deal</th><th>Expires (UTC)</th></tr></thead>
        <tbody>{page.items.map(item=><tr key={item.id}><td><a href={'/quotes?id='+item.id}>{item.title}</a></td>
          <td>{portableQuoteStatusLabels[item.status]}{item.number!==null?' · '+quoteLabel(item):''}</td><td>{item.buyer||'—'}</td><td>{item.dealName}</td><td>{item.expiresOn}</td></tr>)}</tbody></table></div>:<p>No matching quotes.</p>}
      {page?.next&&<a href={'/quotes?'+next}>Next quotes</a>}
    </section>}
  </main>);
}
