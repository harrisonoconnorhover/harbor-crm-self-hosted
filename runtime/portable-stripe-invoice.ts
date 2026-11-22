import Stripe from 'stripe';
import {z} from 'zod';
import {ApiError} from '../lib/api-error';

export type StripeInvoiceSummary={mode:'test'|'live';status:string;paid:number;remaining:number;page:string|null};

export function stripeInvoiceConfig(){
  const workspaceId=process.env.HARBOR_STRIPE_INVOICE_WORKSPACE_ID;
  const key=process.env.HARBOR_STRIPE_INVOICE_READ_KEY;
  const mode=process.env.HARBOR_STRIPE_INVOICE_MODE;
  if(!z.string().guid().safeParse(workspaceId).success||!workspaceId||!key||
    (mode!=='test'&&mode!=='live')||!key.startsWith('rk_'+mode+'_'))return null;
  return {workspaceId,key,mode} as const;
}

export async function checkStripeInvoice(config:NonNullable<ReturnType<typeof stripeInvoiceConfig>>,
  invoice:{id:string;totalCents:number;paidCents:number|null;buyerEmail:string}):Promise<StripeInvoiceSummary|null>{
  const stripe=new Stripe(config.key,{httpClient:Stripe.createFetchHttpClient(),maxNetworkRetries:0,timeout:5000});
  const query="metadata['harbor_workspace_id']:'"+config.workspaceId+"' AND metadata['harbor_invoice_id']:'"+invoice.id+"'";
  try{
    const matches=await stripe.invoices.search({query,limit:2});
    if(!matches.data.length&&!matches.has_more)return null;
    if(matches.has_more||matches.data.length!==1)throw new ApiError(409,'More than one Stripe invoice matches. Check the invoice metadata in Stripe.');
    // Search can lag behind changes. Re-read the exact invoice before exposing its customer page.
    const bill=await stripe.invoices.retrieve(matches.data[0].id);
    if(bill.metadata?.harbor_workspace_id!==config.workspaceId||bill.metadata?.harbor_invoice_id!==invoice.id||
      bill.livemode!==(config.mode==='live')||bill.currency!=='usd'||bill.total!==invoice.totalCents||
      (invoice.buyerEmail&&bill.customer_email?.toLowerCase()!==invoice.buyerEmail.toLowerCase()))
      throw new ApiError(409,'Stripe invoice details differ. Check the workspace, invoice, buyer, currency and total.');
    const status=bill.status;
    if(!status||!Number.isSafeInteger(bill.amount_remaining)||!Number.isSafeInteger(bill.amount_paid)||bill.amount_remaining<0||bill.amount_paid<0)
      throw new ApiError(502,'Stripe returned incomplete invoice details.');
    const link=bill.hosted_invoice_url?URL.parse(bill.hosted_invoice_url):null;
    const payable=status==='open'&&bill.amount_remaining>0&&bill.amount_remaining===invoice.totalCents-(invoice.paidCents??0);
    const page=(payable||(status==='paid'&&bill.amount_remaining===0))&&link?.origin==='https://invoice.stripe.com'&&!link.username&&!link.password?link.href:null;
    return {mode:config.mode,status,paid:bill.amount_paid,remaining:bill.amount_remaining,page};
  }catch(error){
    if(error instanceof ApiError)throw error;
    throw new ApiError(502,'Could not check Stripe. Verify the invoice-read key and try again.');
  }
}
