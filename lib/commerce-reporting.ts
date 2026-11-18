import {commerceCRMFields,commerceCRMNote,hasCommerceCRMContext} from './commerce-crm-context';
import {documentLineFields,documentLineNote} from './document-line-reporting';
import {productReportFields,lineReportFields} from './product-reporting';
import type {FilterField} from './filters';
import {invoiceStatusLabels,paymentLabels,paymentMethods} from './invoices';
export const commerceReportKinds=['invoices','payments','quotes','products','line_items','quote_lines','invoice_lines'] as const;
export type CommerceReportKind=typeof commerceReportKinds[number];
export const isCommerceReport=(kind:string):kind is CommerceReportKind=>commerceReportKinds.some(k=>k===kind);
export const quoteReportStatusLabels:Record<string,string>={draft:'Draft',published:'Published',accepted:'Accepted',declined:'Declined',voided:'Voided',expired:'Expired'};
export const commercePopulationLabels:Record<CommerceReportKind,{active:string;all:string}>={
 quote_lines:{active:'Lines on published quotes',all:'All quote lines, including drafts and voids'},
 invoice_lines:{active:'Lines on finalized, non-void invoices',all:'All invoice lines, including drafts and voids'},
 products:{active:'Active catalog products',all:'All catalog products, including archived'},
 line_items:{active:'Lines on open deals only',all:'All current deal line items'},
 invoices:{active:'Issued, non-void invoices',all:'All invoices, including drafts and voids'},
 payments:{active:'Applied payments only',all:'All payment entries, including unapplied'},
 quotes:{active:'Published quotes, including accepted, declined and expired',all:'All quotes, including drafts and voids'},
};
const money=(id:string,label:string):FilterField=>({id,label:label+' (USD)',type:'number'});
const status:FilterField={id:'status',label:'Invoice status',type:'select',options:Object.keys(invoiceStatusLabels),optionLabels:invoiceStatusLabels};
export const commerceReportFields:Record<CommerceReportKind,FilterField[]>={
 quote_lines:documentLineFields(true),invoice_lines:documentLineFields(false),
 products:productReportFields,line_items:lineReportFields,
 quotes:[{id:'title',label:'Quote title',type:'text'},{id:'quoteNumber',label:'Quote number',type:'text'},
 {id:'status',label:'Quote status',type:'select',options:Object.keys(quoteReportStatusLabels),optionLabels:quoteReportStatusLabels},
 {id:'buyerName',label:'Buyer name',type:'text'},{id:'dealName',label:'Source deal name (snapshot)',type:'text'},{id:'dealId',label:'Source deal ID',type:'text'},
 {id:'createdAt',label:'Quote created date',type:'date'},{id:'firstPublishedOn',label:'First publication date',type:'date'},{id:'publishedAt',label:'Latest publication date (retained after recall)',type:'date'},
 {id:'expiresOn',label:'Expiration date',type:'date'},{id:'acceptedOn',label:'Offline acceptance date',type:'date'},
 {id:'version',label:'Published version number',type:'number'},
 {id:'pricingState',label:'Reported pricing',type:'select',options:['Published snapshot','Draft excluded','Void excluded','Published snapshot missing']},
 money('tcvUsd','Quoted total contract value'),money('acceptedTcvUsd','Accepted total contract value'),
 money('oneTimeUsd','Quoted one-time amount'),money('mrrUsd','Quoted monthly recurring revenue'),money('arrUsd','Quoted annual recurring revenue'),money('acvUsd','Quoted annual contract value'),
 {id:'assumedTerms',label:'Lines with assumed contract terms',type:'number'},
 ],
 invoices:[{id:'title',label:'Invoice title',type:'text'},{id:'invoiceNumber',label:'Invoice number',type:'text'},status,
 {id:'buyerName',label:'Buyer name',type:'text'},{id:'reference',label:'PO / reference',type:'text'},
 {id:'issuedOn',label:'Invoice date',type:'date'},{id:'dueOn',label:'Due date',type:'date'},{id:'finalizedAt',label:'Finalized date',type:'date'},
 money('totalUsd','Document total'),money('invoicedUsd','Invoiced amount'),money('paidUsd','Applied payments'),money('balanceUsd','Outstanding balance'),
 {id:'daysPastDue',label:'Days past due',type:'number'},
 {id:'agingBucket',label:'Balance aging',type:'select',options:['Current','1–30 days','31–60 days','61–90 days','91+ days']},
 {id:'dealName',label:'Source deal name',type:'text'},{id:'sourceType',label:'Source',type:'select',options:['Quote','Deal','Blank']},
 ],
 payments:[{id:'receivedOn',label:'Payment received date',type:'date'},{id:'createdAt',label:'Payment recorded date',type:'date'},
 money('amountUsd','Recorded payment amount'),{id:'method',label:'Payment method',type:'select',options:paymentMethods,optionLabels:paymentLabels},
 {id:'applied',label:'Payment state',type:'select',options:['Applied','Unapplied']},{id:'unappliedAt',label:'Correction date',type:'date'},
 {id:'reference',label:'Payment reference',type:'text'},
 {id:'buyerName',label:'Buyer name',type:'text'},{id:'invoiceNumber',label:'Invoice number',type:'text'}, {...status,id:'invoiceStatus'},
 ],
};
for(const kind of commerceReportKinds)if(hasCommerceCRMContext(kind))commerceReportFields[kind]=[...commerceReportFields[kind],...commerceCRMFields];
export const commerceMoneyFields=new Set(['unitPriceUsd','grossUsd','discountUsd','netUsd','totalUsd','invoicedUsd','paidUsd','balanceUsd','amountUsd','tcvUsd','acceptedTcvUsd','oneTimeUsd','mrrUsd','arrUsd','acvUsd']);
function sourceReportNote(kind:CommerceReportKind,population?:'active'|'all'){
 if(kind==='quote_lines'||kind==='invoice_lines')return documentLineNote(kind==='quote_lines',population==='all');
 if(kind==='products')return (population==='all'?'All catalog products, including archived.':'Active catalog products only.')+' Catalog prices are per payment, not sales revenue. Changing the catalog does not reprice saved deal lines. Dates use UTC; prices use USD.';
 if(kind==='line_items')return (population==='active'?'Lines on open deals only.':'All current deal line items.')+' Each saved line counts once; quantity is a separate measure. Names, prices and terms come from the line, not the current catalog. Name groups can combine equal names or split renamed products; group by Source product ID for stable catalog identity with current catalog names. Catalog renames/archives update labels only; custom lines share one group and unavailable products keep separate IDs. Deal status, owner and dates reflect the current deal. Closed-won values are current deal estimates, not historical bookings or collected cash. Recurring sums use the saved term assumptions and round after aggregation; rounded groups may differ from the rounded total by a cent. Formulas and filters use unrounded USD. Dates use UTC.';
 if(kind==='quotes')return (population==='all'?'All quotes, including drafts and voids.':'Published quotes, including accepted, declined and expired; drafts and voids excluded.')+' Each quote counts once at its current status. Monetary measures use its latest published snapshot and are blank for drafts, recalled drafts, voids or missing snapshots. Accepted value uses only offline-accepted quotes. Multiple quotes for one deal count separately: quoted values are proposals, not unique booked revenue or cash collected. Recurring values follow the quote contract-term assumptions; see Lines with assumed contract terms. Recalling a quote removes its published value until it is republished. First publication stays fixed; latest publication moves on republish. Expiration is evaluated as of today in UTC. Current-state results are not historical status snapshots. Dates use UTC; money and formula inputs use USD.';
 return (kind==='invoices'?(population==='all'?'All invoices, including drafts and voids. Document total includes every selected document.':'Issued, non-void invoices only.')+' Invoiced amount, applied payments and outstanding balance exclude drafts and voids. Balances and aging reflect the current state, not a historical snapshot.':(population==='all'?'All recorded payment entries, including unapplied corrections. Totals include both states; filter Payment state to isolate them.':'Applied offline payments only; unapplied entries are excluded.')+' Received-date totals are as corrected: later unapply corrections change earlier periods. These are manual records, not processor-confirmed collections.')+' Dates use UTC; money and formula inputs use USD.';
}

export const commerceSourceLabel=(kind:string)=>kind==='line_items'?'deal line items':kind==='quote_lines'?'quote line items':kind==='invoice_lines'?'invoice line items':kind;

export function commerceReportNote(kind:CommerceReportKind,population?:'active'|'all'){
 return sourceReportNote(kind,population)+(hasCommerceCRMContext(kind)?commerceCRMNote:'');
}
