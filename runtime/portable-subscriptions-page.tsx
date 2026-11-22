import {WorkspaceNumber} from './portable-workspace-format';
import {notFound} from 'next/navigation';
import {requireChatGPTUser} from '../app/chatgpt-auth';
import {readOwnedWorkspaceId} from '../db/postgres/private-workspace-store';
import {listPortableProducts,readPortableProduct} from '../db/postgres/portable-product-store';
import {billingLabels,formatCents} from '../lib/commerce';
import {subscriptionPlansQuery} from '../lib/portable-products';
import {PortableCrmHeader} from './portable-crm-header';
import {portableDb} from './portable-db';
import {portableWorkspaceGuest} from './portable-identity';
import {withPortableNavigation} from './portable-navigation';
import {portablePageHasBody} from './portable-page-body';
import {ProductSubscribers,SubscriptionCheckout} from './portable-products-ui';
import {subscriptionCatalogConfig,subscriptionConfig,subscriptionEligible} from './portable-stripe-subscription';

export async function PortableSubscriptionsPage({input}:{input:Record<string,string|undefined>}){
  const parsed=subscriptionPlansQuery.safeParse(input);
  if(!parsed.success)notFound();
  const query=parsed.data;
  const {productId}=query;
  function href(id?:string,position:{before?:string;after?:string}=query){
    const params=new URLSearchParams({view:'subscriptions'});
    if(query.q)params.set('q',query.q);
    if(query.archived)params.set('archived',query.archived);
    if(position.after)params.set('after',position.after);
    if(position.before)params.set('before',position.before);
    if(id)params.set('productId',id);
    return '/?'+params;
  }
  const user=await requireChatGPTUser(href(productId));
  if(portableWorkspaceGuest(user.email))notFound();
  const db=portableDb(),includeBody=await portablePageHasBody();
  const configured=subscriptionCatalogConfig();
  const catalog=configured&&configured.workspaceId===await readOwnedWorkspaceId(db,user.userId)?configured:null;
  const mappedIds=[...(catalog?.configured.keys()??[])];
  const plan=productId?await readPortableProduct(db,user,includeBody,productId,undefined,mappedIds):null;
  const mapping=plan?subscriptionConfig(plan.id,catalog):null;
  if(productId&&!plan)notFound();
  const plans=plan?null:await listPortableProducts(db,user,includeBody,query,mappedIds);
  return withPortableNavigation(user.email,<main className="portable-contacts">
    <PortableCrmHeader email={user.email} page="subscriptions"/>
    <section><div className="portable-contacts-heading"><h1>{plan?plan.name:'Subscriptions'}</h1>
      {plan?<a href={href()}>Back to subscription plans</a>:<a href="/products">Product catalog</a>}</div>
      {plan?<><p>{billingLabels[plan.billingFrequency]} · <WorkspaceNumber kind="usd" value={plan.unitPriceCents/100}>{formatCents(plan.unitPriceCents)}</WorkspaceNumber> USD per unit{plan.archivedAt?' · Archived':''}</p>
        <a href={'/products?id='+plan.id}>Open product</a>
        {mapping&&subscriptionEligible(plan)&&<SubscriptionCheckout product={plan}/>}
        {mapping?.subscribers?<ProductSubscribers product={plan}/>:<p>{mapping?'Subscriber lookup is unavailable for this checkout link.':'No Stripe checkout link is configured for this plan.'}</p>}
      </>:plans&&<>
        <form method="get" action="/"><input type="hidden" name="view" value="subscriptions"/>
          <label>Search name or SKU <input type="search" name="q" maxLength={200} defaultValue={query.q}/></label>
          <label>Plan status <select name="archived" defaultValue={query.archived??'false'}>
            <option value="false">Active</option><option value="true">Archived</option></select></label>
          <button>Apply filters</button></form>
        {plans.items.length?<div className="portable-contacts-table"><table><thead><tr>
          <th>Plan</th><th>Billing frequency</th><th>Unit price</th><th>Subscribers</th></tr></thead>
          <tbody>{plans.items.map(row=><tr key={row.id}><td><a href={href(row.id)}>{row.name}</a></td>
            <td>{billingLabels[row.billingFrequency]}</td><td><WorkspaceNumber kind="usd" value={row.unitPriceCents/100}>{formatCents(row.unitPriceCents)}</WorkspaceNumber> USD</td>
            <td>{subscriptionConfig(row.id,catalog)?.subscribers?'Lookup enabled':catalog?.configured.has(row.id)?'Lookup unavailable':'No checkout link'}</td></tr>)}</tbody>
        </table></div>:<p>No matching subscription plans.</p>}
        {(plans.previous||plans.next)&&<nav aria-label="Subscription plan pages">
          {plans.previous&&<a href={href(undefined,{before:plans.previous})}>Previous plans</a>}{' '}
          {plans.next&&<a href={href(undefined,{after:plans.next})}>Next plans</a>}
        </nav>}
      </>}
    </section>
  </main>);
}
