import {z} from 'zod';
import {lineItemInput,lineTotals,lineItemTotals,billingLabels,MAX_TOTAL_CENTS,formatCents,type LineItem} from './commerce';
import {dateOnly,documentParty,utcToday} from './quotes';
export const invoiceData=z.object({
 title:z.string().trim().min(1).max(160),seller:documentParty,buyer:documentParty,
 issuedOn:dateOnly,dueOn:dateOnly,reference:z.string().trim().max(160),
 comments:z.string().max(8000),terms:z.string().max(12000),paymentInstructions:z.string().max(4000),
 items:z.array(lineItemInput.refine(i=>i.billingFrequency==='one_time'&&i.termPayments===null,'Invoice lines bill once. Use a subscription for recurring collection.')).max(100),
}).strict().superRefine((d,c)=>{
 if(d.dueOn<d.issuedOn)c.addIssue({code:'custom',message:'Due date cannot precede the invoice date.'});
 if(new Set(d.items.map(i=>i.id)).size!==d.items.length)c.addIssue({code:'custom',message:'Each invoice line needs a unique ID.'});
 try{lineItemTotals(d.items);}catch(e){c.addIssue({code:'custom',message:(e as Error).message});}
});
export type InvoiceData=z.infer<typeof invoiceData>;
export type InvoiceSnapshot={data:InvoiceData;totals:ReturnType<typeof lineItemTotals>;lineTotals:ReturnType<typeof lineTotals>[];calcVersion:1};
export type InvoiceState='draft'|'open'|'void';
export type Invoice={id:string;number:number|null;status:InvoiceState;revision:number;data:InvoiceData;snapshot:InvoiceSnapshot|null;totalCents:number;paidCents:number;dealId:string|null;dealCreatedAt:string|null;dealName:string;quoteId:string|null;quoteVersion:number|null;sourceNote:string;createdAt:string;updatedAt:string;finalizedAt:string|null;voidReason:string|null};
export const paymentMethods=['bank_transfer','check','cash','card','other'] as const;
export const paymentLabels:Record<typeof paymentMethods[number],string>={bank_transfer:'Bank transfer',check:'Check',cash:'Cash',card:'Card paid elsewhere',other:'Other'};
export const paymentData=z.object({amountCents:z.number().int().min(1).max(MAX_TOTAL_CENTS),receivedOn:dateOnly,method:z.enum(paymentMethods),reference:z.string().trim().max(200),note:z.string().trim().max(2000)}).strict();
export type PaymentData=z.infer<typeof paymentData>;
export type InvoicePayment=PaymentData & {id:string;revision:number;createdAt:string;unappliedAt:string|null;unapplyReason:string|null};
export const invoiceLabel=(i:Pick<Invoice,'number'>)=>i.number===null?'Draft':`INV-${String(i.number).padStart(4,'0')}`;
export function invoiceStatus(i:Pick<Invoice,'status'|'totalCents'|'paidCents'>&{data:Pick<InvoiceData,'dueOn'>},today=utcToday()){
 if(i.status!=='open')return i.status;
 if(i.paidCents===i.totalCents)return 'paid';
 if(i.data.dueOn<today)return 'overdue';
 return i.paidCents>0?'partially_paid':'open';
}
export const invoiceStatusLabels:Record<string,string>={draft:'Draft',open:'Open',paid:'Paid',overdue:'Overdue',partially_paid:'Partially paid',void:'Void'};
export const invoiceBalance=(i:Pick<Invoice,'totalCents'|'paidCents'>&{status:ReturnType<typeof invoiceStatus>})=>i.status==='void'?0:i.totalCents-i.paidCents;
export function invoiceSnapshot(d:InvoiceData):InvoiceSnapshot{return {data:d,totals:lineItemTotals(d.items),lineTotals:d.items.map(lineTotals),calcVersion:1};}
export function validateInvoiceIssue(d:InvoiceData,today=utcToday()){
 if(!d.seller.name||!d.buyer.name||!d.items.length)throw Error('Add a seller, buyer and at least one charge before finalizing.');
 if(d.issuedOn>today)throw Error('Invoice date cannot be in the future (UTC).');
 if(lineItemTotals(d.items).netCents<=0)throw Error('Invoice total must be greater than zero.');
}
export function validatePayment(i:Pick<Invoice,'status'|'totalCents'|'paidCents'|'data'>,p:PaymentData,today=utcToday()){
 if(i.status!=='open')throw Error('Only finalized, non-void invoices can receive payments.');
 if(p.amountCents>invoiceBalance(i))throw Error('Payment exceeds the remaining balance.');
 if(p.receivedOn<i.data.issuedOn||p.receivedOn>today)throw Error('Payment date must be on or after the invoice date and cannot be in the future (UTC).');
}
export function invoiceCharges(items:LineItem[],recurring:'exclude'|'one_payment'){
 return items.filter(i=>i.billingFrequency==='one_time'||recurring==='one_payment').map(i=>({...i,id:crypto.randomUUID(),productId:null,productRevision:null,billingFrequency:'one_time' as const,termPayments:null,description:i.billingFrequency==='one_time'?i.description:[i.description.slice(0,3700),`One payment of ${billingLabels[i.billingFrequency].toLowerCase()} pricing. Specify the service period for this invoice.`].filter(Boolean).join('\n')}));
}
export function blankInvoice(seller={name:'',email:'',address:''}):InvoiceData{return {title:'Invoice',seller,buyer:{name:'',email:'',address:''},issuedOn:utcToday(),dueOn:new Date(Date.now()+30*86400000).toISOString().slice(0,10),reference:'',comments:'',terms:'',paymentInstructions:'',items:[]};}
const escape=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function invoiceHTML(i:Invoice){
 if(!i.snapshot)throw Error('Finalize the invoice before downloading.');
 const s=i.snapshot,d=s.data,e=escape,party=(p:InvoiceData['buyer'])=>`<strong>${e(p.name)}</strong><p>${e(p.email)}</p><p class="text">${e(p.address)}</p>`;
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(invoiceLabel(i))} · ${e(d.title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;color:#243746;max-width:1000px;margin:40px auto;padding:0 28px}header{border-bottom:3px solid #006b70;padding-bottom:20px}h1{font-size:30px}h2{font-size:16px}.parties{display:flex;gap:60px;margin:24px 0}.parties section{flex:1}.text{white-space:pre-wrap;overflow-wrap:anywhere}.status{padding:12px;border:2px solid #607583;font-weight:700}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 8px;text-align:left;vertical-align:top;border-bottom:1px solid #dce3e8}th{background:#f3f6f8}small{display:block;color:#607583}.totals{text-align:right;margin:24px 0}.balance{font-size:23px}footer{font-size:12px;color:#607583;margin-top:30px;border-top:1px solid #dce3e8;padding-top:16px}@media print{@page{margin:12mm}body{margin:0;padding:0;font-size:10pt}thead{display:table-header-group}tr{break-inside:avoid}}</style></head><body><header><small>INVOICE · ${e(invoiceLabel(i))}</small><h1>${e(d.title)}</h1><p>Invoice date ${e(d.issuedOn)} · Due ${e(d.dueOn)} (UTC)</p>${d.reference?`<p>PO / reference: ${e(d.reference)}</p>`:''}</header><p class="status">${e(invoiceStatusLabels[invoiceStatus(i)]).toUpperCase()}${i.status==='void'?' — do not pay this invoice':''}</p><div class="parties"><section><h2>From</h2>${party(d.seller)}</section><section><h2>Bill to</h2>${party(d.buyer)}</section></div><p class="text">${e(d.comments)}</p><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Discount</th><th>Amount</th></tr></thead><tbody>${d.items.map((l,n)=>`<tr><td><strong>${e(l.name)}</strong><small>${e(l.sku)}</small><p class="text">${e(l.description)}</p></td><td>${e(l.quantity)}</td><td>${e(formatCents(l.unitPriceCents))}</td><td>${e(l.discountBps/100)}%</td><td>${e(formatCents(s.lineTotals[n].netCents))}</td></tr>`).join('')}</tbody></table><div class="totals"><p>Subtotal ${e(formatCents(s.totals.grossCents))}<br>Discounts ${e(formatCents(s.totals.discountCents))}</p><p>Invoice total <strong>${e(formatCents(s.totals.netCents))} USD</strong></p><p>Payments recorded ${e(formatCents(i.paidCents))}</p><p class="balance">Balance due <strong>${e(formatCents(invoiceBalance(i)))} USD</strong></p></div><p>Taxes are not included. Each line is billed once on this invoice.</p><h2>Payment instructions</h2><p class="text">${e(d.paymentInstructions)||'Contact the seller to arrange payment.'}</p><h2>Terms</h2><p class="text">${e(d.terms)||'No additional terms.'}</p><footer>Prepared with Harbor · Payments shown were recorded manually. Balance/status as of ${e(new Date().toISOString())}. Contact the seller for the latest balance.</footer></body></html>`;
}
