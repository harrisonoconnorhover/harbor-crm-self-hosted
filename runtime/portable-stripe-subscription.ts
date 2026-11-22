import Stripe from 'stripe';
import {z} from 'zod';
import {ApiError} from '../lib/api-error';
import {checkoutSessionsCursor,subscriberStatusLabels,type SubscriberPage} from '../lib/portable-products';
import type {BillingFrequency,Product} from '../lib/commerce';

const recurringIntervals={
  weekly:['week',1],biweekly:['week',2],monthly:['month',1],quarterly:['month',3],semiannual:['month',6],
  annual:['year',1],biennial:['year',2],triennial:['year',3],
} as const satisfies Record<Exclude<BillingFrequency,'one_time'>,readonly [string,number]>;

export function subscriptionCatalogConfig(){
  const workspaceId=process.env.HARBOR_STRIPE_SUBSCRIPTION_WORKSPACE_ID;
  const key=process.env.HARBOR_STRIPE_SUBSCRIPTION_READ_KEY,mode=process.env.HARBOR_STRIPE_SUBSCRIPTION_MODE;
  if(!workspaceId||!z.string().guid().safeParse(workspaceId).success||(mode!=='test'&&mode!=='live')||!key?.startsWith('rk_'+mode+'_'))return null;
  try{
    const links=JSON.parse(process.env.HARBOR_STRIPE_SUBSCRIPTION_LINKS??'{}') as Record<string,unknown>;
    if(!links||Array.isArray(links)||typeof links!=='object')return null;
    const configured=new Map<string,string>(),seen=new Set<string>(),duplicates=new Set<string>();
    for(const [id,link] of Object.entries(links)){
      if(typeof link!=='string'||!/^plink_[a-zA-Z0-9]+$/.test(link))continue;
      if(seen.has(link))duplicates.add(link);
      seen.add(link);
      if(z.string().guid().safeParse(id).success)configured.set(id.toLowerCase(),link);
    }
    return {workspaceId,key,mode,configured,duplicates,lookup:process.env.HARBOR_STRIPE_SUBSCRIBERS_ENABLED==='true'} as const;
  }catch{return null;}
}

export function subscriptionConfig(productId:string,catalog=subscriptionCatalogConfig()){
  const linkId=catalog?.configured.get(productId.toLowerCase());
  if(!catalog||!linkId)return null;
  return {workspaceId:catalog.workspaceId,key:catalog.key,mode:catalog.mode,linkId,
    subscribers:catalog.lookup&&!catalog.duplicates.has(linkId)};
}

export function subscriptionEligible(product:Product){
  return !product.archivedAt&&product.billingFrequency!=='one_time'&&product.termPayments===null&&product.unitPriceCents>0;
}

function knownStatus(value:string):value is keyof typeof subscriberStatusLabels{return Object.hasOwn(subscriberStatusLabels,value);}

export async function readSubscribers(config:NonNullable<ReturnType<typeof subscriptionConfig>>,after?:string):Promise<SubscriberPage>{
  if(!config.subscribers)throw new ApiError(404,'Subscriber lookup unavailable.');
  const stripe=new Stripe(config.key,{httpClient:Stripe.createFetchHttpClient(),maxNetworkRetries:0,timeout:5000});
  try{
    const page=await stripe.checkout.sessions.list({payment_link:config.linkId,status:'complete',limit:25,
      starting_after:after,expand:['data.subscription']});
    const live=config.mode==='live';
    if(page.data.length>25||page.has_more&&!page.data.length)throw Error();
    const items=page.data.map(session=>{
      const sub=session.subscription;
      if(!checkoutSessionsCursor.safeParse(session.id).success||session.payment_link!==config.linkId||session.livemode!==live||
        session.status!=='complete'||session.mode!=='subscription'||!sub||typeof sub==='string'||sub.object!=='subscription'||
        sub.livemode!==live||!knownStatus(sub.status))throw Error();
      return {subscriptionId:sub.id,email:session.customer_details?.email??null,status:sub.status,
        cancelAtPeriodEnd:sub.cancel_at_period_end,cancelAt:sub.cancel_at};
    });
    return {mode:config.mode,items,next:page.has_more?page.data[page.data.length-1].id:null};
  }catch{
    throw new ApiError(502,'Could not read subscribers from Stripe. Check the configured payment link and read access to Checkout Sessions and Subscriptions.');
  }
}

export async function checkSubscriptionLink(config:NonNullable<ReturnType<typeof subscriptionConfig>>,product:Product){
  if(product.billingFrequency==='one_time'||!subscriptionEligible(product))
    throw new ApiError(409,'Choose an active recurring product with a positive price and no fixed payment count.');
  const stripe=new Stripe(config.key,{httpClient:Stripe.createFetchHttpClient(),maxNetworkRetries:0,timeout:5000});
  try{
    const link=await stripe.paymentLinks.retrieve(config.linkId);
    const live=config.mode==='live',url=URL.parse(link.url);
    if(link.id!==config.linkId||!link.active||link.livemode!==live||url?.origin!=='https://buy.stripe.com'||url.username||url.password)
      throw new ApiError(409,'Check that the Stripe payment link is active and uses the configured mode and Stripe checkout domain.');
    if(link.payment_method_types?.length&&!link.payment_method_types.includes('card'))
      throw new ApiError(409,'Enable card payments on the Stripe subscription link.');
    const items=await stripe.paymentLinks.listLineItems(config.linkId,{limit:2});
    const item=items.data[0],price=item?.price;
    const [interval,count]=recurringIntervals[product.billingFrequency];
    if(items.has_more||items.data.length!==1||item.quantity!==1||item.currency!=='usd'||(link.currency&&link.currency!=='usd')||!price?.active||price.livemode!==live||
      price.currency!=='usd'||price.billing_scheme!=='per_unit'||price.transform_quantity||price.unit_amount!==product.unitPriceCents||
      String(price.unit_amount_decimal).replace(/\.0+$/,'')!==String(product.unitPriceCents)||price.recurring?.usage_type!=='licensed'||
      price.recurring.interval!==interval||price.recurring.interval_count!==count)
      throw new ApiError(409,'The Stripe checkout must contain one matching USD recurring price. Check its unit price and billing interval.');
    return {url:url.href,mode:config.mode};
  }catch(error){
    if(error instanceof ApiError)throw error;
    throw new ApiError(502,'Could not check Stripe. Verify the payment link and its read permissions.');
  }
}
