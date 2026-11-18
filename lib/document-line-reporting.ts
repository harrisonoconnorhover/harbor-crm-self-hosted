import type {FilterField} from './filters';
import {billingFrequencies,billingLabels} from './commerce';
const text=(id:string,label:string):FilterField=>({id,label,type:'text'});
const number=(id:string,label:string):FilterField=>({id,label,type:'number'});
const money=(id:string,label:string)=>number(id,label+' (USD)');
const date=(id:string,label:string):FilterField=>({id,label,type:'date'});
export function documentLineFields(quote:boolean):FilterField[]{return [
 text('name','Line item name (saved)'),text('sku','SKU (saved)'),text('lineId','Line ID (within document)'),text('lineKey','Document line key'),number('quantity','Quantity'),number('discountPercent','Discount (%)'),
 text('documentId',quote?'Quote ID':'Invoice ID'),text('documentNumber',quote?'Quote number':'Invoice number'),text('title',quote?'Quote title':'Invoice title'),text('buyerName','Buyer name (snapshot)'),text('dealId','Source deal ID'),text('dealName','Source deal name (snapshot)'),date('createdAt','Document created date'),
 {id:'pricingState',label:'Reported pricing',type:'select',options:['Frozen line snapshot','Draft excluded','Void excluded','Unsupported pricing version','Stored line totals missing','Snapshot mismatch']},
 money('unitPriceUsd','Frozen unit price'),money('grossUsd','Frozen gross amount'),money('discountUsd','Frozen discount'),money('netUsd',quote?'Quoted net per payment':'Invoiced net charge'),
 ...(quote?[
 {id:'status',label:'Quote status',type:'select',options:['draft','published','accepted','declined','expired','voided']} as FilterField,
 number('version','Published version (zero for draft)'),{id:'billingFrequency',label:'Billing frequency',type:'select',options:[...billingFrequencies],optionLabels:billingLabels} as FilterField,
 number('termPayments','Contract payments'),number('assumedTerms','Lines with assumed contract terms'),money('tcvUsd','Quoted total contract value'),money('acceptedTcvUsd','Accepted total contract value'),money('mrrUsd','Quoted monthly recurring revenue'),money('arrUsd','Quoted annual recurring revenue'),money('acvUsd','Quoted annual contract value'),money('oneTimeUsd','Quoted one-time amount'),
 date('publishedAt','Latest publication date (retained after recall)'),date('firstPublishedOn','First publication date'),date('acceptedOn','Offline acceptance date'),date('expiresOn','Expiration date')
 ]:[{id:'status',label:'Invoice status',type:'select',options:['draft','open','partially_paid','paid','overdue','void']} as FilterField,text('sourceNote','Invoice source note'),money('invoicedUsd','Invoiced line amount'),date('issuedOn','Invoice date'),date('dueOn','Due date'),date('finalizedAt','Finalized date')])
 ];}
export function documentLineNote(quote:boolean,all:boolean){return (quote?(all?'All current quote lines, including drafts and voids.':'Latest published quote lines, including accepted, declined and expired quotes.'):(all?'All invoice lines, including drafts and voids.':'Finalized, non-void invoice lines.'))+' Each line counts once; quantity is separate. Prices come from the frozen document; draft and void money is blank. Missing snapshots have no reportable lines; unsupported pricing, mismatched snapshots or missing stored line totals have blank money. Names/SKUs are saved labels, not catalog identities. Equal labels can combine different items. '+(quote?'Recall removes published values until republish. Old versions are not added. Alternative quotes count separately. Recurring sums round after aggregation and can differ by cents from sums of document-rounded totals. Contract assumptions remain as quoted. ':'Payments and outstanding balances are not allocated to individual lines. ')+'Current-state results are not historical bookings or collected cash. Dates use UTC; money and formulas use USD.';}
