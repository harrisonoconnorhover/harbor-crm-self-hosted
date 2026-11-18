import { z } from "zod";

// USD cents and percentage basis points keep arithmetic deterministic.
export const MAX_TOTAL_CENTS = 100_000_000_000_000;
const cents = z.number().int().min(0).max(1_000_000_000_000);
export const billingFrequencies = ["one_time","weekly","biweekly","monthly","quarterly","semiannual","annual","biennial","triennial"] as const;
export type BillingFrequency = typeof billingFrequencies[number];
export const billingLabels:Record<BillingFrequency,string> = {one_time:"One-time",weekly:"Weekly",biweekly:"Every two weeks",monthly:"Monthly",quarterly:"Quarterly",semiannual:"Every six months",annual:"Annually",biennial:"Every two years",triennial:"Every three years"};
export const amountMetrics = ["net","tcv","acv","arr","mrr"] as const;
export type AmountMetric = typeof amountMetrics[number];
export const amountLabels:Record<AmountMetric,string> = {net:"Sum of per-payment amounts",tcv:"Total contract value (TCV)",acv:"Annual contract value (ACV)",arr:"Annual recurring revenue (ARR)",mrr:"Monthly recurring revenue (MRR)"};
function validateBilling(v:{billingFrequency:BillingFrequency;termPayments:number|null},ctx:z.RefinementCtx){
 if(v.billingFrequency==="one_time"&&v.termPayments!==null)ctx.addIssue({code:"custom",path:["termPayments"],message:"One-time items cannot have recurring payments."});
}
const productFields = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().max(100).default(""),
  description: z.string().trim().max(4000).default(""),
  unitPriceCents: cents,
  billingFrequency:z.enum(billingFrequencies).default("one_time"),
  termPayments:z.number().int().min(1).max(1200).nullable().default(null),
}).strict();
export const productData=productFields.superRefine(validateBilling);
export const productMutation=z.discriminatedUnion("action",[
  z.object({action:z.literal("save"),id:z.string().guid("Invalid uuid"),revision:z.number().int().min(0),data:productData}).strict(),
  z.object({action:z.literal("archive"),id:z.string().guid("Invalid uuid"),revision:z.number().int().min(1),archived:z.boolean()}).strict(),
]);
export type ProductData = z.infer<typeof productData>;
export type Product = ProductData & {id:string;revision:number;archivedAt:string|null;createdAt:string;updatedAt:string};
export const lineItemInput = productFields.extend({
  id: z.string().guid("Invalid uuid"), productId: z.string().guid("Invalid uuid").nullable().default(null),
  productRevision:z.number().int().min(1).nullable().default(null),
  quantity: z.number().finite().min(0.001).max(1_000_000).refine(v=>Math.abs(v*1000-Math.round(v*1000))<0.000001,"Use at most three decimal places for quantity."),
  discountBps: z.number().int().min(0).max(10_000).default(0),
}).strict().superRefine(validateBilling);
export type LineItem = z.infer<typeof lineItemInput>;
export function lineTotals(item: LineItem) {
  const gross = (BigInt(item.unitPriceCents) * BigInt(Math.round(item.quantity*1000)) + BigInt(500)) / BigInt(1000);
  // Half up to the nearest cent, once per line after multiplying quantity.
  const discount = (gross * BigInt(item.discountBps) + BigInt(5000)) / BigInt(10000);
  const net = gross - discount;
  if (gross > BigInt(MAX_TOTAL_CENTS)) throw new Error("Line total exceeds the supported amount.");
  return {grossCents:Number(gross),discountCents:Number(discount),netCents:Number(net)};
}
export function lineItemTotals(items: LineItem[]) {
  let grossCents=0,discountCents=0,netCents=0;
  for(const item of items){const t=lineTotals(item);grossCents+=t.grossCents;discountCents+=t.discountCents;netCents+=t.netCents;}
  if(grossCents>MAX_TOTAL_CENTS)throw new Error("Line item total exceeds the supported deal amount.");
  return {grossCents,discountCents,netCents};
}
// 72 sub-cent units represent all supported monthly/annual fractions exactly.
// Aggregate before rounding: twelve $1/year lines have $1 MRR, not $0.96.
const annualFactors:Record<Exclude<BillingFrequency,"one_time">,[number,number]>={weekly:[52,1],biweekly:[26,1],monthly:[12,1],quarterly:[4,1],semiannual:[2,1],annual:[1,1],biennial:[1,2],triennial:[1,3]};
export function revenueTotals(items:LineItem[]){
 let oneTime=BigInt(0),mrr=BigInt(0),arr=BigInt(0),tcv=BigInt(0),assumedTerms=0;
 for(const item of items){
  const net=BigInt(lineTotals(item).netCents),frequency=item.billingFrequency??"one_time";
  if(frequency==="one_time"){oneTime+=net*BigInt(72);tcv+=net*BigInt(72);continue;}
  const [numerator,denominator]=annualFactors[frequency];
  const annual=net*BigInt(numerator)*BigInt(72/denominator);
  const contract=item.termPayments==null?(annual<net*BigInt(72)?net*BigInt(72):annual):net*BigInt(item.termPayments)*BigInt(72);
  if(item.termPayments==null)assumedTerms++;
  mrr+=net*BigInt(numerator)*BigInt(6/denominator);
  arr+=contract<annual?contract:annual;tcv+=contract;
 }
 const round=(value:bigint)=>{const cents=(value+BigInt(36))/BigInt(72);if(cents>BigInt(MAX_TOTAL_CENTS))throw new Error("Revenue total exceeds the supported deal amount.");return Number(cents);};
 return {oneTimeCents:round(oneTime),mrrCents:round(mrr),arrCents:round(arr),tcvCents:round(tcv),acvCents:round(oneTime+arr),assumedTerms};
}
export function amountFromLines(items:LineItem[],metric:AmountMetric){
 const totals=lineItemTotals(items),revenue=revenueTotals(items);
 return metric==="net"?totals.netCents:revenue[`${metric}Cents`];
}
export const lineSetInput = z.object({
  dealId:z.string().min(1).max(150), revision:z.number().int().min(0),
  expectedUpdatedAt:z.string().min(1), expectedAmount:z.number().finite().min(0),
  updateAmount:z.boolean(), amountMetric:z.enum(amountMetrics).optional(), items:z.array(lineItemInput).max(100),
}).strict().superRefine((v,ctx)=>{
  if(new Set(v.items.map(x=>x.id)).size!==v.items.length)ctx.addIssue({code:"custom",message:"Each line item must have a unique ID."});
  try{lineItemTotals(v.items);revenueTotals(v.items);}catch(e){ctx.addIssue({code:"custom",message:(e as Error).message});}
});
export type LineSet = {revision:number;amountMetric:AmountMetric;items:LineItem[];totals:ReturnType<typeof lineItemTotals>;revenue:ReturnType<typeof revenueTotals>;deal:{id:string;name:string;amount:number;updatedAt:string}};
export function formatCents(value:number){return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(value/100);}
export function decimalToUnits(value:string) {
  if(!/^\d+(\.\d{0,2})?$/.test(value.trim()))throw new Error("Use a non-negative number with at most two decimal places.");
  const [whole,fraction=""]=value.trim().split(".");
  const units=Number(whole)*100+Number(fraction.padEnd(2,"0"));
  if(!Number.isSafeInteger(units))throw new Error("Amount is too large.");
  return units;
}
