import {and,desc,eq,lt} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {formatCents} from '../../lib/commerce';
import {validatePayment} from '../../lib/invoices';
import {portableInvoiceState,type PortableInvoicePaymentWrite} from '../../lib/portable-invoices';
import {portableInvoiceEvents as events,portableInvoicePayments as payments,portableInvoices as invoices} from './portable-invoice-schema';

type Db=PostgresJsDatabase;
type InvoiceRow=Pick<typeof invoices.$inferSelect,'revision'|'data'|'totalCents'|'paidCents'|'finalizedAt'|'voidReason'>;
const paymentFields={id:payments.id,revision:payments.revision,data:payments.data,createdAt:payments.createdAt,
  unappliedAt:payments.unappliedAt,unapplyReason:payments.unapplyReason};

export async function readPortableInvoicePayments(db:Db,workspaceId:string,invoiceId:string,limit:number,before?:number){
  const rows=await db.select(paymentFields).from(payments).where(and(eq(payments.workspaceId,workspaceId),eq(payments.invoiceId,invoiceId),
    before===undefined?undefined:lt(payments.revision,before))).orderBy(desc(payments.revision)).limit(limit+1);
  const items=rows.slice(0,limit).map(({data,...row})=>({...row,...data}));
  return {items,next:rows.length>limit?items.at(-1)!.revision:null};
}

// The caller holds the owner-workspace and invoice row locks through this write.
export async function writePortableInvoicePayment(tx:Db,workspaceId:string,actorId:string,current:InvoiceRow,
  input:PortableInvoicePaymentWrite,at:string){
  const paymentScope=and(eq(payments.workspaceId,workspaceId),eq(payments.id,input.paymentId));
  const [prior]=await tx.select().from(payments).where(paymentScope);
  if(input.action==='payment'&&prior){
    if(prior.invoiceId!==input.id||prior.creationKey!==JSON.stringify(input.data))throw new ApiError(409,'This payment ID was used for a different entry.');
    return {applied:prior.unappliedAt===null};
  }
  if(input.action==='unapply'){
    if(!prior||prior.invoiceId!==input.id)throw new ApiError(404,'Payment not found.');
    if(prior.unappliedAt){
      if(prior.unapplyReason!==input.reason)throw new ApiError(409,'This payment was already unapplied with a different reason.');
      return {applied:false};
    }
  }
  if(current.revision!==input.revision||current.revision>=2147483647)throw new ApiError(409,'This invoice changed. Reload before saving.');

  const revision=current.revision+1,paidCents=current.paidCents??0;
  const status=portableInvoiceState(current.finalizedAt,current.voidReason);
  let note:string,newPaidCents:number;
  if(input.action==='payment'){
    try{validatePayment({...current,paidCents,status},input.data,at.slice(0,10));}
    catch(error){throw new ApiError(400,(error as Error).message);}
    await tx.insert(payments).values({workspaceId,id:input.paymentId,invoiceId:input.id,creationKey:JSON.stringify(input.data),
      data:input.data,revision,createdAt:at});
    newPaidCents=paidCents+input.data.amountCents;
    note=`Offline payment recorded: ${formatCents(input.data.amountCents)} USD · ${input.data.receivedOn}`;
  }else{
    if(status!=='open'||!prior||paidCents<prior.data.amountCents)throw new ApiError(409,'This payment cannot be unapplied.');
    await tx.update(payments).set({unappliedAt:at,unapplyReason:input.reason}).where(paymentScope);
    newPaidCents=paidCents-prior.data.amountCents;
    note=`Payment ${input.paymentId} unapplied: ${input.reason}`;
  }
  await tx.update(invoices).set({paidCents:newPaidCents,revision,updatedAt:at})
    .where(and(eq(invoices.workspaceId,workspaceId),eq(invoices.id,input.id)));
  await tx.insert(events).values({workspaceId,invoiceId:input.id,revision,actorId,action:input.action,note,at});
  return {applied:input.action==='payment'};
}
