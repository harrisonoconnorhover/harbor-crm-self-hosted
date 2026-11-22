import {readCommerceResult,type RecordAccessActor} from './record-access-store';
import {matchesCommerceSearch,invoiceSearchFields} from './commerce-search';
import {and,asc,desc,eq,gt,gte,lt,lte,max,sql} from 'drizzle-orm';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import {ApiError} from '../../lib/api-error';
import {lineItemTotals} from '../../lib/commerce';
import {invoiceData,invoiceSnapshot,validateInvoiceIssue,type Invoice} from '../../lib/invoices';
import {portableInvoiceExportLimit,portableInvoiceState,type PortableInvoiceDetail,type PortableInvoiceList,type PortableInvoicePage,type PortableInvoiceWrite} from '../../lib/portable-invoices';
import {independentLines,utcToday} from '../../lib/quotes';
import {loginIdentities} from './identity-schema';
import {readPortableInvoicePayments,writePortableInvoicePayment} from './portable-invoice-payment-store';
import {portableInvoiceEvents as events,portableInvoices as invoices} from './portable-invoice-schema';
import {invoiceSourceMaterial,type InvoiceActor} from './portable-invoice-source-store';
import {lockRecordWorkspace} from './private-workspace-store';
import {privateWorkspaces as workspaces} from './workspace-schema';

const size=25;
const tenant=eq(invoices.workspaceId,workspaces.id);
const fields={id:invoices.id,dealId:invoices.dealId,dealCreatedAt:invoices.dealCreatedAt,dealName:invoices.dealName,
  quoteId:invoices.quoteId,quoteVersion:invoices.quoteVersion,sourceNote:invoices.sourceNote,revision:invoices.revision,
  data:invoices.data,totalCents:invoices.totalCents,createdAt:invoices.createdAt,updatedAt:invoices.updatedAt,
  number:invoices.number,snapshot:invoices.snapshot,finalizedAt:invoices.finalizedAt,paidCents:invoices.paidCents,voidReason:invoices.voidReason};

function matchingInvoices(db:PostgresJsDatabase,actorId:string,input:PortableInvoiceList,limit:number){
  const title=sql<string>`${invoices.data}->>'title'`,buyer=sql<string>`${invoices.data}->'buyer'->>'name'`;
  const dueOn=sql<string>`${invoices.data}->>'dueOn'`,paid=sql`coalesce(${invoices.paidCents},0)`;
  const datedDueOn=sql<string | null>`nullif(${dueOn},'')`;
  const today=utcToday();
  // Match invoiceStatus and reuse this expression for filtering and the displayed state.
  const status=sql<PortableInvoicePage['items'][number]['status']>`case
    when ${invoices.voidReason} is not null then 'void'
    when ${invoices.finalizedAt} is null then 'draft'
    when ${paid}=${invoices.totalCents} then 'paid'
    when ${dueOn}<${today} then 'overdue'
    when ${paid}>0 then 'partially_paid'
    else 'open'
  end`;
  return db.select({id:invoices.id,title,buyer,totalCents:invoices.totalCents,dueOn,status:status.as('display_status'),
    number:invoices.number,paidCents:invoices.paidCents,issuedOn:sql<string>`${invoices.data}->>'issuedOn'`,
    reference:sql<string>`${invoices.data}->>'reference'`,dealId:invoices.dealId,quoteId:invoices.quoteId})
    .from(invoices).innerJoin(workspaces,tenant).where(and(eq(workspaces.ownerId,actorId),
      input.dealId?eq(invoices.dealId,input.dealId):undefined,input.quoteId?eq(invoices.quoteId,input.quoteId):undefined,
      input.status&&input.status!=='all'?sql`${status}=${input.status}`:undefined,
      input.dueFrom?gte(datedDueOn,input.dueFrom):undefined,input.dueThrough?lte(datedDueOn,input.dueThrough):undefined,
      input.after?gt(invoices.id,input.after):undefined,matchesCommerceSearch(invoiceSearchFields(invoices.data),input.q)))
    .orderBy(asc(invoices.id)).limit(limit);
}

export async function listPortableInvoices(db:PostgresJsDatabase,actor:RecordAccessActor,includeBody:boolean,input:PortableInvoiceList):Promise<PortableInvoicePage>{
  return readCommerceResult(db,actor,'invoices',includeBody&&'list',async tx=>{
    const rows=await matchingInvoices(tx,actor.userId,input,size+1);
    const items=rows.slice(0,size).map(({id,title,buyer,totalCents,dueOn,status,number,paidCents}):PortableInvoicePage['items'][number]=>({
      id,title,buyer,totalCents,dueOn,status,number,paidCents:paidCents??0,
    }));
    return {items,next:rows.length>size?items.at(-1)!.id:null};
  },result=>result.items.map(item=>item.id));
}

export async function listPortableInvoicesForExport(db:PostgresJsDatabase,actorId:string,filters:Omit<PortableInvoiceList,'after'>){
  const rows=await matchingInvoices(db,actorId,filters,portableInvoiceExportLimit+1);
  return rows.length>portableInvoiceExportLimit?null:rows;
}

export async function merchantInvoice(db:PostgresJsDatabase,actorId:string,workspaceId:string,id:string){
  const [row]=await db.select({id:invoices.id,revision:invoices.revision,totalCents:invoices.totalCents,paidCents:invoices.paidCents,
    buyerEmail:sql<string>`${invoices.data}->'buyer'->>'email'`,finalizedAt:invoices.finalizedAt,voidReason:invoices.voidReason})
    .from(invoices).innerJoin(workspaces,tenant)
    .where(and(eq(workspaces.ownerId,actorId),eq(invoices.workspaceId,workspaceId),eq(invoices.id,id)));
  return row;
}

