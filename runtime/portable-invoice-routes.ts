import {previewPortableInvoiceSource} from '../db/postgres/portable-invoice-source-store';
import {listPortableInvoices,listPortableInvoicesForExport,readPortableInvoice,writePortableInvoice} from '../db/postgres/portable-invoice-store';
import {ApiError} from '../lib/api-error';
import {invoiceHTML,invoiceLabel,invoiceStatusLabels} from '../lib/invoices';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableInvoiceExport,portableInvoiceExportLimit,portableInvoiceRead,portableInvoiceWrite} from '../lib/portable-invoices';
import {exportCsvCell} from '../lib/shared-record-export';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

function invoicesCsv(rows:NonNullable<Awaited<ReturnType<typeof listPortableInvoicesForExport>>>){
  const columns=['Invoice ID','Invoice number','Title','Status','Buyer','PO / Reference','Invoice date (UTC)','Due date (UTC)',
    'Currency','Invoice total','Applied payments','Balance due','Deal ID','Quote ID'];
  const text=(values:unknown[])=>values.map(value=>exportCsvCell(value));
  const money=(cents:number)=>exportCsvCell((cents/100).toFixed(2),true);
  const lines=rows.map(row=>{
    const paid=row.paidCents??0;
    const balance=row.status==='draft'?exportCsvCell(null):money(row.status==='void'?0:row.totalCents-paid);
    return [...text([row.id,row.number===null?null:invoiceLabel(row),row.title,invoiceStatusLabels[row.status],row.buyer,
      row.reference,row.issuedOn,row.dueOn,'USD']),money(row.totalCents),money(paid),balance,...text([row.dealId,row.quoteId])].join(',');
  });
  return [text(columns).join(','),...lines].join('\r\n')+'\r\n';
}

async function invoices(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='POST'){
      if(params.size)return json({error:'Invalid invoice request.'},400);
      const text=await readBoundedRequestText(request,600_000);
      if(text===null)return json({error:'Use at most 100 invoice lines with shorter descriptions.'},413);
      let body:unknown;
      try{body=JSON.parse(text);}catch{return json({error:'Supply valid JSON.'},400);}
      const input=portableInvoiceWrite.safeParse(body);
      if(!input.success)return json({error:'Check the invoice draft fields.'},400);
      const result=await writePortableInvoice(db,user,input.data);
      if(result==='stale')return json({error:'This invoice or its source changed. Reload before saving.'},409);
      if(result==='missing')return json({error:'Invoice or source not found.'},404);
      return json({ok:true,id:input.data.id,...(typeof result==='object'?result:{})});
    }
    if(params.size!==new Set(params.keys()).size)return json({error:'Invalid invoice query.'},400);
    if(params.has('export')){
      const query=portableInvoiceExport.safeParse(Object.fromEntries(params));
      if(!query.success)return json({error:'Choose invoice list filters to export.'},400);
      const rows=await listPortableInvoicesForExport(db,user.userId,query.data);
      if(rows===null)return json({error:`More than ${portableInvoiceExportLimit} invoices match. Narrow your filters to export the full list.`},413);
      return new Response(request.method==='HEAD'?null:invoicesCsv(rows),{headers:{
        'cache-control':'private, no-store','x-content-type-options':'nosniff',
        'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="harbor-invoices.csv"',
      }});
    }
    const query=portableInvoiceRead.safeParse(Object.fromEntries(params));
    if(!query.success)return json({error:'Invalid invoice query.'},400);
    if('source' in query.data)return json(await previewPortableInvoiceSource(db,user,query.data));
    if('id' in query.data){
      const result=await readPortableInvoice(db,user.userId,query.data.id,query.data.before,query.data.paymentsBefore);
      if(!result)return json({error:'Invoice not found.'},404);
      if(query.data.download){
        const {invoice}=result;
        if(!invoice.snapshot||invoice.number===null)return json({error:'Finalize the invoice before downloading.'},400);
        return new Response(invoiceHTML(invoice),{headers:{
          'content-type':'text/html; charset=utf-8',
          'content-disposition':`attachment; filename="Harbor-INV-${invoice.number}.html"`,
          'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          'cache-control':'private, no-store','x-content-type-options':'nosniff',
        }});
      }
      return json(result);
    }
    return json(await listPortableInvoices(db,user.userId,query.data));
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Could not load or save invoices.'},500);
  }
}

export {invoices as GET,invoices as POST};
