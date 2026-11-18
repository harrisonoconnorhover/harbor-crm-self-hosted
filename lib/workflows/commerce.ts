import { lineItemTotals, revenueTotals, type LineItem } from '../commerce';
import { documentParty, independentLines, quoteData, type QuoteData } from '../quotes';
import { invoiceCharges, invoiceData, type InvoiceData } from '../invoices';
import type { CRMRecord } from '../crm';
import type { Step } from './model';

export type CommerceStep = Extract<Step, {type:'createQuoteDraft'|'createInvoiceDraft'}>;
export const isCommerceStep = (step: Step): step is CommerceStep => step.type==='createQuoteDraft'||step.type==='createInvoiceDraft';
export type CommerceContext = {runId:string; revision:number; items:LineItem[]; preview:boolean};
export type PlannedDocument = {
 id:string; type:CommerceStep['type']; stepId:string; data:QuoteData|InvoiceData;
 dealId:string; dealCreatedAt:string; dealName:string; lineRevision:number;
 totalCents:number; sourceNote:string;
};
export async function workflowDocumentId(runId:string,stepId:string,type:CommerceStep['type']) {
 const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([runId,stepId,type]))));
 bytes[6]=(bytes[6]&15)|80; bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function prepareWorkflowDocument(step:CommerceStep, record:CRMRecord, all:CRMRecord[], context:CommerceContext, now:Date, values:{title:unknown;sellerName:unknown;sellerEmail:unknown;sellerAddress:unknown}) {
 const seller=documentParty.parse({name:values.sellerName,email:values.sellerEmail,address:values.sellerAddress});
 if(!seller.name)throw Error('Enter a seller name for the draft.');
 const contact=all.find(r=>r.kind==='contacts'&&r.id===record.data.contactId);
 const company=all.find(r=>r.kind==='companies'&&r.id===record.data.companyId);
 const party=contact?.data??company?.data;
 const buyer=documentParty.parse({name:party?.name??'',email:contact?.data.email??'',address:[company?.data.name,party?.address,party?.city,party?.state,party?.postalCode,party?.country].filter(Boolean).join('\n')});
 const invoice=step.type==='createInvoiceDraft';
 const items=invoice?invoiceCharges(context.items,step.recurring):independentLines(context.items.map(i=>({...i,id:crypto.randomUUID()})));
 const excludedRecurring=context.items.length-items.length;
 if(!items.length){
  if(step.whenNoLines==='fail')throw Error('No eligible saved deal line items. Add charges or change the recurring-line choice.');
  return {document:null,outputs:{skipped:true,lineCount:0,excludedRecurring,preview:context.preview}};
 }
 if(typeof values.title!=='string')throw Error('Draft title must be text.');
 const title=values.title.trim()?values.title:`${invoice?'Invoice':'Quote'} · ${String(record.data.name)}`.slice(0,160);
 const date=new Date(now.getTime()+step.days*86400000).toISOString().slice(0,10);
 const common={title,seller,buyer,items,comments:'',terms:''};
 const data=invoice?invoiceData.parse({...common,issuedOn:now.toISOString().slice(0,10),dueOn:date,reference:'',paymentInstructions:''}):quoteData.parse({...common,expiresOn:date});
 const totalCents=invoice?lineItemTotals(items).netCents:revenueTotals(items).tcvCents;
 const id=await workflowDocumentId(context.runId,step.id,step.type);
 const sourceNote=invoice?(step.recurring==='one_payment'?'One payment of each source line; no recurring collection is scheduled.':`${excludedRecurring} recurring line(s) excluded.`):'Saved deal prices copied into an independent quote draft.';
 const document:PlannedDocument={id,type:step.type,stepId:step.id,data,dealId:record.id,dealCreatedAt:record.createdAt,dealName:String(record.data.name),lineRevision:context.revision,totalCents,sourceNote};
 return {document,outputs:{[invoice?'invoiceId':'quoteId']:id,prepared:true,preview:context.preview,lineCount:items.length,excludedRecurring,totalUsd:totalCents/100}};
}
