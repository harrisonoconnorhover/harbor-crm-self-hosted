import { z } from 'zod';
import { lineItemInput,lineItemTotals,lineTotals,revenueTotals,formatCents,billingLabels,type LineItem } from './commerce';
export const quoteStatuses=['draft','published','accepted','declined','voided'] as const;
export type QuoteStatus=typeof quoteStatuses[number];
export const dateOnly=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;},'Enter a valid date.');
export const documentParty=z.object({name:z.string().trim().max(160),email:z.union([z.literal(''),z.string().email().max(254)]),address:z.string().trim().max(2000)}).strict();
export const quoteData=z.object({title:z.string().trim().min(1).max(160),seller:documentParty,buyer:documentParty,expiresOn:dateOnly,comments:z.string().max(8000),terms:z.string().max(12000),items:z.array(lineItemInput).max(100)}).strict().superRefine((v,ctx)=>{
 if(new Set(v.items.map(i=>i.id)).size!==v.items.length)ctx.addIssue({code:'custom',message:'Each line item needs a unique ID.'});
 try{lineItemTotals(v.items);revenueTotals(v.items);}catch(e){ctx.addIssue({code:'custom',message:(e as Error).message});}
});
export type QuoteData=z.infer<typeof quoteData>;
export type QuoteSnapshot={data:QuoteData;totals:ReturnType<typeof lineItemTotals>;revenue:ReturnType<typeof revenueTotals>;lineTotals:ReturnType<typeof lineTotals>[];calcVersion:1};
export type Quote={id:string;dealId:string;dealCreatedAt:string;dealName:string;number:number|null;status:QuoteStatus;revision:number;version:number;data:QuoteData;createdAt:string;updatedAt:string;publishedAt:string|null;acceptance:{name:string;date:string;note:string;method?:'electronic'}|null};
export const utcToday=()=>new Date().toISOString().slice(0,10);
export const quoteLabel=(q:Pick<Quote,'number'|'version'>)=>q.number===null?'Draft':`Q-${String(q.number).padStart(4,'0')} · v${q.version}`;
export function quoteStatus(q:Pick<Quote,'status'|'data'>,today=utcToday()){return q.status==='published'&&q.data.expiresOn<today?'expired':q.status;}
export const transitions:Record<QuoteStatus,readonly string[]>={draft:['save','publish','void'],published:['recall','accept','decline','void'],declined:['recall','void'],accepted:[],voided:[]};
export function assertQuoteAction(q:Pick<Quote,'status'>,action:string){if(!transitions[q.status].includes(action))throw new Error(`Cannot ${action} a ${q.status} quote.`);}
export function validatePublication(data:QuoteData,today=utcToday()){
 if(!data.seller.name||!data.buyer.name||!data.items.length)throw new Error('Add a seller, buyer and at least one line item before publishing.');
 if(data.expiresOn<today)throw new Error('Expiration must be today or later (UTC).');
}
export function validateAcceptance(publishedAt:string,expiresOn:string,acceptedOn:string,today=utcToday()){
 dateOnly.parse(acceptedOn);
 if(acceptedOn<publishedAt.slice(0,10)||acceptedOn>expiresOn||acceptedOn>today)throw new Error('Acceptance date must be between publication and expiration, and cannot be in the future (UTC).');
}
export function snapshotQuote(data:QuoteData):QuoteSnapshot{return {data,totals:lineItemTotals(data.items),revenue:revenueTotals(data.items),lineTotals:data.items.map(lineTotals),calcVersion:1};}
export function independentLines(items:LineItem[]){return items.map(i=>({...i,productId:null,productRevision:null}));}
const escape=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function quoteDocumentNotice(status:string,currentVersion:number,version:number,acceptance?:Quote['acceptance']){
 if(version<currentVersion)return `SUPERSEDED — replaced by version ${currentVersion}`;
 if(status==='draft')return 'RECALLED — awaiting a revised published quote';
 if(status==='accepted')return `ACCEPTED${acceptance?` — ${acceptance.method==='electronic'?'signed electronically by':'recorded offline for'} ${acceptance.name} on ${acceptance.date} (UTC)`:''}`;
 if(status==='voided')return 'VOID — this quote is no longer valid';
 if(status==='declined')return 'DECLINED — this proposal was declined';
 if(status==='expired')return 'EXPIRED — contact the seller for an updated proposal';
 return 'PUBLISHED — pending acceptance';
}
export function quoteHTML(q:Pick<Quote,'number'|'version'|'status'> & {acceptance?:Quote['acceptance']},snapshot:QuoteSnapshot,publishedAt:string,version=q.version,footer?:string){
 const d=snapshot.data,e=escape,notice=quoteDocumentNotice(quoteStatus({status:q.status,data:d}),q.version,version,q.acceptance);
 const footerText=footer??`Pricing document only. ${q.acceptance?.method==='electronic'?'Payment is arranged with the seller.':'Arrange acceptance and payment directly with the seller.'} This exported version is a fixed snapshot; contact the seller to confirm it is still current.`;
 const partyHTML=(p:QuoteData['buyer'])=>`<strong>${e(p.name)}</strong><p>${e(p.email)}</p><p class="multiline">${e(p.address)}</p>`;
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(d.title)} · ${e(quoteLabel({...q,version}))}</title><style>body{font:15px/1.5 system-ui,sans-serif;color:#243746;margin:48px auto;padding:0 28px;max-width:1000px}h1{font-size:32px;margin:16px 0}header{border-bottom:3px solid #006b70;padding-bottom:24px}small,.muted{color:#526874}.parties{display:flex;gap:70px;margin:30px 0}.parties section{flex:1}h2{font-size:16px}table{border-collapse:collapse;width:100%;margin:24px 0}th,td{text-align:left;vertical-align:top;padding:12px 8px;border-bottom:1px solid #dce3e8}th{background:#f3f6f8}.multiline{white-space:pre-wrap;overflow-wrap:anywhere}.total{font-size:22px;text-align:right}footer{border-top:1px solid #dce3e8;margin-top:36px;padding-top:18px;font-size:12px}@media print{body{margin:12mm auto;padding:0}thead{display:table-header-group}tr{break-inside:avoid}}</style></head><body><header><small>QUOTE · ${e(quoteLabel({...q,version}))}</small><h1>${e(d.title)}</h1><p>Issued ${e(publishedAt.slice(0,10))} · Valid through ${e(d.expiresOn)} (UTC)</p></header><p style="padding:14px;border:2px solid #607583;font-weight:700">${e(notice)}</p><div class="parties"><section><h2>Prepared by</h2>${partyHTML(d.seller)}</section><section><h2>Prepared for</h2>${partyHTML(d.buyer)}</section></div><p class="multiline">${e(d.comments)}</p><table><thead><tr><th>Item</th><th>Quantity</th><th>Unit price</th><th>Discount</th><th>Billing</th><th>Per payment</th></tr></thead><tbody>${d.items.map((i,n)=>`<tr><td><strong>${e(i.name)}</strong><br><small>${e(i.sku)}</small><div class="multiline">${e(i.description)}</div></td><td>${e(i.quantity)}</td><td>${e(formatCents(i.unitPriceCents))}</td><td>${e(i.discountBps/100)}%</td><td>${e(billingLabels[i.billingFrequency])}${i.termPayments?`<br>${e(i.termPayments)} payments`:i.billingFrequency!=='one_time'?'<br>No fixed term':''}</td><td>${e(formatCents(snapshot.lineTotals[n].netCents))}</td></tr>`).join('')}</tbody></table><p class="total">Total contract value: <strong>${e(formatCents(snapshot.revenue.tcvCents))} USD</strong></p><p class="muted">Taxes are not included.${snapshot.revenue.assumedTerms?' For items without a fixed term, contract value assumes one year or one billing period, whichever is longer.':''} Recurring amounts follow the billing frequency shown above.</p><h2>Terms</h2><div class="multiline">${e(d.terms)||'No additional terms.'}</div><footer>Prepared with Harbor · ${e(footerText)}</footer></body></html>`;
}