export function readPortableInvoice(db:PostgresJsDatabase,actor:RecordAccessActor,includeBody:boolean,id:string,before?:number,paymentsBefore?:number):Promise<PortableInvoiceDetail|null>{
  return readCommerceResult(db,actor,'invoices',includeBody&&'detail',async tx=>{
    const [row]=await tx.select({draft:fields,workspaceId:invoices.workspaceId}).from(invoices).innerJoin(workspaces,tenant)
      .where(and(eq(workspaces.ownerId,actor.userId),eq(invoices.id,id)));
    if(!row)return null;
    const invoice:Invoice={...row.draft,status:portableInvoiceState(row.draft.finalizedAt,row.draft.voidReason),paidCents:row.draft.paidCents??0};
    const history=await tx.select({revision:events.revision,action:events.action,at:events.at,note:events.note,actorName:loginIdentities.fullName})
      .from(events).innerJoin(loginIdentities,eq(events.actorId,loginIdentities.id))
      .where(and(eq(events.workspaceId,row.workspaceId),eq(events.invoiceId,id),before?lt(events.revision,before):undefined))
      .orderBy(desc(events.revision)).limit(size+1);
    const payments=await readPortableInvoicePayments(tx,row.workspaceId,id,size,paymentsBefore);
    return {invoice,history:history.slice(0,size),next:history.length>size?history[size-1].revision:null,
      payments:payments.items,nextPayment:payments.next};
  },result=>result?[result.invoice.id]:[]);
}

export function writePortableInvoice(db:PostgresJsDatabase,actor:InvoiceActor,input:PortableInvoiceWrite){
  return db.transaction(async tx=>{
    const workspaceId=await lockRecordWorkspace(tx,actor.userId,false,undefined,undefined,true);
    if(!workspaceId)return 'missing';
    const scope=and(eq(invoices.workspaceId,workspaceId),eq(invoices.id,input.id));
    const [current]=await tx.select({revision:invoices.revision,creationKey:invoices.creationKey,
      finalizedAt:invoices.finalizedAt,data:invoices.data,totalCents:invoices.totalCents,paidCents:invoices.paidCents,voidReason:invoices.voidReason})
      .from(invoices).where(scope).for('update');
    const at=new Date().toISOString();
    let revision=1;
    if(input.action==='create'){
      const creationKey=JSON.stringify(input);
      if(current)return current.creationKey===creationKey?'ok':'stale';
      const {preview,links}=await invoiceSourceMaterial(tx,workspaceId,actor,{
        source:input.source.type,sourceId:input.source.id,recurring:input.recurring,
      },true);
      if(JSON.stringify(preview.source)!==JSON.stringify(input.source))return 'stale';
      await tx.insert(invoices).values({workspaceId,id:input.id,...links,data:preview.data,sourceNote:preview.sourceNote,
        totalCents:preview.totalCents,revision,creationKey,createdAt:at,updatedAt:at});
    }else{
      if(!current)return 'missing';
      if(input.action==='payment'||input.action==='unapply')return await writePortableInvoicePayment(tx,workspaceId,actor.userId,current,input,at);
      if(current.revision!==input.revision||current.revision>=2147483647){
        const replay=(input.action==='finalize'&&current.finalizedAt)||(input.action==='void'&&current.voidReason===input.reason);
        if(replay&&current.revision===input.revision+1){
          const [receipt]=await tx.select({action:events.action}).from(events).where(and(eq(events.workspaceId,workspaceId),
            eq(events.invoiceId,input.id),eq(events.revision,current.revision)));
          if(receipt?.action===input.action)return 'ok';
        }
        return 'stale';
      }
      if(current.voidReason!==null)throw new ApiError(409,'Voided invoices cannot change.');
      if(input.action!=='void'&&current.finalizedAt)throw new ApiError(409,'Only draft invoices can be edited or finalized.');
      revision=current.revision+1;
      if(input.action==='void'){
        if((current.paidCents??0)>0)throw new ApiError(409,'An invoice with applied payments cannot be voided.');
        await tx.update(invoices).set({voidReason:input.reason,revision,updatedAt:at}).where(scope);
      }else if(input.action==='save'){
        const data={...input.data,items:independentLines(input.data.items)};
        await tx.update(invoices).set({data,totalCents:lineItemTotals(data.items).netCents,revision,updatedAt:at}).where(scope);
      }else{
        const parsed=invoiceData.safeParse(current.data);
        if(!parsed.success)throw new ApiError(400,parsed.error.issues[0]?.message??'Check the invoice draft.');
        try{validateInvoiceIssue(parsed.data,at.slice(0,10));}
        catch(error){throw new ApiError(400,(error as Error).message);}
        const snapshot=invoiceSnapshot(parsed.data);
        const [counter]=await tx.select({last:max(invoices.number)}).from(invoices).where(eq(invoices.workspaceId,workspaceId));
        const number=(counter.last??0)+1;
        if(number>2147483647)throw new ApiError(409,'This workspace has reached its invoice number limit.');
        await tx.update(invoices).set({number,snapshot,totalCents:snapshot.totals.netCents,revision,
          updatedAt:at,finalizedAt:at}).where(scope);
      }
    }
    await tx.insert(events).values({workspaceId,invoiceId:input.id,revision,actorId:actor.userId,action:input.action,
      note:input.action==='void'?input.reason:null,at});
    return 'ok';
  });
}
