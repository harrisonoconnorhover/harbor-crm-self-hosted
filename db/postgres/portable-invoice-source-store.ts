import {and,eq} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {lineItemTotals,lineTotals,type LineItem} from '../../lib/commerce';
import {blankInvoice,invoiceCharges,invoiceData,type InvoiceData} from '../../lib/invoices';
import type {PortableInvoicePreview,PortableInvoiceSource,PortableInvoiceSourceQuery} from '../../lib/portable-invoices';
import {portableQuoteStatus} from '../../lib/portable-quotes';
import {quoteStatus} from '../../lib/quotes';
import {companies} from './company-schema';
import {contacts} from './contact-schema';
import {activeContact} from './contact-visibility';
import {activeCompany} from './company-visibility';
import {activeDeal} from './deal-visibility';
import {deals} from './deal-schema';
import {portableLineItemSets as sets} from './portable-line-item-schema';
import {portableQuotes as quotes,portableQuoteVersions as versions} from './portable-quote-schema';
import {privateWorkspaces as workspaces} from './workspace-schema';

export type InvoiceActor={userId:string;displayName:string;email:string};
type SourceDetails={dealId:string;dealCreatedAt:string;dealName:string;quoteId:string|null;quoteVersion:number|null};
type Material={source:PortableInvoiceSource;links:SourceDetails;data:InvoiceData;items:LineItem[]};

async function dealMaterial(db:PostgresJsDatabase,workspaceId:string,id:string,data:InvoiceData,lockBuyer:boolean):Promise<Material>{
  const [deal]=await db.select().from(deals).where(and(eq(deals.workspaceId,workspaceId),eq(deals.id,id),activeDeal));
  if(!deal)throw new ApiError(404,'Deal not found.');
  const [set]=await db.select().from(sets).where(and(eq(sets.workspaceId,workspaceId),eq(sets.dealId,id)));
  const buyerContact=deal.primaryContactId?db.select({data:contacts.data,revision:contacts.revision}).from(contacts)
    .where(and(eq(contacts.workspaceId,workspaceId),eq(contacts.id,deal.primaryContactId),activeContact)):null;
  const [contact]=buyerContact?await (lockBuyer?buyerContact.for('share'):buyerContact):[];
  const buyerCompany=deal.companyId?db.select({data:companies.data,revision:companies.revision}).from(companies)
    .where(and(eq(companies.workspaceId,workspaceId),eq(companies.id,deal.companyId),activeCompany)):null;
  const [company]=buyerCompany?await (lockBuyer?buyerCompany.for('key share'):buyerCompany):[];
  const buyer:Record<string,unknown>=contact?.data??company?.data??{};
  return {
    source:{type:'deal',id,createdAt:deal.createdAt,updatedAt:deal.updatedAt,lineRevision:set?.revision??0,
      buyerRevision:contact?.revision??null,companyRevision:company?.revision??null},
    links:{dealId:deal.id,dealCreatedAt:deal.createdAt,dealName:deal.data.name,quoteId:null,quoteVersion:null},
    data:{...data,title:('Invoice · '+deal.data.name).slice(0,160),buyer:{
      name:(contact?.data.name??company?.data.name??'').slice(0,160),email:contact?.data.email??'',
      address:[company?.data.name,buyer.address,buyer.city,buyer.state,buyer.postalCode,buyer.country]
        .filter(value=>typeof value==='string'&&value).join('\n').slice(0,2000),
    }},
    items:set?.items??[],
  };
}

async function quoteMaterial(db:PostgresJsDatabase,workspaceId:string,id:string,data:InvoiceData):Promise<Material>{
  const [quote]=await db.select().from(quotes).where(and(eq(quotes.workspaceId,workspaceId),eq(quotes.id,id)));
  if(!quote)throw new ApiError(404,'Quote not found.');
  const [deal]=await db.select({id:deals.id}).from(deals).where(and(eq(deals.workspaceId,workspaceId),eq(deals.id,quote.dealId),activeDeal));
  if(!deal)throw new ApiError(409,'Restore this quote’s Deal before starting an invoice from it.');
  const status=portableQuoteStatus(quote.publishedAt,quote.disposition);
  if((status!=='published'&&status!=='accepted')||!quote.publishedAt||!quote.version){
    throw new ApiError(409,'Choose a current published or accepted quote.');
  }
  const [version]=await db.select({snapshot:versions.snapshot}).from(versions)
    .where(and(eq(versions.workspaceId,workspaceId),eq(versions.quoteId,id),eq(versions.version,quote.version)));
  if(!version)throw new ApiError(409,'Published quote version not found.');
  const {snapshot}=version,d=snapshot.data;
  if(quoteStatus({status,data:d})==='expired')throw new ApiError(409,'Choose a current published or accepted quote.');
  // JSONB can reorder object keys. Compare the persisted amounts, not their serialized order.
  const matches=snapshot.calcVersion===1&&snapshot.lineTotals.length===d.items.length&&d.items.every((item,index)=>{
    const calculated=lineTotals(item),frozen=snapshot.lineTotals[index];
    return calculated.grossCents===frozen.grossCents&&calculated.discountCents===frozen.discountCents&&calculated.netCents===frozen.netCents;
  });
  if(!matches)throw new ApiError(409,'This quote uses different pricing calculations. Review the original quote.');
  return {
    source:{type:'quote',id,revision:quote.revision,version:quote.version},
    links:{dealId:quote.dealId,dealCreatedAt:quote.dealCreatedAt,dealName:quote.dealName,quoteId:id,quoteVersion:quote.version},
    data:{...data,title:('Invoice · '+d.title).slice(0,160),seller:d.seller,buyer:d.buyer,comments:d.comments,terms:d.terms},
    items:d.items,
  };
}

export async function invoiceSourceMaterial(db:PostgresJsDatabase,workspaceId:string,actor:InvoiceActor,input:PortableInvoiceSourceQuery,lockBuyer=false){
  const draft=blankInvoice({name:actor.displayName.slice(0,160),email:actor.email,address:''});
  const material=input.source==='deal'?await dealMaterial(db,workspaceId,input.sourceId,draft,lockBuyer):
    await quoteMaterial(db,workspaceId,input.sourceId,draft);
  const recurringCount=material.items.filter(item=>item.billingFrequency!=='one_time').length;
  const sourceNote=input.recurring==='one_payment'?'Copied one charge per line, including one payment of each recurring item.':
    `Copied one-time charges only. Excluded ${recurringCount} recurring item(s).`;
  const parsed=invoiceData.safeParse({...material.data,items:invoiceCharges(material.items,input.recurring)});
  if(!parsed.success)throw new ApiError(400,parsed.error.issues[0]?.message??'Check the invoice source.');
  const preview:PortableInvoicePreview={data:parsed.data,source:material.source,sourceNote,recurringCount,
    totalCents:lineItemTotals(parsed.data.items).netCents};
  return {preview,links:material.links};
}

export function previewPortableInvoiceSource(db:PostgresJsDatabase,actor:InvoiceActor,input:PortableInvoiceSourceQuery){
  return db.transaction(async tx=>{
    const [workspace]=await tx.select({id:workspaces.id}).from(workspaces).where(eq(workspaces.ownerId,actor.userId));
    if(!workspace)throw new ApiError(404,input.source==='deal'?'Deal not found.':'Quote not found.');
    return (await invoiceSourceMaterial(tx,workspace.id,actor,input)).preview;
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
