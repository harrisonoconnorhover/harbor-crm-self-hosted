'use client';

import {useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {billingFrequencies,billingLabels,decimalToUnits,formatCents,type Product} from '../lib/commerce';
import type {PortableProductPage,PortableProductQuery} from '../lib/portable-products';
import {PortableCrmHeader} from './portable-crm-header';
import './portable-contacts.css';

function productFilters({q,archived,billingFrequency}:PortableProductQuery){
  const params=new URLSearchParams();
  if(q)params.set('q',q);
  if(archived)params.set('archived',archived);
  if(billingFrequency)params.set('billingFrequency',billingFrequency);
  return params;
}

function productUrl(query:PortableProductQuery,{page=query.page,id,add}:{
  page?:number;id?:string;add?:boolean;
}={}){
  const params=productFilters(query);
  if(page!==undefined)params.set('page',String(page));
  if(id)params.set('id',id);
  if(add)params.set('add','1');
  return '/products'+(params.size?'?'+params:'');
}

export function PortableProducts({email,product,page,query}:{email:string;product?:Product;page?:PortableProductPage;query:PortableProductQuery}){
  const router=useRouter();
  const [requestId,setRequestId]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [frequency,setFrequency]=useState(product?.billingFrequency??'one_time');

  async function download(){
    setBusy(true);setError('');
    try{
      const filters=productFilters(query);
      filters.set('export','csv');
      const response=await fetch('/api/products?'+filters);
      if(!response.ok){
        const result=await response.json() as {error?:string};
        throw Error(result.error??'Could not export products.');
      }
      if(!response.headers.get('content-type')?.startsWith('text/csv'))throw Error('Expected a CSV download.');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url;
      link.download='harbor-products.csv';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }

  async function save(body:unknown){
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/products',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json() as {id?:string;error?:string};
      if(!response.ok||!result.id)throw Error(result.error??'Could not save the product.');
      if(product)router.refresh();
      else router.push(productUrl(query,{id:result.id}));
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }

  function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const text=(field:string)=>String(form.get(field)??'');
    let unitPriceCents:number;
    try{unitPriceCents=decimalToUnits(text('price'));}
    catch(e){setError((e as Error).message);return;}
    const id=product?.id??(requestId||crypto.randomUUID());
    setRequestId(id);
    const term=text('termPayments');
    void save({action:'save',id,revision:product?.revision??0,data:{
      name:text('name'),sku:text('sku'),description:text('description'),unitPriceCents,billingFrequency:frequency,
      termPayments:frequency==='one_time'||!term?null:Number(term),
    }});
  }

  return <main className="portable-contacts">
    <PortableCrmHeader email={email} page="products"/>
    <section aria-labelledby="portable-products-title">
      <div className="portable-contacts-heading"><h1 id="portable-products-title">{page?'Products':product?'Edit product':'Add product'}</h1>
        {page?<a href={productUrl(query,{add:true})}>Add product</a>:<a href={productUrl(query)}>Back to products</a>}
      </div>
      {page?<><form action="/products" method="get">
        <label>Search name or SKU <input type="search" name="q" defaultValue={query.q} maxLength={200}/></label>
        <label>Status <select name="archived" defaultValue={query.archived??'false'}><option value="false">Active</option><option value="true">Archived</option></select></label>
        <label>Billing frequency <select name="billingFrequency" defaultValue={query.billingFrequency??''}>
          <option value="">All frequencies</option>
          {billingFrequencies.map(value=><option key={value} value={value}>{billingLabels[value]}</option>)}
        </select></label>
        <button>Apply filters</button>
      </form>
      <button type="button" onClick={download} disabled={busy}>{busy?'Preparing CSV…':'Export CSV'}</button>
      {error&&<p role="alert">{error}</p>}
      <p>{page.total} products</p>
      <div className="portable-contacts-table"><table><thead><tr><th>Name</th><th>SKU</th><th>Price</th><th>Billing frequency</th></tr></thead>
        <tbody>{page.items.map(item=><tr key={item.id}><td><a href={productUrl(query,{id:item.id})}>{item.name}</a></td><td>{item.sku||'—'}</td>
          <td>{formatCents(item.unitPriceCents)}</td><td>{billingLabels[item.billingFrequency]}</td></tr>)}</tbody>
      </table></div>
      {page.page>0&&<a href={productUrl(query,{page:page.page-1})}>Previous products</a>}{' '}
      {(page.page+1)*page.size<page.total&&<a href={productUrl(query,{page:page.page+1})}>Next products</a>}
      </>:<>
        {product?.archivedAt&&<p>Archived product</p>}
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <label>Product name<input name="name" maxLength={160} required defaultValue={product?.name}/></label>
            <label>SKU<input name="sku" maxLength={100} defaultValue={product?.sku}/></label>
            <label>Price (USD)<input name="price" type="number" min="0" max="10000000000" step="0.01" required defaultValue={product===undefined?'':product.unitPriceCents/100}/></label>
            <label>Description<textarea name="description" maxLength={4000} defaultValue={product?.description}/></label>
            <label>Billing frequency<select value={frequency} onChange={event=>setFrequency(event.target.value as Product['billingFrequency'])}>
              {billingFrequencies.map(value=><option key={value} value={value}>{billingLabels[value]}</option>)}
            </select></label>
            {frequency!=='one_time'&&<label>Recurring payments<input name="termPayments" type="number" min="1" max="1200" defaultValue={product?.termPayments??''}/></label>}
          </fieldset>
          <button disabled={busy}>Save product</button>
        </form>
        {product&&<button type="button" disabled={busy} onClick={()=>{
          if(!product.archivedAt&&!window.confirm('Archive this product?'))return;
          void save({action:'archive',id:product.id,revision:product.revision,archived:!product.archivedAt});
        }}>{product.archivedAt?'Restore product':'Archive product'}</button>}
        {error&&<p role="alert">{error}</p>}
      </>}
    </section>
  </main>;
}
