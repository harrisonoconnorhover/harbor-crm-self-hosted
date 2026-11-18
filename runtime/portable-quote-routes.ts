import {listPortableQuotes,listPortableQuotesForExport,readPortableQuote,savePortableQuote} from '../db/postgres/portable-quote-store';
import {ApiError} from '../lib/api-error';
import {quoteHTML} from '../lib/quotes';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {portableQuoteExport,portableQuoteExportLimit,portableQuoteMutation,portableQuoteQuery,portableQuoteStatusLabels} from '../lib/portable-quotes';
import {exportCsvCell} from '../lib/shared-record-export';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

function quotesCsv(rows:NonNullable<Awaited<ReturnType<typeof listPortableQuotesForExport>>>){
  const row=(values:unknown[])=>values.map(value=>exportCsvCell(value)).join(',');
  const columns=['Quote ID','Quote number','Title','Status','Deal','Expires (UTC)','Published version'];
  return [row(columns),...rows.map(quote=>row([quote.id,quote.number,quote.title,portableQuoteStatusLabels[quote.status],
    quote.dealName,quote.expiresOn,quote.version]))].join('\r\n')+'\r\n';
}

async function quotes(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams,db=portableDb();
    if(request.method==='POST'){
      if(params.size)return json({error:'Invalid quote request.'},400);
      let body:unknown;
      try{
        const text=await readBoundedRequestText(request,600_000);
        if(text===null)return json({error:'Use at most 100 quote items with shorter descriptions.'},413);
        body=JSON.parse(text);
      }catch{return json({error:'Supply valid JSON.'},400);}
      const input=portableQuoteMutation.safeParse(body);
      if(!input.success)return json({error:'Check the quote fields.'},400);
      const result=await savePortableQuote(db,user,input.data);
      if(result==='stale')return json({error:'The quote or its source changed. Reload before saving.'},409);
      if(result==='missing')return json({error:'Quote or source deal not found.'},404);
      return json({ok:true,id:input.data.id});
    }
    if(params.size!==new Set(params.keys()).size)return json({error:'Invalid quote query.'},400);
    if(params.has('export')){
      const query=portableQuoteExport.safeParse(Object.fromEntries(params));
      if(!query.success)return json({error:'Choose quote list filters to export.'},400);
      const rows=await listPortableQuotesForExport(db,user.userId,query.data);
      if(rows===null)return json({error:`More than ${portableQuoteExportLimit} quotes match. Narrow your filters to export the full list.`},413);
      return new Response(request.method==='HEAD'?null:quotesCsv(rows),{headers:{
        'cache-control':'private, no-store','x-content-type-options':'nosniff',
        'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="harbor-quotes.csv"',
      }});
    }
    const query=portableQuoteQuery.safeParse(Object.fromEntries(params));
    if(!query.success)return json({error:'Invalid quote query.'},400);
    if(query.data.id){
      const detail=await readPortableQuote(db,user.userId,query.data.id,query.data);
      if(!detail)return json({error:'Quote or version not found.'},404);
      if(query.data.download){
        if(!detail.published||detail.quote.number===null)return json({error:'Publish the quote before downloading a version.'},400);
        const {quote,published}=detail;
        return new Response(quoteHTML(quote,published.snapshot,published.publishedAt,published.version),{headers:{
          'content-type':'text/html; charset=utf-8',
          'content-disposition':`attachment; filename="Harbor-Q-${quote.number}-v${published.version}.html"`,
          'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          'cache-control':'private, no-store','x-content-type-options':'nosniff',
        }});
      }
      return json(detail);
    }
    return json(await listPortableQuotes(db,user.userId,query.data));
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message},error.status);
    return json({error:'Could not save or load quotes.'},500);
  }
}

export {quotes as GET,quotes as HEAD,quotes as POST};
