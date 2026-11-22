import {subscriptionConfig,checkSubscriptionLink,readSubscribers} from './portable-stripe-subscription';
import {ApiError} from '../lib/api-error';
import {readCommerceCsv} from '../db/postgres/record-access-store';
import {listPortableProducts,listPortableProductsForExport,readPortableProduct,savePortableProduct} from '../db/postgres/portable-product-store';
import {readBoundedRequestText} from '../lib/bounded-request-text';
import {billingLabels,productMutation,type Product} from '../lib/commerce';
import {portableProductExportLimit,productSubscriptionQuery,portableProductExportQuery,portableProductQuery} from '../lib/portable-products';
import {exportCsvCell} from '../lib/shared-record-export';
import {portableApiIdentity} from './portable-api-identity';
import {portableDb} from './portable-db';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});

function productsCsv(records:Product[]){
  const line=(values:unknown[])=>values.map(value=>exportCsvCell(value)).join(',');
  const columns=['Product ID','Name','SKU','Description','Unit price (USD)','Billing frequency','Recurring payments','Status'];
  return [line(columns),...records.map(product=>line([
    product.id,product.name,product.sku,product.description,(product.unitPriceCents/100).toFixed(2),
    billingLabels[product.billingFrequency],product.termPayments,product.archivedAt?'Archived':'Active',
  ]))].join('\r\n')+'\r\n';
}

async function products(request:Request){
  try{
    const user=await portableApiIdentity(request);
    if(user instanceof Response)return user;
    const params=new URL(request.url).searchParams;
    const db=portableDb();
    if(request.method==='POST'){
      if(params.size)return json({error:'Invalid product request.'},400);
      let body:unknown;
      try{
        const text=await readBoundedRequestText(request,24_576);
        if(text!==null)body=JSON.parse(text);
      }catch{}
      const input=productMutation.safeParse(body);
      if(!input.success)return json({error:input.error.issues[0]?.message||'Check the product fields.'},400);
      const result=await savePortableProduct(db,user.userId,input.data);
      if('error' in result)return result.error==='missing'?json({error:'Product not found.'},404):
        json({error:'This product changed. Reload before saving.'},409);
      return json(result);
    }
    if(params.size!==new Set(params.keys()).size)return json({error:'Invalid product query.'},400);
    if(params.get('view')==='subscription'||params.get('view')==='subscribers'){
      const query=productSubscriptionQuery.safeParse(Object.fromEntries(params));
      if(!query.success)return json({error:'Choose one product.'},400);
      const {id,revision,view,after}=query.data,config=subscriptionConfig(id);
      if(!config||view==='subscribers'&&!config.subscribers)return json({error:'Checkout unavailable.'},404);
      const record=await readPortableProduct(db,user,request.method!=='HEAD',id,config.workspaceId);
      if(!record)return json({error:'Checkout unavailable.'},404);
      if(record.revision!==revision)return json({error:'Reload the product before checking its price.'},409);
      const result=view==='subscribers'?await readSubscribers(config,after):await checkSubscriptionLink(config,record);
      const latest=await readPortableProduct(db,user,false,id,config.workspaceId);
      if(!latest)return json({error:'Checkout unavailable.'},404);
      if(latest.revision!==record.revision)return json({error:'The product changed. Reload it before sharing checkout.'},409);
      return json(result);
    }
    if(params.has('export')){
      const query=portableProductExportQuery.safeParse(Object.fromEntries(params));
      if(!query.success)return json({error:'Choose Products list filters to export.'},400);
      const records=await readCommerceCsv(db,user,'products',request.method,tx=>listPortableProductsForExport(tx,user.userId,query.data));
      if(records===null)return json({error:`More than ${portableProductExportLimit} products match. Narrow your filters to export the full list.`},413);
      return new Response(request.method==='HEAD'?null:productsCsv(records),{headers:{
        'cache-control':'private, no-store','x-content-type-options':'nosniff',
        'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="harbor-products.csv"',
      }});
    }
    const query=portableProductQuery.safeParse(Object.fromEntries(params));
    if(!query.success)return json({error:'Invalid product query.'},400);
    if(query.data.id){
      const record=await readPortableProduct(db,user,request.method!=='HEAD',query.data.id);
      return record?json(record):json({error:'Product not found.'},404);
    }
    return json(await listPortableProducts(db,user,request.method!=='HEAD',query.data));
  }catch(error){return error instanceof ApiError?json({error:error.message},error.status):json({error:'Could not save or load products.'},500);}
}

export {products as GET,products as POST};
